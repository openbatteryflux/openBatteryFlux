"""Accounts, sessions and usage statistics for openBatteryFlux.

The cell library (cells.db) is opened read-only and is never written by the
API. Accounts live in a separate, writable SQLite file (app.db) next to it, so
editing cells can never damage user data and vice versa.

On a serverless host there is no writable disk, so set OBF_DATABASE_URL and the
same statements run against a hosted Turso database instead — see remote_db.py.
Every function here takes the connection it is given and does not care which of
the two it is.

Only the standard library is used for the credentials themselves:
  * passwords are hashed with PBKDF2-HMAC-SHA256 and a random salt;
  * session tokens are random 256-bit strings, stored as SHA-256 digests, so
    the database never contains a usable token;
  * every authenticated request refreshes users.last_seen_at, which is what
    the admin dashboard counts as "active".
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
import re
import secrets
import sqlite3
import threading
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from . import remote_db

log = logging.getLogger("openbatteryflux.accounts")

SESSION_DAYS = 30
PBKDF2_ROUNDS = 260_000
VERIFY_HOURS = 24
RESET_MINUTES = 60
RESEND_SECONDS = 60

# ---------------------------------------------------------------------------
# TEMPORARY: email verification is switched off.
#
# Every account is created already verified and no verification link is sent,
# so a sign-up can use the tools at once. Accounts made while the switch was on
# are marked verified on startup as well, so nobody is left waiting.
#
# Set this back to True to restore the old behaviour: new accounts start
# unverified, the tools stay locked and the link is emailed. Nothing else has to
# change — the verify/resend endpoints, the dashboard Verify button and the
# front-end verify wall all still exist and start working again.
REQUIRE_EMAIL_VERIFICATION = False

# Rate limits as (attempts, window in seconds, block in seconds). The counters
# live in the throttle table rather than in memory: a serverless deployment
# runs several instances, and they all have to agree on who is blocked.
LOGIN_EMAIL_LIMIT = (5, 15 * 60, 15 * 60)     # wrong passwords per address
LOGIN_IP_LIMIT = (20, 15 * 60, 15 * 60)       # wrong passwords per caller
SIGNUP_IP_LIMIT = (5, 60 * 60, 60 * 60)       # accounts tried per caller
RESET_EMAIL_LIMIT = (5, 60 * 60, 60 * 60)     # reset links asked for per address
RESET_IP_LIMIT = (10, 60 * 60, 60 * 60)       # reset links asked for per caller
THROTTLE_KEEP = 24 * 60 * 60                  # how long a quiet counter is kept
ROLES = ("user", "admin")
# Tool events the frontend is allowed to report, plus the server-side ones.
TOOL_KINDS = ("simulate", "compare", "calibrate", "validate", "export", "library")
EVENT_KINDS = TOOL_KINDS + ("login", "signup", "verify", "password", "role", "name", "email", "account")
# What the browser may report in the activity log, for signed-in users and
# guests alike:
#   visit  a page load (one per browser tab session)
#   view   a cell opened in the library
#   use    a cell chosen or run in a tool (the tool is in the "tool" column)
#   gate   a guest sent to the sign-up wall by a tool
ACTIVITY_KINDS = ("visit", "view", "use", "gate")
VISITOR_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user',
    organisation  TEXT NOT NULL DEFAULT '',
    position      TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    last_login_at TEXT,
    last_seen_at  TEXT,
    email_verified     INTEGER NOT NULL DEFAULT 0,
    email_opt_out      INTEGER NOT NULL DEFAULT 0,
    verify_token_hash  TEXT,
    verify_expires_at  TEXT,
    verify_sent_at     TEXT,
    reset_token_hash   TEXT,
    reset_expires_at   TEXT,
    reset_sent_at      TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    detail     TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_user ON events(user_id, created_at);
CREATE INDEX IF NOT EXISTS events_created ON events(created_at);
-- Everything cell-related, for signed-in users (user_id) and guests (visitor,
-- a random id kept in the browser and stored only as a short hash).
CREATE TABLE IF NOT EXISTS activity (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    visitor    TEXT,
    kind       TEXT NOT NULL,
    tool       TEXT,
    cell_id    TEXT,
    cell_name  TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_created ON activity(created_at);
CREATE INDEX IF NOT EXISTS activity_user ON activity(user_id, created_at);
CREATE INDEX IF NOT EXISTS activity_visitor ON activity(visitor, created_at);
-- The same rows again, for the two questions the dashboard asks of them:
-- "this kind, in this window" and "this one cell". Without these, every
-- dashboard load and every picker open scanned the whole table.
CREATE INDEX IF NOT EXISTS activity_kind ON activity(kind, created_at);
CREATE INDEX IF NOT EXISTS activity_cell ON activity(cell_id, kind);
-- Anonymous popularity counters for the cell picker: at most one row per cell,
-- with no account, no visitor id, no address and no per-event timestamp. The
-- activity log above only holds rows for visitors who allowed it in the cookie
-- banner, so where most people choose "essential only" it says almost nothing;
-- these counters are what make "Most used" true for everybody.
CREATE TABLE IF NOT EXISTS cell_hits (
    cell_id TEXT PRIMARY KEY,
    views   INTEGER NOT NULL DEFAULT 0,
    uses    INTEGER NOT NULL DEFAULT 0,
    last_at TEXT NOT NULL
);
-- The same anonymous counts split by UTC day, so the dashboard can rank a 7- or
-- 30-day window and not only all time. Still a number per cell per day: no
-- account, no visitor id, no address, nothing that ties a day to a person.
CREATE TABLE IF NOT EXISTS cell_day_hits (
    day     TEXT NOT NULL,
    cell_id TEXT NOT NULL,
    views   INTEGER NOT NULL DEFAULT 0,
    uses    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, cell_id)
);
-- Rate limiting. A key is a keyed digest, never the address or email itself.
CREATE TABLE IF NOT EXISTS throttle (
    key           TEXT PRIMARY KEY,
    count         INTEGER NOT NULL DEFAULT 0,
    first_at      TEXT NOT NULL,
    blocked_until TEXT
);
CREATE INDEX IF NOT EXISTS throttle_first ON throttle(first_at);
"""

_schema_ready = False
_schema_lock = threading.Lock()

# Failures the API answers with a 503: a local file that cannot be opened, or
# the hosted database being unreachable. The driver's own exceptions are not
# sqlite3 ones, so both families have to be listed.
STORAGE_ERRORS = (OSError, sqlite3.Error) + remote_db.error_types()
# Constraint violations that mean "this email is already taken".
INTEGRITY_ERRORS = (sqlite3.IntegrityError,) + remote_db.integrity_errors()


class EmailTaken(Exception):
    """The address already belongs to an account."""


class TooManyAttempts(Exception):
    """Something was tried too often; the API answers 429 and Retry-After."""

    def __init__(self, retry_after: int):
        self.retry_after = max(1, int(retry_after))
        minutes = (self.retry_after + 59) // 60
        super().__init__("Too many attempts. Try again in %d minute%s."
                         % (minutes, "" if minutes == 1 else "s"))


class ResetLinkError(ValueError):
    """The reset link is unknown, already used or expired."""


def database_path() -> Path:
    configured = os.environ.get("OBF_APP_DB_PATH")
    if configured:
        return Path(configured)
    return Path(__file__).resolve().parent.parent / "data" / "app.db"


def store() -> dict:
    """Which kind of store accounts use, for /api/health.

    Only the kind is named — "hosted" when OBF_DATABASE_URL or
    TURSO_DATABASE_URL is set, else "file". A deployment that should be using a
    hosted database answers "file" when its variables are missing or were added
    after it was built, which is the one thing worth seeing without trying to
    sign in. The URL and token are never repeated here.
    """
    return {"store": "hosted" if remote_db.enabled() else "file"}


def unavailable_reason(err: BaseException) -> str:
    """The 503 body for a store that cannot be opened.

    The driver's own message ("unable to open database file") says nothing to
    the person deploying, so the reason names the store that was tried, where,
    and what to change.
    """
    if remote_db.enabled():
        return ("The account database is not available: the hosted database "
                "could not be reached (%s). Check OBF_DATABASE_URL and "
                "OBF_DATABASE_TOKEN, and that the database accepts "
                "connections." % err)
    return ("The account database is not available: no hosted database is "
            "configured, so accounts were tried in the local file %s (%s). "
            "Serverless hosts such as Vercel have no writable disk: set "
            "OBF_DATABASE_URL and OBF_DATABASE_TOKEN in the deployment's "
            "environment variables, then redeploy — a deployment keeps the "
            "variables it was built with. See DEPLOY.md, \"Accounts need a "
            "database, not a disk\"." % (database_path(), err))


def _stamp(moment: datetime | None = None) -> str:
    """SQLite-friendly UTC timestamp: 2026-10-25 06:37:00."""
    moment = moment or datetime.now(timezone.utc)
    return moment.strftime("%Y-%m-%d %H:%M:%S")


def _ago(**kwargs) -> str:
    return _stamp(datetime.now(timezone.utc) - timedelta(**kwargs))


# ---------------------------------------------------------------------------
# rate limiting
# ---------------------------------------------------------------------------

_throttle_purged = False
_throttle_lock = threading.Lock()


def _digest(kind: str, value: str) -> str:
    """A throttle key: a keyed digest, so no address is stored in the clear.

    Set OBF_THROTTLE_KEY to a random string to make these unlinkable even to
    someone reading the database; the built-in default exists so that a
    deployment which never set it still gets working limits.
    """
    secret = os.environ.get("OBF_THROTTLE_KEY", "openbatteryflux-throttle")
    salt = hmac.new(secret.encode("utf-8"), kind.encode("utf-8"), hashlib.sha256).digest()
    return kind + ":" + hmac.new(salt, value.encode("utf-8"), hashlib.sha256).hexdigest()[:32]


def caller_key(kind: str, ip: str | None) -> str | None:
    """The key for a caller's address, or None when the host did not say."""
    ip = (ip or "").strip()
    return _digest(kind, ip) if ip else None


def _seconds_left(stamp: str | None) -> int:
    if not stamp:
        return 0
    try:
        until = datetime.strptime(stamp, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return 0
    return max(0, int((until - datetime.now(timezone.utc)).total_seconds()))


def _purge_throttle(conn: sqlite3.Connection) -> None:
    """Forget counters nobody has touched for a day. Once per process."""
    global _throttle_purged
    if _throttle_purged:
        return
    with _throttle_lock:
        if _throttle_purged:
            return
        conn.execute("DELETE FROM throttle WHERE first_at < ?",
                     (_ago(seconds=THROTTLE_KEEP),))
        conn.commit()
        _throttle_purged = True


def throttle_check(conn: sqlite3.Connection, keys) -> None:
    """Raise TooManyAttempts while any of these keys is blocked."""
    _purge_throttle(conn)
    wait = 0
    for key in keys:
        if not key:
            continue
        row = conn.execute("SELECT blocked_until FROM throttle WHERE key = ?",
                           (key,)).fetchone()
        wait = max(wait, _seconds_left(row["blocked_until"]) if row else 0)
    if wait:
        raise TooManyAttempts(wait)


def throttle_hit(conn: sqlite3.Connection, key: str | None,
                 limit: tuple[int, int, int]) -> None:
    """Count one attempt against key, blocking once the allowance is used up.

    The attempt that reaches the limit is still allowed — that is what makes
    "five wrong passwords" mean five — and the block starts immediately, so the
    next request is the one throttle_check refuses. The row is committed
    straight away, because a rejected attempt usually ends in an exception that
    would otherwise roll the count back.
    """
    if not key:
        return
    attempts, window, block = limit
    now = datetime.now(timezone.utc)
    row = conn.execute(
        "SELECT count, first_at, blocked_until FROM throttle WHERE key = ?", (key,)
    ).fetchone()
    if row is not None and _seconds_left(row["blocked_until"]):
        return

    count, first = 1, now
    if row is not None:
        try:
            started = datetime.strptime(row["first_at"], "%Y-%m-%d %H:%M:%S").replace(
                tzinfo=timezone.utc)
        except ValueError:
            started = None
        if started is not None and (now - started).total_seconds() <= window:
            count, first = row["count"] + 1, started

    blocked = count >= attempts
    until = _stamp(now + timedelta(seconds=block)) if blocked else None
    conn.execute(
        """INSERT INTO throttle (key, count, first_at, blocked_until)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET count = excluded.count,
               first_at = excluded.first_at, blocked_until = excluded.blocked_until""",
        (key, count, _stamp(first), until),
    )
    conn.commit()


def attempts_left(conn: sqlite3.Connection, key: str | None,
                  limit: tuple[int, int, int]) -> int:
    """How many attempts this key still has before it is blocked (0 if blocked)."""
    if not key:
        return limit[0]
    row = conn.execute("SELECT count, blocked_until FROM throttle WHERE key = ?",
                       (key,)).fetchone()
    if row is None:
        return limit[0]
    if _seconds_left(row["blocked_until"]):
        return 0
    return max(0, limit[0] - row["count"])


def login_key(email: str) -> str:
    """The key a failed sign-in is counted against, for per-form warnings."""
    return _digest("login", (email or "").strip().lower())


def throttle_clear(conn: sqlite3.Connection, key: str | None) -> None:
    """Forget the attempts for a key, on a success worth trusting."""
    if not key:
        return
    conn.execute("DELETE FROM throttle WHERE key = ?", (key,))
    conn.commit()


def connect() -> sqlite3.Connection:
    """Open the accounts database: the hosted one when configured, else the file.

    The return type is annotated sqlite3.Connection because that is the shape
    used here (execute/executescript/commit/close, rows addressable by column
    name); the hosted driver is DB-API 2.0 and behaves the same way.
    """
    global _schema_ready
    if remote_db.enabled():
        conn = remote_db.connect()
    else:
        path = database_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(path), timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
    if not _schema_ready:
        with _schema_lock:
            if not _schema_ready:
                conn.executescript(SCHEMA)
                _migrate(conn)
                conn.commit()
                _schema_ready = True
    return conn


NEW_COLUMNS = (
    ("organisation", "ALTER TABLE users ADD COLUMN organisation TEXT NOT NULL DEFAULT ''"),
    ("position", "ALTER TABLE users ADD COLUMN position TEXT NOT NULL DEFAULT ''"),
    ("email_verified", "ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0"),
    ("email_opt_out", "ALTER TABLE users ADD COLUMN email_opt_out INTEGER NOT NULL DEFAULT 0"),
    ("verify_token_hash", "ALTER TABLE users ADD COLUMN verify_token_hash TEXT"),
    ("verify_expires_at", "ALTER TABLE users ADD COLUMN verify_expires_at TEXT"),
    ("verify_sent_at", "ALTER TABLE users ADD COLUMN verify_sent_at TEXT"),
    ("reset_token_hash", "ALTER TABLE users ADD COLUMN reset_token_hash TEXT"),
    ("reset_expires_at", "ALTER TABLE users ADD COLUMN reset_expires_at TEXT"),
    ("reset_sent_at", "ALTER TABLE users ADD COLUMN reset_sent_at TEXT"),
)


def _migrate(conn: sqlite3.Connection) -> None:
    """Add the columns of newer versions to a database created by an older one.

    A database this process just created from SCHEMA already has every column,
    and a hosted database need not expose PRAGMA at all, so an answer that
    cannot be read means there is nothing to migrate rather than an error.
    """
    try:
        existing = {row["name"] for row in conn.execute("PRAGMA table_info(users)")}
    except STORAGE_ERRORS as err:
        log.warning("Skipping the account schema check (%s).", err)
        return
    if not existing:
        return
    added = set()
    for name, statement in NEW_COLUMNS:
        if name not in existing:
            conn.execute(statement)
            added.add(name)
    if "email_verified" in added:
        # Accounts created before email verification existed are trusted.
        conn.execute("UPDATE users SET email_verified = 1")
    if not REQUIRE_EMAIL_VERIFICATION:
        # Verification is off, so nobody waits: accounts created while it was on
        # are unlocked here and the dashboard queue empties by itself.
        conn.execute("UPDATE users SET email_verified = 1 WHERE email_verified = 0")


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ROUNDS)
    return "pbkdf2_sha256$%d$%s$%s" % (PBKDF2_ROUNDS, salt.hex(), digest.hex())


def verify_password(password: str, stored: str) -> bool:
    try:
        algorithm, rounds, salt_hex, digest_hex = stored.split("$")
        if algorithm != "pbkdf2_sha256":
            return False
        expected = bytes.fromhex(digest_hex)
        actual = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(rounds)
        )
        return hmac.compare_digest(expected, actual)
    except (ValueError, TypeError):
        return False


def _token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def admin_email() -> str:
    """OBF_ADMIN_EMAIL marks one account as the administrator."""
    return os.environ.get("OBF_ADMIN_EMAIL", "").strip().lower()


def _role_for_new_user(conn: sqlite3.Connection, email: str) -> str:
    wanted = admin_email()
    if wanted:
        return "admin" if email == wanted else "user"
    # No address configured: the first account gets the dashboard, so a fresh
    # deployment works without touching any configuration.
    existing = conn.execute("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").fetchone()
    return "user" if existing else "admin"


def public_user(row: sqlite3.Row | dict) -> dict:
    item = dict(row)
    return {
        "id": item["id"],
        "name": item["name"],
        "email": item["email"],
        "role": item["role"],
        "organisation": item.get("organisation") or "",
        "position": item.get("position") or "",
        "created_at": item["created_at"],
        "last_login_at": item.get("last_login_at"),
        "last_seen_at": item.get("last_seen_at"),
        "email_verified": bool(item.get("email_verified")),
        "email_off": bool(item.get("email_opt_out")),
    }


def check_password(password: str) -> None:
    """Shared strength check for sign-up, change-password and admin resets."""
    password = password or ""
    if len(password) < 8:
        raise ValueError("Password must have at least 8 characters.")
    if len(password) > 200:
        raise ValueError("Password must have at most 200 characters.")


def signup(conn: sqlite3.Connection, name: str, email: str, password: str,
           verified: bool = False, ip: str | None = None,
           organisation: str = "", position: str = "") -> tuple[int, str]:
    """Create an account, at most SIGNUP_IP_LIMIT per caller per hour.

    While REQUIRE_EMAIL_VERIFICATION is off the row is stored verified whatever
    the caller asks for; `verified=True` is then redundant rather than wrong.

    `organisation` (a company or university) is optional and may be empty;
    `position` is what the person does there (student, engineer, ...). The
    sign-up form requires a position, so this only guards its length here: an
    account made from the command line has no one to ask.
    """
    email = (email or "").strip().lower()
    name = (name or "").strip()
    organisation = (organisation or "").strip()
    position = (position or "").strip()
    if len(organisation) > 120:
        raise ValueError("The company or university must have at most 120 characters.")
    if len(position) > 80:
        raise ValueError("The position must have at most 80 characters.")
    # Checked before the forms so a blocked caller learns immediately, and
    # counted only for accounts that are actually created: a mistyped password
    # must not use up somebody's allowance.
    caller = caller_key("signup-ip", ip)
    throttle_check(conn, (caller,))

    if len(email) > 254 or not EMAIL_RE.match(email):
        raise ValueError("Enter a valid email address.")
    check_password(password)
    if not name:
        name = email.split("@")[0]
    if len(name) > 80:
        raise ValueError("The name must have at most 80 characters.")

    if conn.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
        raise EmailTaken("An account with this email already exists. Log in instead.")

    role = _role_for_new_user(conn, email)
    now = _stamp()
    cursor = conn.execute(
        """INSERT INTO users (email, name, password_hash, role, organisation,
                              position, created_at, last_login_at, last_seen_at,
                              email_verified)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (email, name, hash_password(password), role, organisation, position,
         now, now, now, 1 if (verified or not REQUIRE_EMAIL_VERIFICATION) else 0),
    )
    user_id = cursor.lastrowid
    add_event(conn, user_id, "signup", commit=False)
    conn.commit()
    throttle_hit(conn, caller, SIGNUP_IP_LIMIT)
    return user_id, role


def _wrong_password(conn: sqlite3.Connection, address: str) -> str:
    """The message for a wrong password, warning before the address is locked."""
    left = attempts_left(conn, address, LOGIN_EMAIL_LIMIT)
    minutes = LOGIN_EMAIL_LIMIT[2] // 60
    if left == 0:
        return ("Wrong email or password. This address is now locked for the next "
                "%d minutes." % minutes)
    if left <= 2:
        return ("Wrong email or password. %d attempt%s left before this address is "
                "locked for %d minutes."
                % (left, "" if left == 1 else "s", minutes))
    return "Wrong email or password."


def login(conn: sqlite3.Connection, email: str, password: str,
          ip: str | None = None) -> int:
    """Sign in, counting wrong passwords against the address and the caller."""
    email = (email or "").strip().lower()
    address = login_key(email)
    caller = caller_key("login-ip", ip)
    throttle_check(conn, (address, caller))
    row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if row is None or not verify_password(password or "", row["password_hash"]):
        # The attempt that uses up the allowance still gets the ordinary answer;
        # the one after it is told to wait. Unknown addresses count too, so this
        # cannot be used to find out which addresses exist.
        throttle_hit(conn, address, LOGIN_EMAIL_LIMIT)
        throttle_hit(conn, caller, LOGIN_IP_LIMIT)
        raise ValueError(_wrong_password(conn, address))
    throttle_clear(conn, address)

    wanted = admin_email()
    if wanted and email == wanted and row["role"] != "admin":
        # The configured address is always an administrator, so a deployment
        # can never lose the account that can fix it. Other accounts keep the
        # role an administrator gave them (see set_role).
        conn.execute("UPDATE users SET role = 'admin' WHERE id = ?", (row["id"],))
    now = _stamp()
    conn.execute(
        "UPDATE users SET last_login_at = ?, last_seen_at = ? WHERE id = ?",
        (now, now, row["id"]),
    )
    add_event(conn, row["id"], "login", commit=False)
    conn.commit()
    return row["id"]


def get_user(conn: sqlite3.Connection, user_id: int) -> dict | None:
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return public_user(row) if row else None


def create_session(conn: sqlite3.Connection, user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    now = _stamp()
    expires = _stamp(datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS))
    conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        (_token_digest(token), user_id, now, expires),
    )
    conn.commit()
    return token


def user_for_token(conn: sqlite3.Connection, token: str) -> dict | None:
    """Resolve a session token and refresh the user's last-seen timestamp."""
    row = conn.execute(
        """SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ? AND s.expires_at > ?""",
        (_token_digest(token), _stamp()),
    ).fetchone()
    if row is None:
        return None
    conn.execute("UPDATE users SET last_seen_at = ? WHERE id = ?", (_stamp(), row["id"]))
    conn.commit()
    return public_user(row)


def delete_session(conn: sqlite3.Connection, token: str) -> None:
    conn.execute("DELETE FROM sessions WHERE token_hash = ?", (_token_digest(token),))
    conn.commit()


def revoke_sessions(conn: sqlite3.Connection, user_id: int, keep_token: str | None = None) -> None:
    """Sign a user out everywhere, optionally sparing the session that asks."""
    if keep_token:
        conn.execute("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?",
                     (user_id, _token_digest(keep_token)))
    else:
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))


def create_verify_token(conn: sqlite3.Connection, user_id: int) -> str:
    """New single-use verification token, valid for VERIFY_HOURS."""
    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    conn.execute(
        """UPDATE users SET verify_token_hash = ?, verify_expires_at = ?, verify_sent_at = ?
           WHERE id = ?""",
        (_token_digest(token), _stamp(now + timedelta(hours=VERIFY_HOURS)), _stamp(now), user_id),
    )
    conn.commit()
    return token


def resend_wait(conn: sqlite3.Connection, user_id: int) -> int:
    """Seconds the user must wait before another verification email."""
    row = conn.execute("SELECT verify_sent_at FROM users WHERE id = ?", (user_id,)).fetchone()
    if row is None or not row["verify_sent_at"]:
        return 0
    sent = datetime.strptime(row["verify_sent_at"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    elapsed = (datetime.now(timezone.utc) - sent).total_seconds()
    return max(0, int(RESEND_SECONDS - elapsed))


def verify_user(conn: sqlite3.Connection, token: str) -> dict:
    """Consume a verification token and mark that address as verified."""
    if not token or not token.strip():
        raise ValueError("This verification link is missing its token.")
    row = conn.execute(
        """SELECT id, name, email, email_verified, verify_expires_at FROM users
           WHERE verify_token_hash = ?""",
        (_token_digest(token.strip()),),
    ).fetchone()
    if row is None:
        raise ValueError("This verification link is not valid. Request a new one.")
    if row["verify_expires_at"] and row["verify_expires_at"] <= _stamp():
        raise ValueError("This verification link has expired. Request a new one.")
    conn.execute(
        """UPDATE users SET email_verified = 1, verify_token_hash = NULL,
                            verify_expires_at = NULL
           WHERE id = ?""",
        (row["id"],),
    )
    add_event(conn, row["id"], "verify", commit=False)
    conn.commit()
    return {"name": row["name"], "email": row["email"], "already": bool(row["email_verified"])}


def set_role(conn: sqlite3.Connection, user_id: int, role: str, actor_id: int) -> dict:
    """Give an account a role, or take it away. Administrators only.

    Three rules keep a deployment from locking itself out: nobody changes
    their own role, the address in OBF_ADMIN_EMAIL keeps the role the
    configuration gave it, and the last administrator cannot be demoted.
    """
    role = (role or "").strip().lower()
    if role not in ROLES:
        raise ValueError("Unknown role.")
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if row is None:
        raise KeyError(user_id)
    if user_id == actor_id:
        raise ValueError("You cannot change your own role.")
    wanted = admin_email()
    if wanted and row["email"].lower() == wanted:
        raise ValueError(
            "The role of %s comes from the OBF_ADMIN_EMAIL setting and cannot "
            "be changed here." % wanted
        )
    if role == "user" and row["role"] == "admin":
        others = conn.execute(
            "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND id != ?",
            (user_id,),
        ).fetchone()["n"]
        if not others:
            raise ValueError("This is the last administrator; promote another account first.")
    if row["role"] != role:
        conn.execute("UPDATE users SET role = ? WHERE id = ?", (role, user_id))
        add_event(conn, actor_id, "role",
                  "%s is now %s" % (row["email"], role), commit=False)
        conn.commit()
    return get_user(conn, user_id)


def delete_own_account(conn: sqlite3.Connection, user_id: int, password: str) -> None:
    """Delete the signed-in user's account, after re-checking the password.

    Sessions, verification and reset tokens go with it: they live in the same
    row, or in tables that reference it with ON DELETE CASCADE.
    """
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if row is None:
        raise KeyError(user_id)
    if not verify_password(password or "", row["password_hash"]):
        raise ValueError("The password is not correct.")
    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    conn.commit()


def delete_account(conn: sqlite3.Connection, user_id: int, actor_id: int) -> dict:
    """Delete one account. Administrators only, and never their own.

    The same three guards as set_role keep a deployment from locking itself
    out: an administrator deletes somebody else's account, the address in
    OBF_ADMIN_EMAIL cannot be deleted here, and the last administrator stays.
    Deleting your own account is the account page's job, where it is confirmed
    with the password.

    The rows that point at the account are removed first rather than left to
    ON DELETE CASCADE, so this also works where foreign keys are not enforced.
    """
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if row is None:
        raise KeyError(user_id)
    if user_id == actor_id:
        raise ValueError("Use the Delete account section of your own account page "
                         "to remove your account.")
    wanted = admin_email()
    if wanted and row["email"].lower() == wanted:
        raise ValueError("The account for %s comes from the OBF_ADMIN_EMAIL "
                         "setting and cannot be deleted here." % wanted)
    if row["role"] == "admin":
        others = conn.execute(
            "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND id != ?",
            (user_id,),
        ).fetchone()["n"]
        if not others:
            raise ValueError("This is the last administrator; promote another account first.")
    for table in ("sessions", "events", "activity"):
        conn.execute("DELETE FROM %s WHERE user_id = ?" % table, (user_id,))
    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    add_event(conn, actor_id, "account", "deleted account #%d" % user_id, commit=False)
    conn.commit()
    return {"id": user_id, "email": row["email"], "name": row["name"]}


def mark_verified(conn: sqlite3.Connection, user_id: int) -> None:
    """Administrator override when the email cannot be delivered."""
    if conn.execute("SELECT 1 FROM users WHERE id = ?", (user_id,)).fetchone() is None:
        raise KeyError(user_id)
    conn.execute(
        """UPDATE users SET email_verified = 1, verify_token_hash = NULL,
                            verify_expires_at = NULL WHERE id = ?""",
        (user_id,),
    )
    add_event(conn, user_id, "verify", commit=False)
    conn.commit()


def request_password_reset(conn: sqlite3.Connection, email: str,
                           ip: str | None = None) -> dict | None:
    """Create a single-use reset token for an address, or None if unknown.

    The caller answers the same way for known and unknown addresses, so this
    cannot be used to find out who has an account. A new token is only minted
    once per RESEND_SECONDS, which keeps repeated requests from flooding an
    inbox. A recent token is left untouched: its link is still valid.
    """
    email = (email or "").strip().lower()
    # Counted before the lookup, so asking about addresses that do not exist is
    # limited just like asking about ones that do: the two answers stay identical.
    address = _digest("reset", email)
    caller = caller_key("reset-ip", ip)
    throttle_check(conn, (address, caller))
    throttle_hit(conn, address, RESET_EMAIL_LIMIT)
    throttle_hit(conn, caller, RESET_IP_LIMIT)
    row = conn.execute(
        "SELECT id, name, email, reset_sent_at, email_opt_out FROM users WHERE email = ?",
        (email,),
    ).fetchone()
    if row is None:
        return None
    off = bool(row["email_opt_out"])
    if row["reset_sent_at"]:
        sent = datetime.strptime(row["reset_sent_at"], "%Y-%m-%d %H:%M:%S").replace(
            tzinfo=timezone.utc
        )
        if (datetime.now(timezone.utc) - sent).total_seconds() < RESEND_SECONDS:
            return {"name": row["name"], "email": row["email"], "token": None,
                    "email_off": off}
    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    conn.execute(
        """UPDATE users SET reset_token_hash = ?, reset_expires_at = ?, reset_sent_at = ?
           WHERE id = ?""",
        (_token_digest(token), _stamp(now + timedelta(minutes=RESET_MINUTES)),
         _stamp(now), row["id"]),
    )
    conn.commit()
    return {"name": row["name"], "email": row["email"], "token": token,
            "email_off": off}


def reset_password(conn: sqlite3.Connection, token: str, new: str) -> dict:
    """Consume a reset link and set a new password.

    The link proves control of the address, so it also confirms the email.
    Every session of that account is signed out, and the link cannot be used
    a second time.
    """
    if not token or not token.strip():
        raise ResetLinkError("This reset link is missing its token.")
    row = conn.execute(
        """SELECT id, name, email, reset_expires_at FROM users
           WHERE reset_token_hash = ?""",
        (_token_digest(token.strip()),),
    ).fetchone()
    if row is None:
        raise ResetLinkError("This reset link is not valid. Request a new one.")
    if row["reset_expires_at"] and row["reset_expires_at"] <= _stamp():
        raise ResetLinkError("This reset link has expired. Request a new one.")
    check_password(new)
    conn.execute(
        """UPDATE users SET password_hash = ?, email_verified = 1,
                            reset_token_hash = NULL, reset_expires_at = NULL,
                            verify_token_hash = NULL, verify_expires_at = NULL
           WHERE id = ?""",
        (hash_password(new), row["id"]),
    )
    revoke_sessions(conn, row["id"])
    add_event(conn, row["id"], "password", "reset by email", commit=False)
    conn.commit()
    return {"id": row["id"], "name": row["name"], "email": row["email"]}


def change_password(conn: sqlite3.Connection, user_id: int, current: str, new: str,
                    keep_token: str | None = None) -> None:
    """Change your own password; every other session is signed out."""
    row = conn.execute("SELECT password_hash FROM users WHERE id = ?", (user_id,)).fetchone()
    if row is None:
        raise KeyError(user_id)
    if not verify_password(current or "", row["password_hash"]):
        raise ValueError("The current password is not correct.")
    check_password(new)
    conn.execute(
        """UPDATE users SET password_hash = ?, reset_token_hash = NULL,
                            reset_expires_at = NULL WHERE id = ?""",
        (hash_password(new), user_id),
    )
    revoke_sessions(conn, user_id, keep_token)
    add_event(conn, user_id, "password", commit=False)
    conn.commit()


def visitor_hash(visitor: str | None) -> str | None:
    """Guests are stored as a short salted-free digest of their browser id, so
    the database never holds the id itself."""
    visitor = (visitor or "").strip()
    if not VISITOR_RE.match(visitor):
        return None
    return hashlib.sha256(("obf-guest:" + visitor).encode("utf-8")).hexdigest()[:16]


def add_activity(
    conn: sqlite3.Connection,
    kind: str,
    user_id: int | None = None,
    visitor: str | None = None,
    tool: str | None = None,
    cell_id: str | None = None,
    cell_name: str | None = None,
) -> bool:
    """Log one visit, cell view, cell use or sign-up-wall hit.

    Returns False when the call is dropped: an unknown kind or tool, nobody to
    attribute it to, or an exact repeat within two seconds (double clicks and
    re-renders must not inflate the counts).
    """
    if kind not in ACTIVITY_KINDS:
        raise ValueError("Unknown activity kind.")
    tool = (tool or "").strip().lower() or None
    if tool is not None and tool not in TOOL_KINDS:
        raise ValueError("Unknown tool.")
    if kind in ("use", "gate") and tool is None:
        raise ValueError("This activity needs a tool.")
    if kind in ("view", "use") and not cell_id:
        raise ValueError("This activity needs a cell.")
    guest = None
    if user_id is None:
        guest = visitor_hash(visitor)
        if guest is None:
            return False
    cell_id = (cell_id or "").strip()[:80] or None
    cell_name = (cell_name or "").strip()[:120] or None
    who_sql, who_arg = ("user_id = ?", user_id) if user_id is not None else ("visitor = ?", guest)
    repeat = conn.execute(
        f"""SELECT 1 FROM activity WHERE {who_sql} AND kind = ?
               AND IFNULL(tool, '') = ? AND IFNULL(cell_id, '') = ?
               AND created_at >= ? LIMIT 1""",
        (who_arg, kind, tool or "", cell_id or "", _ago(seconds=2)),
    ).fetchone()
    if repeat:
        return False
    conn.execute(
        """INSERT INTO activity (user_id, visitor, kind, tool, cell_id, cell_name, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (user_id, guest, kind, tool, cell_id, cell_name, _stamp()),
    )
    conn.commit()
    return True


# Loading a cell into a tool says more about what people want than opening its
# details page once, so a use weighs twice a view in the ranking.
POPULAR_RANKING = "(uses * 2 + views)"
POPULAR_RANKING_DAY = "(SUM(uses) * 2 + SUM(views))"
POPULAR_TTL = 60          # seconds an in-process ranking is reused
HIT_DAYS_KEPT = 400       # daily buckets retained, pruned on write
_hit_pruned_at = 0.0
_popular_cache: dict = {}
_popular_lock = threading.Lock()


def bump_cell_hit(conn: sqlite3.Connection, cell_id: str, kind: str) -> bool:
    """Count one cell opened or loaded, without recording who did it.

    This is the anonymous counter behind the picker's "Most used" shortcut. It
    keeps one running number per cell plus one row per cell per UTC day, so the
    dashboard can rank a 7- or 30-day window as well as all time — no account,
    no visitor id, no address, nothing that ties a day to a person — and it can
    be written for every visitor whatever they answered in the cookie banner.
    It stays tiny: one row per cell, plus one per cell per day.

    The activity log is a different thing: pseudonymous rows, consent gated,
    which is what the dashboard uses for its audience breakdown.
    """
    cell_id = (cell_id or "").strip()[:80]
    if not cell_id or kind not in ("view", "use"):
        return False
    column = "views" if kind == "view" else "uses"
    stamp = _stamp()
    views = 1 if kind == "view" else 0
    uses = 1 if kind == "use" else 0
    conn.execute(
        f"""INSERT INTO cell_hits (cell_id, views, uses, last_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(cell_id) DO UPDATE SET
                {column} = {column} + 1, last_at = excluded.last_at""",
        (cell_id, views, uses, stamp),
    )
    conn.execute(
        f"""INSERT INTO cell_day_hits (day, cell_id, views, uses)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(day, cell_id) DO UPDATE SET
                {column} = {column} + 1""",
        (stamp[:10], cell_id, views, uses),
    )
    _prune_hit_days(conn, stamp[:10])
    conn.commit()
    # A fresh count is worth showing: the next picker open must not reuse the
    # ranking that was built before it.
    with _popular_lock:
        _popular_cache.clear()
    return True


def popular_cells(conn: sqlite3.Connection, limit: int = 5) -> list[str]:
    """The cell ids opened or used most often, for the picker's shortcut.

    Ranked from the anonymous counters, so it reflects every visitor instead of
    only those who allowed the identified usage log. A deployment that has not
    recorded a hit yet — or was upgraded from a version that had no counters —
    falls back to ranking the activity log, so the shortcut is never blank.

    Only ids leave this function: nothing here is about a person. The answer is
    reused for a minute inside the process, because the picker asks on every
    open and a hosted database charges a round trip for each query.
    """
    limit = max(1, min(int(limit), 20))
    now = time.monotonic()
    with _popular_lock:
        cached = _popular_cache.get(limit)
        if cached and now - cached[0] < POPULAR_TTL:
            return list(cached[1])
    rows = conn.execute(
        f"""SELECT cell_id FROM cell_hits
             ORDER BY {POPULAR_RANKING} DESC, last_at DESC, cell_id ASC
             LIMIT ?""",
        (limit,),
    ).fetchall()
    ids = [row["cell_id"] for row in rows]
    if not ids:
        rows = conn.execute(
            """SELECT cell_id, COUNT(*) AS n, MAX(created_at) AS last_at
                 FROM activity
                WHERE cell_id IS NOT NULL AND kind IN ('view', 'use')
                GROUP BY cell_id
                ORDER BY n DESC, last_at DESC, cell_id ASC
                LIMIT ?""",
            (limit,),
        ).fetchall()
        ids = [row["cell_id"] for row in rows]
    with _popular_lock:
        _popular_cache[limit] = (now, list(ids))
    return ids


def _prune_hit_days(conn: sqlite3.Connection, today: str) -> None:
    """Drop daily buckets past the retention, at most once an hour.

    A row counts a cell per day, not a visitor, so a year of history is still a
    few numbers per cell; the prune only stops the table growing forever.
    """
    global _hit_pruned_at
    now = time.monotonic()
    if now - _hit_pruned_at < 3600:
        return
    _hit_pruned_at = now
    cutoff = (
        datetime.strptime(today, "%Y-%m-%d") - timedelta(days=HIT_DAYS_KEPT)
    ).strftime("%Y-%m-%d")
    conn.execute("DELETE FROM cell_day_hits WHERE day < ?", (cutoff,))


def popular_totals(conn: sqlite3.Connection, limit: int = 5, days: int | None = None) -> list[dict]:
    """The anonymous counters themselves, for the dashboard's cells panel.

    `days` ranks that rolling window from the daily buckets. Without it the
    all-time totals are used — what the picker reads, and what an upgraded
    deployment starts with.
    """
    limit = max(1, min(int(limit), 20))
    if days:
        rows = conn.execute(
            f"""SELECT cell_id, SUM(views) AS views, SUM(uses) AS uses
                 FROM cell_day_hits WHERE day >= ?
                 GROUP BY cell_id
                 ORDER BY {POPULAR_RANKING_DAY} DESC, MAX(day) DESC, cell_id ASC
                 LIMIT ?""",
            (_ago(days=days)[:10], limit),
        )
    else:
        rows = conn.execute(
            f"""SELECT cell_id, views, uses FROM cell_hits
                 ORDER BY {POPULAR_RANKING} DESC, last_at DESC, cell_id ASC
                 LIMIT ?""",
            (limit,),
        )
    return [
        {
            "id": row["cell_id"],
            "views": int(row["views"] or 0),
            "uses": int(row["uses"] or 0),
            "total": int(row["views"] or 0) + int(row["uses"] or 0),
        }
        for row in rows
    ]


def email_off(conn: sqlite3.Connection, user_id: int) -> bool:
    """True when this account asked us to stop sending account email."""
    row = conn.execute("SELECT email_opt_out FROM users WHERE id = ?", (user_id,)).fetchone()
    return bool(row and row["email_opt_out"])


def set_email_off(conn: sqlite3.Connection, user_id: int, off: bool) -> dict:
    """Turn account email on or off for one account.

    Password-reset links are sent even when this is off, because without them
    a forgotten password would lock the owner out of their own account; the
    account page says so before the switch is used. Nothing else is ever sent.
    """
    conn.execute("UPDATE users SET email_opt_out = ? WHERE id = ?", (1 if off else 0, user_id))
    add_event(conn, user_id, "email", "account email off" if off else "account email on")
    conn.commit()
    return get_user(conn, user_id)


def delete_visitor_activity(conn: sqlite3.Connection, visitor: str | None) -> int:
    """Delete every usage row tied to one anonymous browser id.

    The id is hashed the same way it was written, so nothing else can match:
    an unknown or malformed id simply deletes nothing.
    """
    guest = visitor_hash(visitor)
    if guest is None:
        return 0
    cur = conn.execute("DELETE FROM activity WHERE visitor = ? AND user_id IS NULL", (guest,))
    conn.commit()
    return cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0


def update_name(conn: sqlite3.Connection, user_id: int, name: str) -> dict:
    """Change the display name of an account."""
    name = (name or "").strip()[:80]
    if not name:
        raise ValueError("Name cannot be empty.")
    conn.execute("UPDATE users SET name = ? WHERE id = ?", (name, user_id))
    add_event(conn, user_id, "name", commit=True)
    return get_user(conn, user_id)


def update_profile(conn: sqlite3.Connection, user_id: int, name: str,
                   position: str, organisation: str) -> dict:
    """Change the name, position and company or university of an account.

    The same rules as sign-up: a name and a position are required, and the
    company or university may be emptied again if the person leaves it.
    """
    name = (name or "").strip()
    position = (position or "").strip()
    organisation = (organisation or "").strip()
    if not name:
        raise ValueError("Name cannot be empty.")
    if not position:
        raise ValueError("Tell us your position, for example student or engineer.")
    if len(name) > 80:
        raise ValueError("The name must have at most 80 characters.")
    if len(organisation) > 120:
        raise ValueError("The company or university must have at most 120 characters.")
    if len(position) > 80:
        raise ValueError("The position must have at most 80 characters.")
    conn.execute(
        "UPDATE users SET name = ?, position = ?, organisation = ? WHERE id = ?",
        (name, position, organisation, user_id),
    )
    add_event(conn, user_id, "name", commit=True)
    return get_user(conn, user_id)


def add_event(
    conn: sqlite3.Connection, user_id: int, kind: str, detail: str | None = None, commit: bool = True
) -> None:
    if kind not in EVENT_KINDS:
        raise ValueError("Unknown event kind.")
    detail = (detail or "").strip()[:160] or None
    conn.execute(
        "INSERT INTO events (user_id, kind, detail, created_at) VALUES (?, ?, ?, ?)",
        (user_id, kind, detail, _stamp()),
    )
    if commit:
        conn.commit()


def _kind_counts(conn: sqlite3.Connection, user_id: int) -> dict:
    rows = conn.execute(
        "SELECT kind, COUNT(*) AS n FROM events WHERE user_id = ? GROUP BY kind", (user_id,)
    ).fetchall()
    counts = {kind: 0 for kind in EVENT_KINDS}
    for row in rows:
        counts[row["kind"]] = row["n"]
    return counts


def user_stats(conn: sqlite3.Connection, user_id: int) -> dict:
    """Everything the account page shows for the signed-in user."""
    user = get_user(conn, user_id)
    if user is None:
        return {}
    counts = _kind_counts(conn, user_id)
    recent = [
        {
            "kind": row["kind"],
            "detail": row["detail"],
            "created_at": row["created_at"],
        }
        for row in conn.execute(
            """SELECT kind, detail, created_at FROM events
               WHERE user_id = ? ORDER BY id DESC LIMIT 8""",
            (user_id,),
        )
    ]
    return {
        "user": user,
        "counts": counts,
        "tool_events": sum(counts[kind] for kind in TOOL_KINDS),
        "recent": recent,
    }


ADMIN_WINDOWS = {"7": 7, "30": 30, "all": None}


def admin_window(key: str | None) -> tuple[str, int | None]:
    """Map a requested dashboard window onto a key and a number of days."""
    wanted = (key or "30").strip().lower()
    if wanted not in ADMIN_WINDOWS:
        wanted = "30"
    return wanted, ADMIN_WINDOWS[wanted]


def _months_between(start: date, end: date) -> list[str]:
    out, year, month = [], start.year, start.month
    while (year, month) <= (end.year, end.month):
        out.append(f"{year:04d}-{month:02d}")
        month += 1
        if month > 12:
            year, month = year + 1, 1
    return out


def admin_stats(conn: sqlite3.Connection, window: str | None = "30") -> dict:
    """The admin dashboard for one time window: totals, sign-ups, tool usage,
    the user table and the activity feed."""
    key, days = admin_window(window)
    since = _ago(days=days) if days else None
    label = "all time" if days is None else f"last {days} days"
    now = _stamp()
    day = _ago(hours=24)

    def scoped(column: str) -> tuple[str, tuple]:
        """A WHERE fragment limiting a table to the window, and its arguments."""
        return (f" WHERE {column} >= ?", (since,)) if since else ("", ())

    # ---- totals: seven numbers, one query --------------------------------
    where, args = scoped("created_at")
    active_sql, active_args = (
        ("SELECT COUNT(*) FROM users WHERE last_seen_at >= ?", (since,))
        if since
        else ("SELECT COUNT(*) FROM users WHERE last_seen_at IS NOT NULL", ())
    )
    totals_row = conn.execute(
        "SELECT (SELECT COUNT(*) FROM users) AS users,"
        " (SELECT COUNT(*) FROM users WHERE role = 'admin') AS admins,"
        " (SELECT COUNT(*) FROM users WHERE email_verified = 1) AS verified,"
        " (SELECT COUNT(*) FROM users WHERE last_seen_at >= ?) AS active_24h,"
        f" ({active_sql}) AS active,"
        f" (SELECT COUNT(*) FROM users{where}) AS new_users,"
        f" (SELECT COUNT(*) FROM events{where}) AS events",
        (day,) + tuple(active_args) + tuple(args) + tuple(args),
    ).fetchone()
    totals = {
        # These describe the server, not the window.
        "users": int(totals_row["users"] or 0),
        "admins": int(totals_row["admins"] or 0),
        "verified": int(totals_row["verified"] or 0),
        "active_24h": int(totals_row["active_24h"] or 0),
        # These describe the window.
        "active": int(totals_row["active"] or 0),
        "new": int(totals_row["new_users"] or 0),
        "events": int(totals_row["events"] or 0),
        "generated_at": now,
    }

    today = datetime.now(timezone.utc).date()
    if days:
        unit = "day"
        order = [(today - timedelta(days=offset)).isoformat() for offset in range(days - 1, -1, -1)]
        rows = conn.execute(
            "SELECT substr(created_at, 1, 10) AS bucket, COUNT(*) AS n FROM users"
            + " WHERE created_at >= ? GROUP BY bucket",
            (since,),
        )
    else:
        unit = "month"
        first = conn.execute(
            """SELECT MIN(first) AS first FROM (
                   SELECT MIN(created_at) AS first FROM users
                   UNION ALL SELECT MIN(created_at) FROM activity)"""
        ).fetchone()["first"]
        start = date.fromisoformat(first[:10]) if first else today
        order = _months_between(start.replace(day=1), today.replace(day=1))
        rows = conn.execute(
            "SELECT substr(created_at, 1, 7) AS bucket, COUNT(*) AS n FROM users GROUP BY bucket"
        )
    by_bucket = {row["bucket"]: row["n"] for row in rows}
    signups = [{"date": bucket, "count": by_bucket.get(bucket, 0)} for bucket in order]

    # ---- tool opens by signed-in users (events) --------------------------
    kinds = ",".join("?" * len(TOOL_KINDS))
    usage_sql = (
        "SELECT kind, COUNT(*) AS count, COUNT(DISTINCT user_id) AS users, "
        "MAX(created_at) AS last_at FROM events"
        + (" WHERE created_at >= ? AND" if since else " WHERE")
        + f" kind IN ({kinds}) GROUP BY kind"
    )
    usage_args = ((since,) if since else ()) + tuple(TOOL_KINDS)
    usage_rows = {row["kind"]: row for row in conn.execute(usage_sql, usage_args)}

    # ---- the activity log (cells, visits, sign-up wall) ------------------
    def act(conds: tuple = (), cargs: tuple = ()) -> tuple[str, tuple]:
        """WHERE clause on `activity`: the given conditions plus the window."""
        parts = list(conds)
        values = list(cargs)
        if since:
            parts.append("created_at >= ?")
            values.append(since)
        return (" WHERE " + " AND ".join(parts) if parts else ""), tuple(values)

    USER = "user_id IS NOT NULL"
    GUEST = "user_id IS NULL"

    # Who is using the server: signed-in users next to anonymous visitors.
    # One grouped query, not nine: this used to be a round trip per number.
    clause, values = act()
    audience_row = {
        bool(row["is_user"]): row
        for row in conn.execute(
            f"""SELECT user_id IS NOT NULL AS is_user,
                       COUNT(DISTINCT user_id) AS users,
                       COUNT(DISTINCT visitor) AS visitors,
                       SUM(kind = 'visit') AS visits,
                       SUM(kind = 'view') AS views,
                       SUM(kind = 'use') AS uses,
                       SUM(kind = 'gate') AS gates,
                       COUNT(DISTINCT CASE WHEN kind IN ('view','use')
                                           THEN cell_id END) AS cells
                FROM activity{clause} GROUP BY user_id IS NOT NULL""",
            values,
        )
    }

    def audience_of(is_user: bool) -> dict:
        row = audience_row.get(is_user)
        if row is None:
            return {"people": 0, "visits": 0, "views": 0, "uses": 0,
                    "gates": 0, "cells": 0}
        return {
            "people": int((row["users"] if is_user else row["visitors"]) or 0),
            "visits": int(row["visits"] or 0),
            "views": int(row["views"] or 0),
            "uses": int(row["uses"] or 0),
            "gates": int(row["gates"] or 0),
            "cells": int(row["cells"] or 0),
        }

    audience = {
        "users": dict(audience_of(True),
                      opens=sum(int(r["count"]) for r in usage_rows.values())),
        "guests": audience_of(False),
    }

    # Visits per day (or month) for each audience.
    bucket_len = 10 if days else 7
    traffic_by = {}
    clause, values = act(("kind = 'visit'",))
    for row in conn.execute(
        f"""SELECT substr(created_at, 1, {bucket_len}) AS bucket,
                   user_id IS NOT NULL AS is_user, COUNT(*) AS n
            FROM activity{clause} GROUP BY bucket, is_user""",
        values,
    ):
        traffic_by.setdefault(row["bucket"], {})["users" if row["is_user"] else "guests"] = row["n"]
    traffic = [
        {
            "date": bucket,
            "users": traffic_by.get(bucket, {}).get("users", 0),
            "guests": traffic_by.get(bucket, {}).get("guests", 0),
        }
        for bucket in order
    ]

    # ---- per tool: opens, cell uses, sign-up wall hits, favourite cells --
    # Two queries for all six tools instead of three per tool.
    clause, values = act(("tool IS NOT NULL",))
    per_tool = {
        row["tool"]: row
        for row in conn.execute(
            f"""SELECT tool, SUM(kind = 'use') AS cell_uses,
                       SUM(kind = 'gate' AND user_id IS NULL) AS guest_gates
                FROM activity{clause} GROUP BY tool""",
            values,
        )
    }
    clause, values = act(("kind = 'use'", "cell_id IS NOT NULL", "tool IS NOT NULL"))
    per_tool_cells: dict[str, list] = {}
    for row in conn.execute(
        f"""SELECT tool, cell_id, MAX(cell_name) AS name, COUNT(*) AS n,
                   COUNT(DISTINCT user_id) AS users,
                   COUNT(DISTINCT visitor) AS guests
            FROM activity{clause} GROUP BY tool, cell_id ORDER BY n DESC""",
        values,
    ):
        bucket = per_tool_cells.setdefault(row["tool"], [])
        if len(bucket) < 5:
            bucket.append(
                {
                    "id": row["cell_id"],
                    "name": row["name"] or row["cell_id"],
                    # `count` ranks the row (views + uses); `uses` and `views`
                    # are what the dashboard prints, so a view is never called
                    # a use.
                    "count": row["n"],
                    "uses": row["n"],
                    "views": 0,
                    "users": row["users"],
                    "guests": row["guests"],
                }
            )

    tools = []
    for kind in TOOL_KINDS:
        row = usage_rows.get(kind)
        use_row = per_tool.get(kind)
        tools.append(
            {
                "kind": kind,
                "opens": int(row["count"]) if row else 0,
                "users": int(row["users"]) if row else 0,
                "last_at": row["last_at"] if row else None,
                "cell_uses": int(use_row["cell_uses"] or 0) if use_row else 0,
                "guest_gates": int(use_row["guest_gates"] or 0) if use_row else 0,
                "top_cells": per_tool_cells.get(kind, []),
            }
        )

    # ---- cells: overall, and by audience ---------------------------------
    clause, values = act(("cell_id IS NOT NULL", "kind IN ('view','use')"))
    overall = []
    tool_cols = ",\n".join(
        f"                   SUM(kind = 'use' AND tool = '{k}') AS {k}"
        for k in TOOL_KINDS
    )
    for row in conn.execute(
        f"""SELECT cell_id, MAX(cell_name) AS name,
                   SUM(kind = 'view') AS views, SUM(kind = 'use') AS uses,
                   SUM(kind = 'view' AND user_id IS NULL) AS guest_views,
                   COUNT(DISTINCT user_id) AS users, COUNT(DISTINCT visitor) AS guests,
{tool_cols},
                   COUNT(*) AS total
            FROM activity{clause}
            GROUP BY cell_id ORDER BY total DESC, name LIMIT 10""",
        values,
    ):
        overall.append(
            {
                "id": row["cell_id"],
                "name": row["name"] or row["cell_id"],
                "total": row["total"],
                "views": row["views"],
                "uses": row["uses"],
                "guest_views": row["guest_views"],
                "users": row["users"],
                "guests": row["guests"],
                "by_tool": {k: row[k] for k in TOOL_KINDS},
            }
        )
    # The same rows once more, split by audience: one query for both lists.
    by_audience: dict[bool, list] = {True: [], False: []}
    for row in conn.execute(
        f"""SELECT cell_id, MAX(cell_name) AS name, user_id IS NOT NULL AS is_user,
                   COUNT(*) AS n, SUM(kind = 'use') AS uses, SUM(kind = 'view') AS views,
                   COUNT(DISTINCT user_id) AS users, COUNT(DISTINCT visitor) AS guests
            FROM activity{clause} GROUP BY cell_id, user_id IS NOT NULL
            ORDER BY n DESC""",
        values,
    ):
        bucket = by_audience[bool(row["is_user"])]
        if len(bucket) < 5:
            bucket.append(
                {
                    "id": row["cell_id"],
                    "name": row["name"] or row["cell_id"],
                    "count": row["n"],
                    "uses": int(row["uses"] or 0),
                    "views": int(row["views"] or 0),
                    "users": row["users"],
                    "guests": row["guests"],
                }
            )

    # Anonymous popularity for this window, ranked from the daily buckets so the
    # 7- and 30-day chips change the cells too. Those buckets start with this
    # version, so a fresh window can be empty while the all-time totals are not:
    # fall back to those and say so, rather than blanking the panel.
    popular = popular_totals(conn, 10, days=days)
    popular_fallback = bool(days and not popular)
    if popular_fallback:
        popular = popular_totals(conn, 10)
    cells = {
        "overall": overall,
        "users": by_audience[True],
        "guests": by_audience[False],
        # The only popularity numbers that cover everybody, because they do not
        # depend on the cookie banner.
        "popular": popular,
        "popular_scope": "all time" if (not days or popular_fallback) else label,
        "popular_fallback": popular_fallback,
    }

    # ---- accounts: events per user and the cell each one favours ---------
    counts = {}
    for row in conn.execute(
        "SELECT user_id, kind, COUNT(*) AS n FROM events" + where + " GROUP BY user_id, kind",
        args,
    ):
        counts.setdefault(row["user_id"], {})[row["kind"]] = row["n"]

    favourite = {}
    clause, values = act(("user_id IS NOT NULL", "cell_id IS NOT NULL", "kind IN ('view','use')"))
    for row in conn.execute(
        f"""SELECT user_id, cell_id, MAX(cell_name) AS name, COUNT(*) AS n
            FROM activity{clause} GROUP BY user_id, cell_id ORDER BY n DESC""",
        values,
    ):
        favourite.setdefault(row["user_id"], {"name": row["name"] or row["cell_id"], "count": row["n"]})
    cell_uses = {}
    clause, values = act(("user_id IS NOT NULL", "kind = 'use'"))
    for row in conn.execute(
        f"SELECT user_id, COUNT(*) AS n FROM activity{clause} GROUP BY user_id", values
    ):
        cell_uses[row["user_id"]] = row["n"]

    users = []
    for row in conn.execute(
        """SELECT id, name, email, role, created_at, last_login_at, last_seen_at,
                  email_verified
           FROM users ORDER BY created_at DESC"""
    ):
        item = public_user(row)
        per_kind = counts.get(item["id"], {})
        item["events"] = {kind: per_kind.get(kind, 0) for kind in EVENT_KINDS}
        item["total_events"] = sum(per_kind.values())
        item["cell_uses"] = cell_uses.get(item["id"], 0)
        item["favourite_cell"] = favourite.get(item["id"])
        users.append(item)

    # ---- anonymous visitors ----------------------------------------------
    guest_list = []
    clause, values = act((GUEST, "visitor IS NOT NULL"))
    for row in conn.execute(
        f"""SELECT visitor, SUM(kind = 'visit') AS visits, SUM(kind = 'view') AS views,
                   SUM(kind = 'gate') AS gates, MAX(created_at) AS last_at,
                   MIN(created_at) AS first_at
            FROM activity{clause} GROUP BY visitor
            ORDER BY last_at DESC LIMIT 10""",
        values,
    ):
        guest_list.append(
            {
                "id": row["visitor"][:6],
                "visits": row["visits"],
                "views": row["views"],
                "gates": row["gates"],
                "first_at": row["first_at"],
                "last_at": row["last_at"],
            }
        )

    # ---- live feed: signed-in events and the activity log, newest first --
    feed = []
    for row in conn.execute(
        """SELECT e.kind, e.detail, e.created_at, u.name, u.email
           FROM events e JOIN users u ON u.id = e.user_id"""
        + (" WHERE e.created_at >= ?" if since else "")
        + " ORDER BY e.id DESC LIMIT 15",
        (since,) if since else (),
    ):
        tool_event = row["kind"] in TOOL_KINDS
        feed.append(
            {
                "who": row["name"] or row["email"],
                "audience": "user",
                "action": "open" if tool_event else "account",
                "tool": row["kind"] if tool_event else None,
                "detail": row["detail"] if not tool_event else None,
                "kind": row["kind"],
                "cell": None,
                "created_at": row["created_at"],
            }
        )
    clause, values = act()
    for row in conn.execute(
        f"""SELECT a.kind, a.tool, a.cell_name, a.cell_id, a.visitor, a.created_at, u.name, u.email
            FROM activity a LEFT JOIN users u ON u.id = a.user_id
            {clause.replace("created_at", "a.created_at")}
            ORDER BY a.id DESC LIMIT 15""",
        values,
    ):
        guest = row["visitor"] is not None and row["name"] is None and row["email"] is None
        feed.append(
            {
                "who": ("Guest " + row["visitor"][:6]) if guest else (row["name"] or row["email"]),
                "audience": "guest" if guest else "user",
                "action": row["kind"],
                "tool": row["tool"],
                "detail": None,
                "kind": row["kind"],
                "cell": row["cell_name"] or row["cell_id"],
                "created_at": row["created_at"],
            }
        )
    feed.sort(key=lambda item: item["created_at"], reverse=True)
    recent = feed[:15]

    # ---- activity per day -------------------------------------------------
    # The Activity panel carries its own filter (all time / last 30 / last 7
    # days), so this series deliberately ignores the dashboard window and
    # keeps history. It is capped at 92 days to keep the payload small.
    # Only the last 92 days can appear on the chart, so only those are read:
    # this used to aggregate every row the tables had ever held.
    keep_since = _ago(days=92)
    per_day: dict[str, dict[str, int]] = {}
    for row in conn.execute(
        """SELECT substr(created_at, 1, 10) AS day, user_id IS NOT NULL AS is_user,
                  COUNT(*) AS n FROM activity WHERE created_at >= ?
           GROUP BY day, is_user""",
        (keep_since,),
    ):
        bucket = per_day.setdefault(row["day"], {"users": 0, "guests": 0})
        bucket["users" if row["is_user"] else "guests"] += row["n"]
    # Signed-in tool opens live in `events`, not in the activity log.
    for row in conn.execute(
        """SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM events
           WHERE created_at >= ? GROUP BY day""",
        (keep_since,),
    ):
        per_day.setdefault(row["day"], {"users": 0, "guests": 0})["users"] += row["n"]

    activity = []
    activity_truncated = False
    if per_day:
        first_day = date.fromisoformat(min(per_day))
        span = (today - first_day).days + 1
        if span > 92:
            span, activity_truncated = 92, True
        for offset in range(span - 1, -1, -1):
            stamp = (today - timedelta(days=offset)).isoformat()
            bucket = per_day.get(stamp, {"users": 0, "guests": 0})
            activity.append({"date": stamp, "users": bucket["users"], "guests": bucket["guests"]})

    # The tool opened most in this window, with its share.
    top_tool = None
    if usage_rows:
        best_kind = max(usage_rows, key=lambda k: int(usage_rows[k]["count"]))
        row = usage_rows[best_kind]
        total_uses = sum(int(r["count"]) for r in usage_rows.values()) or 1
        top_tool = {
            "kind": best_kind,
            "count": int(row["count"]),
            "users": int(row["users"]),
            "last_at": row["last_at"],
            "share": round(int(row["count"]) / total_uses * 100, 1),
        }

    return {
        "window": {"key": key, "days": days, "label": label},
        # The address whose role comes from OBF_ADMIN_EMAIL, so the dashboard
        # can show why that row cannot be changed.
        "admin_email": admin_email(),
        "signup_unit": unit,
        "totals": totals,
        "audience": audience,
        "signups": signups,
        "traffic": traffic,
        "tools": tools,
        "cells": cells,
        "users": users,
        "guests": guest_list,
        "recent": recent,
        "top_tool": top_tool,
        "activity": activity,
        "activity_truncated": activity_truncated,
    }
