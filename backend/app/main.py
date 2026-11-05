"""openBatteryFlux API.

Serves the cell library from backend/data/cells.db and, when the frontend
folder sits next to it (that is how Docker builds the image), the static
frontend as well. In production the frontend can also live on its own host;
then only the /api/* endpoints are used.
"""
import hashlib
import json
import logging
import os
import sqlite3
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import accounts, db, mail

log = logging.getLogger("openbatteryflux.accounts")

app = FastAPI(
    title="openBatteryFlux API",
    version="1.0.0",
    description="Cell library for the openBatteryFlux battery simulator.",
)

origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_methods=["GET", "HEAD", "OPTIONS", "POST"],
    allow_headers=["*"],
)

DB_PROBLEMS = (FileNotFoundError, sqlite3.Error)
# The accounts database may be the local file or a hosted one (remote_db.py),
# and the hosted driver raises its own exception types.
ACCOUNT_PROBLEMS = accounts.STORAGE_ERRORS


def reply(payload: dict):
    # The database can change under us, so never let a CDN or the browser serve
    # a stale copy of the library.
    return JSONResponse(payload, headers={"Cache-Control": "no-cache"})


# The library is read-only for the life of a process: a redeploy ships a new
# cells.db and therefore a new process. Serialising it once (1.1 MB of JSON) and
# keeping the bytes, instead of re-reading 1308 rows on every request, is what
# makes /api/library and /api/health cheap after the first call in an instance.
_LIBRARY_CACHE: dict = {}

# Repeat visits reuse the library for five minutes and refresh in the background
# afterwards, so a redeploy is picked up on the next visit without re-sending a
# megabyte every time a page loads.  Only /api/library may be cached: everything
# under an account is answered with no-store (see secure()).
LIBRARY_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=86400"


def library_payload() -> dict:
    """The library JSON as bytes, its ETag and its sizes, built once."""
    if not _LIBRARY_CACHE:
        payload = db.library()
        if not payload["cells"]:
            raise HTTPException(status_code=503, detail="The cells table is empty.")
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False,
                          separators=(",", ":")).encode("utf-8")
        _LIBRARY_CACHE.update({
            "body": body,
            "etag": '"%s"' % hashlib.sha256(body).hexdigest()[:32],
            "cells": len(payload["cells"]),
            "chemistries": len(payload["chemistries"]),
        })
    return _LIBRARY_CACHE


@app.get("/api/health")
def health():
    """Cheap check used by Docker and by hosting platforms.

    `accounts` names the store the account endpoints would use — "hosted" when
    a hosted database is configured, "file" otherwise — so a deployment that
    lost its variables is visible here instead of in a failed sign-in. `mail`
    does the same for email: `ready` is true only when a sign-up link would
    actually reach a stranger, and `problems` names whatever is missing.
    """
    try:
        cached = library_payload()
    except DB_PROBLEMS as err:
        raise HTTPException(status_code=503, detail=str(err))
    return {"status": "ok", "cells": cached["cells"],
            "chemistries": cached["chemistries"],
            "accounts": accounts.store(), "mail": mail.status()}


@app.get("/api/library")
def library(request: Request):
    """Everything the frontend needs: chemistries and cells.

    Cached by the browser for five minutes and revalidated with an ETag after
    that, which turns a repeat page load from a 1.1 MB download into a 304 or
    nothing at all.
    """
    try:
        cached = library_payload()
    except DB_PROBLEMS as err:
        raise HTTPException(status_code=503, detail=str(err))
    headers = {"Cache-Control": LIBRARY_CACHE_CONTROL, "ETag": cached["etag"]}
    # Proxies may hand the validator back as a weak ETag (W/"..."), which still
    # means "I have this exact body".
    seen = (request.headers.get("if-none-match") or "").strip()
    if seen.startswith("W/"):
        seen = seen[2:]
    if seen == cached["etag"]:
        return Response(status_code=304, headers=headers)
    return Response(content=cached["body"], media_type="application/json",
                    headers=headers)


@app.get("/api/chemistries")
def chemistries():
    try:
        conn = db.connect()
    except DB_PROBLEMS as err:
        raise HTTPException(status_code=503, detail=str(err))
    try:
        return reply({"chemistries": db.chemistries(conn)})
    finally:
        conn.close()


@app.get("/api/cells")
def cells():
    try:
        conn = db.connect()
    except DB_PROBLEMS as err:
        raise HTTPException(status_code=503, detail=str(err))
    try:
        return reply({"cells": db.cells(conn)})
    finally:
        conn.close()


@app.get("/api/cells/popular")
def popular_cells(limit: int = 5):
    """The cells opened or used most often, for the picker's shortcut.

    Declared before /api/cells/{cell_id} so the path parameter does not swallow
    it. Only ids are returned: the counts are aggregate and carry no account,
    visitor id or timestamp.
    """
    conn = open_accounts()
    try:
        ids = accounts.popular_cells(conn, limit)
    finally:
        conn.close()
    return secure({"cells": ids})


@app.get("/api/cells/{cell_id}")
def cell(cell_id: str):
    try:
        conn = db.connect()
    except DB_PROBLEMS as err:
        raise HTTPException(status_code=503, detail=str(err))
    try:
        found = db.cells(conn, cell_id)
    finally:
        conn.close()
    if not found:
        raise HTTPException(status_code=404, detail="No cell with id '%s'." % cell_id)
    return reply(found[0])


# --------------------------------------------------------------------------
# Accounts, sessions and statistics
#
# The cell library stays read-only; users, sessions and events live in a
# separate writable SQLite file (see app/accounts.py). A session is a random
# token kept in the browser and sent back as "Authorization: Bearer <token>".
# --------------------------------------------------------------------------

class SignupIn(BaseModel):
    name: str = ""
    email: str
    password: str
    # Where the person works or studies (optional) and what they do there
    # (required by the form: "student", "engineer", ...).
    organisation: str = ""
    position: str = ""


class LoginIn(BaseModel):
    email: str
    password: str


class EventIn(BaseModel):
    kind: str
    detail: Optional[str] = None


class ActivityIn(BaseModel):
    kind: str
    tool: Optional[str] = None
    cell: Optional[str] = None
    visitor: Optional[str] = None


class TokenIn(BaseModel):
    token: str


class PasswordIn(BaseModel):
    current_password: str
    new_password: str


class NameIn(BaseModel):
    name: str


class ProfileIn(BaseModel):
    """The editable part of an account: who you are and where you do it."""
    name: str
    position: str = ""
    organisation: str = ""


class RoleIn(BaseModel):
    role: str


class DeleteIn(BaseModel):
    password: str


class EmailPrefIn(BaseModel):
    """Account email: True means "stop sending me account email"."""
    off: bool = True


class VisitorIn(BaseModel):
    """The browser's own anonymous visitor id, used only to delete its rows."""
    visitor: Optional[str] = None


class ForgotIn(BaseModel):
    email: str


class ResetIn(BaseModel):
    token: str
    new_password: str


def secure(payload: dict, status_code: int = 200):
    """Account data must never be cached by a browser or a proxy."""
    return JSONResponse(payload, status_code=status_code,
                        headers={"Cache-Control": "no-store"})


def open_accounts():
    """The accounts connection, or a 503 whose cause goes to the log.

    The operator's fix (which store was tried, which variable to set) is only
    useful in the log and in /api/health; a visitor on the sign-in form should
    not be handed deployment instructions.
    """
    try:
        return accounts.connect()
    except ACCOUNT_PROBLEMS as err:
        log.error("Accounts are unavailable: %s", accounts.unavailable_reason(err))
        raise HTTPException(
            status_code=503,
            detail="The account database is unavailable on this deployment, so "
                   "sign-in and sign-up are temporarily disabled.")


def client_ip(request: Request) -> str:
    """The caller's address, as the proxy in front of us reports it.

    Only ever used as a rate-limiting key: accounts.caller_key() hashes it, so
    no address is stored. Vercel and every reverse proxy set x-forwarded-for;
    x-real-ip wins when it is there, because it cannot carry a list.
    """
    real = request.headers.get("x-real-ip", "").strip()
    if real:
        return real
    forwarded = request.headers.get("x-forwarded-for", "")
    first = forwarded.split(",")[0].strip()
    if first:
        return first
    return request.client.host if request.client else ""


def too_many_attempts(err: accounts.TooManyAttempts) -> HTTPException:
    """429, with the wait the browser should honour before trying again."""
    return HTTPException(status_code=429, detail=str(err),
                         headers={"Retry-After": str(err.retry_after)})


def bearer_token(authorization: Optional[str] = Header(default=None)) -> Optional[str]:
    if not authorization:
        return None
    scheme, _, value = authorization.partition(" ")
    if scheme.lower() != "bearer" or not value.strip():
        return None
    return value.strip()


def current_user(authorization: Optional[str] = Header(default=None)) -> dict:
    token = bearer_token(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="Sign in to continue.",
                            headers={"WWW-Authenticate": "Bearer"})
    conn = open_accounts()
    try:
        user = accounts.user_for_token(conn, token)
    finally:
        conn.close()
    if user is None:
        raise HTTPException(status_code=401,
                            detail="Your session has expired. Sign in again.",
                            headers={"WWW-Authenticate": "Bearer"})
    return user


def admin_user(user: dict = Depends(current_user)) -> dict:
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="The dashboard is for administrators.")
    return user


@app.post("/api/auth/signup", status_code=201)
def signup(payload: SignupIn, request: Request):
    """Create an account and open a session.

    Email verification is currently off (accounts.REQUIRE_EMAIL_VERIFICATION):
    the account is stored verified, no link is sent and the tools work at once.
    With the switch back on, every new account starts unverified and the tools
    stay locked until the address is confirmed, whatever the mail settings are:
    an address nobody can read must never be enough to reach the tools. When no
    email service is configured the link cannot be delivered, so the account
    then waits for an administrator, who can confirm it from the dashboard.
    """
    if not (payload.position or "").strip():
        raise HTTPException(status_code=400,
                            detail="Tell us your position, for example student or engineer.")
    verification = "not-configured"
    verify_token = None
    ip = client_ip(request)
    left_over = accounts.SIGNUP_IP_LIMIT[0]
    conn = open_accounts()
    try:
        user_id, _role = accounts.signup(
            conn, payload.name, payload.email, payload.password,
            verified=False, ip=ip,
            organisation=payload.organisation, position=payload.position)
        token = accounts.create_session(conn, user_id)
        user = accounts.get_user(conn, user_id)
        if accounts.REQUIRE_EMAIL_VERIFICATION:
            verify_token = accounts.create_verify_token(conn, user_id)
        # So the page can say how much of this caller's allowance is left before
        # the next sign-up is refused; only sent when it is worth mentioning.
        left_over = accounts.attempts_left(conn, accounts.caller_key("signup-ip", ip),
                                           accounts.SIGNUP_IP_LIMIT)
    except accounts.TooManyAttempts as err:
        raise too_many_attempts(err)
    except accounts.EmailTaken as err:
        raise HTTPException(status_code=409, detail=str(err))
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err))
    except accounts.INTEGRITY_ERRORS:
        raise HTTPException(status_code=409, detail="An account with this email already exists.")
    finally:
        conn.close()
    if not accounts.REQUIRE_EMAIL_VERIFICATION:
        # Nothing to deliver and nothing to wait for.
        verification = "not-required"
    elif verify_token and not mail.configured():
        verification = "not-configured"
    elif verify_token:
        try:
            mail.send_verification(user["email"], user["name"], verify_token)
            verification = "sent"
        except mail.MailError as err:
            log.warning("Verification email to %s failed: %s", user["email"], err)
            verification = "failed"
    body = {"token": token, "user": user, "verification": verification}
    if left_over == 0:
        body["notice"] = ("This network has used all %d of its sign-ups for this hour."
                          % accounts.SIGNUP_IP_LIMIT[0])
    elif left_over <= 2:
        body["notice"] = ("Only %d more sign-up%s %s allowed from this network this "
                          "hour." % (left_over, "" if left_over == 1 else "s",
                                     "is" if left_over == 1 else "are"))
    return secure(body, 201)


@app.post("/api/auth/login")
def login(payload: LoginIn, request: Request):
    conn = open_accounts()
    try:
        user_id = accounts.login(conn, payload.email, payload.password,
                                 ip=client_ip(request))
        token = accounts.create_session(conn, user_id)
        user = accounts.get_user(conn, user_id)
    except accounts.TooManyAttempts as err:
        raise too_many_attempts(err)
    except ValueError as err:
        raise HTTPException(status_code=401, detail=str(err))
    finally:
        conn.close()
    return secure({"token": token, "user": user})


@app.post("/api/auth/logout")
def logout(authorization: Optional[str] = Header(default=None)):
    """End the session that sent the request. Safe to call twice."""
    token = bearer_token(authorization)
    if token:
        conn = open_accounts()
        try:
            accounts.delete_session(conn, token)
        finally:
            conn.close()
    return secure({"ok": True})


@app.post("/api/auth/verify")
def verify_email(payload: TokenIn):
    """Open a verification link. Works without being signed in."""
    conn = open_accounts()
    try:
        info = accounts.verify_user(conn, payload.token)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err))
    finally:
        conn.close()
    return secure({"ok": True, "email": info["email"], "name": info["name"]})


@app.post("/api/auth/verify/resend")
def resend_verification(user: dict = Depends(current_user)):
    if user["email_verified"]:
        raise HTTPException(status_code=400, detail="This email address is already verified.")
    if user.get("email_off"):
        raise HTTPException(
            status_code=400,
            detail="Account email is turned off for this account. Turn it back on "
                   "in the Email section of your account page, then ask again.",
        )
    if not mail.configured():
        raise HTTPException(status_code=400,
                            detail="Email delivery is not configured on this server.")
    conn = open_accounts()
    try:
        wait = accounts.resend_wait(conn, user["id"])
        if wait:
            raise HTTPException(status_code=429,
                                detail="Please wait %d s before asking for another email." % wait)
        verify_token = accounts.create_verify_token(conn, user["id"])
    finally:
        conn.close()
    try:
        mail.send_verification(user["email"], user["name"], verify_token)
    except mail.MailError as err:
        raise HTTPException(status_code=502,
                            detail="The verification email could not be sent: %s" % err)
    return secure({"ok": True})


@app.post("/api/auth/password")
def change_password(payload: PasswordIn, user: dict = Depends(current_user),
                    authorization: Optional[str] = Header(default=None)):
    """Change your own password; other sessions are signed out."""
    conn = open_accounts()
    try:
        accounts.change_password(conn, user["id"], payload.current_password,
                                 payload.new_password, keep_token=bearer_token(authorization))
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err))
    except KeyError:
        raise HTTPException(status_code=404, detail="Account not found.")
    finally:
        conn.close()
    return secure({"ok": True})


@app.post("/api/auth/password/forgot")
def forgot_password(payload: ForgotIn, request: Request):
    """Email a single-use reset link.

    The answer is the same for every address, so this cannot be used to find
    out who has an account here. Delivery problems are logged, not reported.
    """
    if not mail.configured():
        raise HTTPException(
            status_code=400,
            detail="This server does not send email, so a reset link cannot be sent. "
                   "Ask the person who runs the site to configure email first.",
        )
    email = (payload.email or "").strip()
    if len(email) > 254 or not accounts.EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="Enter a valid email address.")
    conn = open_accounts()
    try:
        found = accounts.request_password_reset(conn, email, ip=client_ip(request))
    except accounts.TooManyAttempts as err:
        raise too_many_attempts(err)
    finally:
        conn.close()
    if found and found["token"]:
        # The answer below is identical for every address, so an account that
        # turned account email off must not produce a different one: it simply
        # gets no message. The account page warns about that before the switch.
        if found.get("email_off"):
            log.info("Password reset for %s not sent: account email is turned off.",
                     found["email"])
            return secure({"ok": True,
                           "message": "If that address has an account, a reset link "
                                      "is on its way."})
        try:
            mail.send_password_reset(found["email"], found["name"], found["token"])
        except mail.MailError as err:
            log.warning("Password reset email to %s failed: %s", found["email"], err)
    return secure({"ok": True,
                   "message": "If that address has an account, a reset link is on its way."})


@app.post("/api/auth/password/reset")
def reset_password(payload: ResetIn):
    """Consume a reset link, set the password and open a session.

    Holding the link proves control of the address, so the account also counts
    as verified afterwards. Every existing session is signed out.
    """
    conn = open_accounts()
    try:
        info = accounts.reset_password(conn, payload.token, payload.new_password)
        token = accounts.create_session(conn, info["id"])
        user = accounts.get_user(conn, info["id"])
    except accounts.ResetLinkError as err:
        # 410 tells the page the link itself is dead, not the password.
        raise HTTPException(status_code=410, detail=str(err))
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err))
    finally:
        conn.close()
    return secure({"token": token, "user": user})


@app.get("/api/auth/me")
def me(user: dict = Depends(current_user)):
    return secure({"user": user})


@app.get("/api/me/stats")
def my_stats(user: dict = Depends(current_user)):
    """Profile and activity for the account page."""
    conn = open_accounts()
    try:
        payload = accounts.user_stats(conn, user["id"])
    finally:
        conn.close()
    payload["mail_configured"] = mail.configured()
    return secure(payload)


@app.post("/api/events")
def record_event(payload: EventIn, user: dict = Depends(current_user)):
    """Record one tool use (simulate, compare, calibrate, validate, export)."""
    if not user["email_verified"] and user["role"] != "admin":
        raise HTTPException(status_code=403,
                            detail="Verify your email address before using the tools.")
    if payload.kind not in accounts.TOOL_KINDS:
        raise HTTPException(status_code=400, detail="Unknown event kind.")
    conn = open_accounts()
    try:
        accounts.add_event(conn, user["id"], payload.kind, payload.detail)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err))
    finally:
        conn.close()
    return secure({"ok": True})


@app.post("/api/activity")
def record_activity(payload: ActivityIn, authorization: Optional[str] = Header(default=None)):
    """Log a visit, a cell view, a cell used in a tool, or a guest stopped by
    the sign-up wall. Open to everyone: a valid session is credited to the
    account, anything else to an anonymous visitor id. It never fails the
    page, so unknown input is dropped with 204-style success.
    """
    token = bearer_token(authorization)
    conn = open_accounts()
    try:
        user_id = None
        if token:
            user = accounts.user_for_token(conn, token)
            if user is not None:
                user_id = user["id"]
        cell_id = (payload.cell or "").strip() or None
        cell_name = None
        if cell_id:
            # Only cells that exist are counted, and the name comes from the
            # library, never from the browser.
            try:
                lib = db.connect()
                try:
                    found = db.cells(lib, cell_id)
                finally:
                    lib.close()
            except DB_PROBLEMS:
                # The library is read-only and separate from the activity log.
                # Failing to read it must not discard the row: that row is the
                # only record of what people actually use, and dropping it is
                # invisible in the admin panel. Keep the id, without a name.
                found = None
            if found is not None:
                if not found:
                    return secure({"ok": False})
                row = found[0]
                cell_name = (row.get("name") or row.get("model") or cell_id)
        try:
            saved = accounts.add_activity(
                conn, payload.kind, user_id=user_id, visitor=payload.visitor,
                tool=payload.tool, cell_id=cell_id, cell_name=cell_name,
            )
        except ValueError:
            return secure({"ok": False})
    finally:
        conn.close()
    return secure({"ok": bool(saved)})


@app.post("/api/admin/users/{user_id}/role")
def admin_set_role(user_id: int, payload: RoleIn, admin: dict = Depends(admin_user)):
    """Give a user the administrator role, or take it away.

    Only administrators reach this; the guards against removing the last
    administrator or changing your own role live in accounts.set_role.
    """
    conn = open_accounts()
    try:
        user = accounts.set_role(conn, user_id, payload.role, admin["id"])
    except KeyError:
        raise HTTPException(status_code=404, detail="No account with that id.")
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err))
    finally:
        conn.close()
    return secure({"ok": True, "user": user})


@app.post("/api/account/name")
def update_name(payload: NameIn, user: dict = Depends(current_user)):
    """Change your display name."""
    conn = open_accounts()
    try:
        updated = accounts.update_name(conn, user["id"], payload.name)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err))
    finally:
        conn.close()
    return secure(updated)


@app.post("/api/account/profile")
def update_profile(payload: ProfileIn, user: dict = Depends(current_user)):
    """Change your name, position and company or university.

    The account page edits all three together; `/api/account/name` stays for
    anything that only touches the name.
    """
    conn = open_accounts()
    try:
        updated = accounts.update_profile(conn, user["id"], payload.name,
                                          payload.position, payload.organisation)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err))
    finally:
        conn.close()
    return secure(updated)


@app.post("/api/account/email")
def update_email_preference(payload: EmailPrefIn, user: dict = Depends(current_user)):
    """Stop or resume account email for this account.

    This is the switch behind the unsubscribe link in every message we send and
    behind the Email section of the account page. Password-reset links are still
    delivered while it is off, because otherwise a forgotten password would lock
    the owner out of their own account; nothing else is ever sent either way.
    """
    conn = open_accounts()
    try:
        updated = accounts.set_email_off(conn, user["id"], bool(payload.off))
    except KeyError:
        raise HTTPException(status_code=404, detail="Account not found.")
    finally:
        conn.close()
    return secure({"ok": True, "user": updated})


@app.post("/api/privacy/forget")
def forget_visitor(payload: VisitorIn):
    """Delete the anonymous usage rows for one browser id.

    Open to everyone on purpose: it is how a visitor without an account removes
    what we hold about their visits, and it is the button in Cookie settings.
    The id is hashed before it is compared, so a request can only ever delete
    rows written for that same id, and an unknown id deletes nothing.
    """
    conn = open_accounts()
    try:
        removed = accounts.delete_visitor_activity(conn, payload.visitor)
    finally:
        conn.close()
    return secure({"ok": True, "removed": removed})


@app.post("/api/account/delete")
def delete_own_account(payload: DeleteIn, user: dict = Depends(current_user)):
    """Delete the account this session belongs to, password required.

    Nobody else can do this through the interface: an administrator can delete
    an account, but only from the dashboard, never by acting as its owner.
    """
    conn = open_accounts()
    try:
        accounts.delete_own_account(conn, user["id"], payload.password)
    except KeyError:
        raise HTTPException(status_code=404, detail="Account not found.")
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err))
    finally:
        conn.close()
    return secure({"ok": True})


@app.post("/api/admin/users/{user_id}/verify")
def admin_verify_user(user_id: int, admin: dict = Depends(admin_user)):
    """Mark an address verified when the email cannot be delivered."""
    conn = open_accounts()
    try:
        accounts.mark_verified(conn, user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="No account with that id.")
    finally:
        conn.close()
    return secure({"ok": True})


@app.post("/api/admin/users/{user_id}/delete")
def admin_delete_user(user_id: int, admin: dict = Depends(admin_user)):
    """Delete one account and its rows, from the dashboard.

    The guards live in accounts.delete_account: not your own account, not the
    address from OBF_ADMIN_EMAIL, and never the last administrator.
    """
    conn = open_accounts()
    try:
        removed = accounts.delete_account(conn, user_id, admin["id"])
    except KeyError:
        raise HTTPException(status_code=404, detail="No account with that id.")
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err))
    finally:
        conn.close()
    return secure({"ok": True, "removed": removed})


@app.get("/api/admin/stats")
def admin_dashboard(window: str = "30", admin: dict = Depends(admin_user)):
    """Users and tool usage for the admin dashboard (administrators only).

    `window` is 7, 30 or all; anything else falls back to the last 30 days.
    """
    conn = open_accounts()
    try:
        return secure(accounts.admin_stats(conn, window))
    finally:
        conn.close()


def frontend_directory():
    """The frontend folder, when it was copied next to the backend (Docker)."""
    configured = os.environ.get("OBF_FRONTEND_DIR")
    if configured:
        path = Path(configured)
        return path if (path / "index.html").exists() else None
    here = Path(__file__).resolve()
    for base in (here.parent.parent, here.parent.parent.parent):
        candidate = base / "frontend"
        if (candidate / "index.html").exists():
            return candidate
    return None


# ---------------------------------------------------------------------------
# SEO: robots.txt, sitemap.xml and server-rendered cell pages so search
# engines can discover and index every cell in the library.
# ---------------------------------------------------------------------------

def _public_base(request: Request) -> str:
    """The public origin (scheme + host) used for absolute URLs in SEO output.

    Set PUBLIC_BASE_URL (e.g. https://cells.example.com) when the app runs
    behind a proxy so the sitemap and canonical URLs use the public host.
    """
    configured = os.environ.get("PUBLIC_BASE_URL", "").strip().rstrip("/")
    if configured:
        return configured
    return str(request.base_url).rstrip("/")


@app.get("/robots.txt", include_in_schema=False)
def robots(request: Request):
    base = _public_base(request)
    body = (
        "User-agent: *\n"
        "Allow: /\n"
        f"Sitemap: {base}/sitemap.xml\n"
    )
    return Response(content=body, media_type="text/plain")


@app.get("/sitemap.xml", include_in_schema=False)
def sitemap(request: Request):
    base = _public_base(request)
    try:
        conn = db.connect()
    except DB_PROBLEMS as err:
        raise HTTPException(status_code=503, detail=str(err))
    try:
        cells = db.cells(conn)
    finally:
        conn.close()
    urls = [f"{base}/", f"{base}/#/library", f"{base}/#/sim",
            f"{base}/#/compare", f"{base}/#/docs", f"{base}/#/oss",
            f"{base}/privacy.html", f"{base}/terms.html", f"{base}/refunds.html",
            f"{base}/cookies.html", f"{base}/legal.html"]
    urls += [f"{base}/cell/{c['id']}" for c in cells]
    locs = "".join(f"  <url><loc>{u}</loc></url>\n" for u in urls)
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n'
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
           f"{locs}</urlset>\n")
    return Response(content=xml, media_type="application/xml")


@app.get("/cell/{cell_id}", include_in_schema=False)
def cell_page(cell_id: str, request: Request):
    """A real, indexable URL per cell with schema.org structured data."""
    import html as _html
    import json as _json
    try:
        conn = db.connect()
    except DB_PROBLEMS as err:
        raise HTTPException(status_code=503, detail=str(err))
    try:
        found = db.cells(conn, cell_id)
    finally:
        conn.close()
    if not found:
        raise HTTPException(status_code=404, detail="Cell not found")
    c = found[0]
    base = _public_base(request)
    name = c.get("name") or f"{c.get('model') or c.get('id')} battery cell"
    brand = c.get("brand") or "openBatteryFlux"
    model = c.get("model") or c.get("id")
    form = c.get("form") or ""
    cap = c.get("capacity_ah")
    chem = c.get("chemistry") or ""
    desc = f"{brand} {model} {form} battery cell"
    if cap:
        desc += f", {cap} Ah"
    if chem:
        desc += f", {chem} chemistry"
    desc += "."
    ld = {
        "@context": "https://schema.org",
        "@type": "Product",
        "name": name,
        "brand": {"@type": "Brand", "name": brand},
        "description": desc,
        "url": f"{base}/cell/{cell_id}",
        "category": "Battery cell",
    }
    if cap:
        ld["additionalProperty"] = [
            {"@type": "PropertyValue", "name": "Capacity",
             "value": cap, "unitCode": "AMH"}]
    esc = _html.escape
    html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{esc(name)} · openBatteryFlux</title>
<meta name="description" content="{esc(desc)}">
<link rel="canonical" href="{base}/cell/{cell_id}">
<script type="application/ld+json">{_json.dumps(ld)}</script>
</head>
<body>
<h1>{esc(name)}</h1>
<p>{esc(desc)}</p>
<p><a href="{base}/#/library/{cell_id}">Open in the simulator →</a></p>
</body>
</html>"""
    return HTMLResponse(content=html)


frontend = frontend_directory()
if frontend is not None:
    # Mounted last so /api/* and /docs keep working.
    app.mount("/", StaticFiles(directory=str(frontend), html=True), name="frontend")
