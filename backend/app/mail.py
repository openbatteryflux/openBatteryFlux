"""Outgoing email for openBatteryFlux.

Two messages are sent: the sign-up verification link and the password reset
link. Delivery uses Resend's HTTP API through urllib, so no vendor SDK or extra
dependency is needed. Two development modes are supported:

  RESEND_API_KEY  set   -> send through https://api.resend.com
  OBF_MAIL_FILE   set   -> append the message to that file instead (no network)
  neither               -> email is not configured; new accounts cannot verify
                           themselves and wait for an administrator

The public origin used in links comes from OBF_APP_ORIGIN, because the
frontend can be hosted separately from the API.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

RESEND_ENDPOINT = "https://api.resend.com/emails"
DEFAULT_SENDER = "openBatteryFlux <onboarding@resend.dev>"


class MailError(Exception):
    """The message could not be handed to the email service."""


def _setting(name: str) -> str:
    return os.environ.get(name, "").strip()


def configured() -> bool:
    """True when this server can send email at all."""
    return bool(_setting("RESEND_API_KEY") or _setting("OBF_MAIL_FILE"))


def app_origin() -> str:
    origin = _setting("OBF_APP_ORIGIN") or "http://localhost:8000"
    return origin.rstrip("/")


def sender() -> str:
    return _setting("OBF_MAIL_FROM") or DEFAULT_SENDER


def status() -> dict:
    """What /api/health reports about email, without any secret in it.

    `ready` answers the question an operator actually has after a deployment —
    will a stranger who signs up receive the link? — so a half-finished setup is
    visible at the health check instead of in a user's empty inbox.
    """
    if _setting("OBF_MAIL_FILE"):
        # Development capture: messages are deliberately kept on this machine.
        return {"configured": True, "ready": True, "mode": "file", "problems": []}
    problems = []
    if not _setting("RESEND_API_KEY"):
        problems.append("RESEND_API_KEY is not set, so no message can leave this "
                        "server; new accounts wait for an administrator to confirm them")
    else:
        if "@resend.dev" in sender().lower():
            problems.append("OBF_MAIL_FROM is unset, so the default resend.dev sender "
                            "is used: Resend delivers it only to the owner of the Resend "
                            "account, not to the people who sign up")
        host = app_origin().split("//")[-1].split("/")[0].split(":")[0].lower()
        if host in ("localhost", "127.0.0.1", "0.0.0.0"):
            problems.append("OBF_APP_ORIGIN is unset, so links inside the emails point "
                            "at " + app_origin() + " instead of the public site")
    return {"configured": configured(), "ready": configured() and not problems,
            "mode": "resend" if configured() else "none", "problems": problems}


def account_url() -> str:
    """Where the account page lives: email preferences and deletion."""
    return "%s/#/account" % app_origin()


def footer_text() -> str:
    """The footer every message carries.

    It answers the two questions a service email has to answer: why this
    arrived, and how to make it stop. The unsubscribe action is real (the
    switch on the account page) and it is honest about the one exception.
    """
    origin = app_origin()
    return (
        "--\n"
        "This is a one-off service message about your openBatteryFlux account. "
        "We send no newsletter and no marketing.\n"
        "Unsubscribe from account email, or delete the account: %s\n"
        "Password-reset links are still sent while account email is off, so a "
        "forgotten password cannot lock you out of your own account.\n"
        "Privacy notice: %s/privacy.html · Who we are: %s/legal.html\n"
        % (account_url(), origin, origin)
    )


def footer_html() -> str:
    origin = app_origin()
    return (
        '<hr style="border:0;border-top:1px solid #DCE6EC;margin:18px 0 10px">'
        '<p style="font-size:12px;line-height:1.6;color:#4B5F73;margin:0">'
        "This is a one-off service message about your openBatteryFlux account. We send no newsletter and no marketing. "
        '<a href="%s" style="color:#0E7490">Unsubscribe</a> — turn account email off on your account page, '
        "or delete the account there. Password-reset links are still sent while account email is off, "
        "so a forgotten password cannot lock you out of your own account.<br>"
        '<a href="%s/privacy.html" style="color:#0E7490">Privacy notice</a> · '
        '<a href="%s/legal.html" style="color:#0E7490">Who we are and how to reach us</a>'
        "</p>" % (account_url(), origin, origin)
    )


def verification_link(token: str) -> str:
    return "%s/#/verify/%s" % (app_origin(), token)


def verification_message(name: str, token: str) -> tuple[str, str, str]:
    """(subject, plain text, html) for the sign-up verification email."""
    link = verification_link(token)
    who = name or "there"
    subject = "Verify your email for openBatteryFlux"
    text = (
        "Hi %s,\n\n"
        "Confirm your email address for openBatteryFlux:\n\n"
        "  %s\n\n"
        "The link works once and expires in 24 hours.\n"
        "If you did not create an account, you can ignore this message.\n\n"
        "%s"
    ) % (who, link, footer_text())
    html = (
        '<div style="font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0A1A24">'
        "<p>Hi %s,</p>"
        "<p>Confirm your email address for <b>openBatteryFlux</b>:</p>"
        '<p><a href="%s" style="display:inline-block;padding:11px 20px;border-radius:8px;'
        'background:#0E7490;color:#fff;text-decoration:none;font-weight:600">Verify my email</a></p>'
        '<p style="color:#52687A;font-size:13px">Or paste this link into your browser:<br>%s</p>'
        '<p style="color:#52687A;font-size:13px">The link works once and expires in 24 hours. '
        "If you did not create an account, you can ignore this message.</p>"
        + footer_html() +
        "</div>"
    ) % (who, link, link)
    return subject, text, html


def reset_link(token: str) -> str:
    return "%s/#/reset/%s" % (app_origin(), token)


def reset_message(name: str, token: str) -> tuple[str, str, str]:
    """(subject, plain text, html) for the forgotten-password email."""
    link = reset_link(token)
    who = name or "there"
    subject = "Set a new password for openBatteryFlux"
    text = (
        "Hi %s,\n\n"
        "Someone asked to reset the password of the openBatteryFlux account for "
        "this address. Choose a new password here:\n\n"
        "  %s\n\n"
        "The link works once, expires in 1 hour, and signs out every open session "
        "of that account. If you did not ask for this, ignore the message: the "
        "current password stays as it is.\n\n"
        "%s"
    ) % (who, link, footer_text())
    html = (
        '<div style="font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0A1A24">'
        "<p>Hi %s,</p>"
        "<p>Someone asked to reset the password of the <b>openBatteryFlux</b> account for this "
        "address. Choose a new password here:</p>"
        '<p><a href="%s" style="display:inline-block;padding:11px 20px;border-radius:8px;'
        'background:#0E7490;color:#fff;text-decoration:none;font-weight:600">Set a new password</a></p>'
        '<p style="color:#52687A;font-size:13px">Or paste this link into your browser:<br>%s</p>'
        '<p style="color:#52687A;font-size:13px">The link works once, expires in 1 hour, and signs '
        "out every open session of that account. If you did not ask for this, ignore the message: "
        "the current password stays as it is.</p>"
        + footer_html() +
        "</div>"
    ) % (who, link, link)
    return subject, text, html


def _write_file(to: str, subject: str, text: str) -> None:
    path = Path(_setting("OBF_MAIL_FILE"))
    path.parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    with path.open("a", encoding="utf-8") as handle:
        handle.write("=== %s\nTo: %s\nSubject: %s\n\n%s\n\n" % (stamp, to, subject, text))


def _post_resend(to: str, subject: str, text: str, html: str) -> None:
    payload = {"from": sender(), "to": [to], "subject": subject, "text": text, "html": html}
    request = urllib.request.Request(
        RESEND_ENDPOINT,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": "Bearer " + _setting("RESEND_API_KEY"),
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            response.read()
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace").strip()[:300]
        raise MailError("the email service answered HTTP %s: %s" % (err.code, detail))
    except (urllib.error.URLError, OSError) as err:
        raise MailError("the email service could not be reached (%s)" % err)


def send(to: str, subject: str, text: str, html: str = "") -> None:
    """Send one message. Raises MailError when it cannot be handed over."""
    if not configured():
        raise MailError("email delivery is not configured on this server")
    if _setting("OBF_MAIL_FILE"):
        _write_file(to, subject, text)
        return
    _post_resend(to, subject, text, html)


def send_verification(to: str, name: str, token: str) -> None:
    subject, text, html = verification_message(name, token)
    send(to, subject, text, html)


def send_password_reset(to: str, name: str, token: str) -> None:
    subject, text, html = reset_message(name, token)
    send(to, subject, text, html)
