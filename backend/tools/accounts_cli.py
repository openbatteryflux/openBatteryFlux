#!/usr/bin/env python3
"""Inspect and administer the accounts database, local or hosted.

The API never needs this: it creates the schema on its first request. This is
for the jobs that are easier to do once, deliberately, from a terminal — before
strangers arrive, or after a deploy went wrong.

It talks to whatever accounts.configured() points at, so the same command works
against the local file and against the hosted Turso database the deployed site
uses. To reach the hosted one, export the credentials first (they are the two
variables Vercel has):

    export OBF_DATABASE_URL='turso://<database>-<org>.turso.io'
    export OBF_DATABASE_TOKEN='...'

Usage, from the project root:

    python3 backend/tools/accounts_cli.py check
    python3 backend/tools/accounts_cli.py list
    python3 backend/tools/accounts_cli.py ensure-admin --email you@example.com
    python3 backend/tools/accounts_cli.py delete --email someone@example.com --yes
    python3 backend/tools/accounts_cli.py purge --keep you@example.com --yes

`check` also creates the tables if they are missing, and reports what the
deployment still needs (an administrator address, working email delivery).

`ensure-admin` creates the account if it does not exist, or promotes and
re-verifies it if it does, and resets its password when you give one. The
password is read from `OBF_ADMIN_PASSWORD`, from a file with
`--password-file`, or typed twice at a prompt where it is not echoed — never
from the command line, which would keep it in your shell history.

`delete` removes one account and its sessions, events and activity — the way to
clear out an account you made while testing without touching everybody else's.
It prints what it would delete unless you pass `--yes`, and refuses to remove
the last administrator, since that would leave the dashboard unreachable.

`purge` deletes every account except the one you keep, together with its
sessions, events and activity. It prints what it would delete unless you pass
`--yes`.
"""
import argparse
import getpass
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.app import accounts, mail, remote_db  # noqa: E402


def _backend() -> str:
    """Where accounts are stored, in words that match the docs."""
    if remote_db.enabled():
        # The URL carries the database and organisation, the token is a secret.
        return "hosted database %s" % remote_db.url()
    return "local file %s" % accounts.database_path()


def _connect():
    try:
        return accounts.connect()
    except accounts.STORAGE_ERRORS as err:
        sys.exit("Cannot open %s\n  %s" % (_backend(), err))


def _count(conn, sql: str, args: tuple = ()) -> int:
    row = conn.execute(sql, args).fetchone()
    return row[0] if row else 0


def _user_by_email(conn, email: str):
    return conn.execute(
        "SELECT * FROM users WHERE email = ?", (email.strip().lower(),)
    ).fetchone()


def _normalise(email: str) -> str:
    email = (email or "").strip().lower()
    if "@" not in email or email.endswith("@") or len(email) > 254:
        sys.exit("%r is not an email address." % email)
    return email


# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------

def cmd_check(args) -> int:
    conn = _connect()
    try:
        users = _count(conn, "SELECT COUNT(*) FROM users")
        admins = _count(conn, "SELECT COUNT(*) FROM users WHERE role = 'admin'")
        unverified = _count(conn, "SELECT COUNT(*) FROM users WHERE email_verified = 0")
        sessions = _count(conn, "SELECT COUNT(*) FROM sessions")
        events = _count(conn, "SELECT COUNT(*) FROM events")
        activity = _count(conn, "SELECT COUNT(*) FROM activity")
    finally:
        conn.close()

    print("accounts store   %s" % _backend())
    print("tables           created / present")
    print("users            %d (%d admin, %d unverified)" % (users, admins, unverified))
    print("sessions         %d" % sessions)
    print("events           %d" % events)
    print("activity rows    %d" % activity)
    print("administrator    %s" % (accounts.admin_email() or "not set (OBF_ADMIN_EMAIL)"))
    print("email delivery   %s" % (
        "configured" if mail.configured()
        else "not configured - no verification link is sent, so new accounts "
             "stay locked until an administrator confirms them"))

    problems = []
    if not accounts.admin_email():
        problems.append(
            "Set OBF_ADMIN_EMAIL to the address that should hold the dashboard, "
            "otherwise whichever account signs up first becomes the administrator.")
    elif not admins:
        problems.append(
            "No account has the administrator role yet. Run:\n"
            "    python3 backend/tools/accounts_cli.py ensure-admin --email %s"
            % accounts.admin_email())
    if not mail.configured():
        problems.append(
            "Verification and password-reset emails cannot be sent. Set "
            "RESEND_API_KEY, OBF_MAIL_FROM and OBF_APP_ORIGIN on the host, or "
            "nobody can prove their address or recover a forgotten password."
            + ((" %d account(s) are waiting for a manual verification." % unverified)
               if unverified else ""))
    if problems:
        print()
        for problem in problems:
            print("! " + problem)
    return 0


def cmd_list(args) -> int:
    conn = _connect()
    try:
        rows = conn.execute(
            """SELECT id, email, role, email_verified, created_at, last_login_at
               FROM users ORDER BY id"""
        ).fetchall()
    finally:
        conn.close()
    if not rows:
        print("No accounts.")
        return 0
    print("%-4s %-38s %-6s %-9s %-19s %s" % ("id", "email", "role", "verified", "created", "last login"))
    for row in rows:
        print("%-4s %-38s %-6s %-9s %-19s %s" % (
            row["id"], row["email"], row["role"],
            "yes" if row["email_verified"] else "no",
            row["created_at"] or "", row["last_login_at"] or "never"))
    return 0


def _read_password(args, existing: bool) -> str | None:
    """The new password, or None to leave an existing one alone."""
    from_file = getattr(args, "password_file", None)
    if from_file:
        password = Path(from_file).read_text(encoding="utf-8").rstrip("\n")
    elif os.environ.get("OBF_ADMIN_PASSWORD"):
        password = os.environ["OBF_ADMIN_PASSWORD"]
    else:
        if existing and not getattr(args, "reset_password", False):
            return None
        password = getpass.getpass("New password: ")
        again = getpass.getpass("Repeat password: ")
        if password != again:
            sys.exit("The two passwords differ.")
    try:
        accounts.check_password(password)
    except ValueError as err:
        sys.exit(str(err))
    return password


def cmd_ensure_admin(args) -> int:
    email = _normalise(args.email)
    conn = _connect()
    try:
        row = _user_by_email(conn, email)
        password = _read_password(args, existing=row is not None)
        name = (args.name or "").strip() or email.split("@")[0]

        if row is None:
            if password is None:
                sys.exit("This account does not exist yet, so a password is required.")
            user_id, _role = accounts.signup(conn, name, email, password, verified=True)
            conn.execute("UPDATE users SET role = 'admin' WHERE id = ?", (user_id,))
            conn.commit()
            action = "created"
        else:
            user_id = row["id"]
            fields = ["role = 'admin'", "email_verified = 1",
                      "verify_token_hash = NULL", "verify_expires_at = NULL",
                      "reset_token_hash = NULL", "reset_expires_at = NULL"]
            values: list = []
            if name and name != row["name"]:
                fields.append("name = ?")
                values.append(name)
            if password is not None:
                fields.append("password_hash = ?")
                values.append(accounts.hash_password(password))
            values.append(user_id)
            conn.execute("UPDATE users SET %s WHERE id = ?" % ", ".join(fields), tuple(values))
            if password is not None:
                # A password change ends every open session.
                accounts.revoke_sessions(conn, user_id)
            conn.commit()
            action = "updated"

        user = accounts.get_user(conn, user_id)
    finally:
        conn.close()

    print("%s account %s (id %s)" % (action, user["email"], user["id"]))
    print("  name        %s" % user["name"])
    print("  role        %s" % user["role"])
    print("  verified    %s" % ("yes" if user["email_verified"] else "no"))
    print("  password    %s" % ("set" if password else "unchanged"))
    print("  store       %s" % _backend())
    if not accounts.admin_email():
        print("\n! OBF_ADMIN_EMAIL is not set here. Set it to %s on the host too, so "
              "the role survives and no other account can become the first "
              "administrator." % email)
    return 0


def cmd_delete(args) -> int:
    email = _normalise(args.email)
    conn = _connect()
    try:
        row = _user_by_email(conn, email)
        if row is None:
            sys.exit("There is no account for %s." % email)
        user_id = row["id"]
        if row["role"] == "admin" and _count(
                conn, "SELECT COUNT(*) FROM users WHERE role = 'admin'") == 1:
            sys.exit("%s is the only administrator. Promote another account with "
                     "ensure-admin first, then delete this one." % email)

        counts = {}
        for table in ("sessions", "events", "activity"):
            counts[table] = _count(conn, "SELECT COUNT(*) FROM %s WHERE user_id = ?" % table,
                                   (user_id,))
        rows = ", ".join("%s %d" % (k, v) for k, v in counts.items())

        if not args.yes:
            print("Would delete %s (id %s, %s) and its rows: %s." % (
                email, user_id, row["name"], rows))
            print("Re-run with --yes to do it.")
            return 2

        for table in ("sessions", "events", "activity"):
            conn.execute("DELETE FROM %s WHERE user_id = ?" % table, (user_id,))
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        # Nothing else can own a session once its user is gone; this also
        # clears rows left behind by a database written with foreign keys off.
        conn.execute("DELETE FROM sessions WHERE user_id NOT IN (SELECT id FROM users)")
        conn.commit()
        left = _count(conn, "SELECT COUNT(*) FROM users")
    finally:
        conn.close()

    print("Deleted %s (id %s): %s." % (email, user_id, rows))
    print("Accounts now: %d." % left)
    return 0


def cmd_purge(args) -> int:
    keep = _normalise(args.keep)
    conn = _connect()
    try:
        keeper = _user_by_email(conn, keep)
        if keeper is None:
            sys.exit("There is no account for %s, so there is nothing to keep. "
                     "Create it first with ensure-admin." % keep)
        keep_id = keeper["id"]
        doomed = [r["id"] for r in conn.execute(
            "SELECT id FROM users WHERE id != ?", (keep_id,))]
        if not doomed:
            print("Only %s exists. Nothing to delete." % keep)
            return 0

        counts = {}
        for table in ("sessions", "events", "activity"):
            counts[table] = _count(conn, "SELECT COUNT(*) FROM %s WHERE user_id != ?" % table,
                                   (keep_id,))

        if not args.yes:
            print("Would delete %d account(s) and their rows: %s." % (
                len(doomed), ", ".join("%s %d" % (k, v) for k, v in counts.items())))
            print("Kept: %s (id %s). Re-run with --yes to do it." % (keep, keep_id))
            return 2

        for table in ("sessions", "events", "activity"):
            conn.execute("DELETE FROM %s WHERE user_id != ?" % table, (keep_id,))
        conn.execute("DELETE FROM users WHERE id != ?", (keep_id,))
        # Nothing else can own a session once its user is gone; this also
        # clears rows left behind by a database written with foreign keys off.
        conn.execute("DELETE FROM sessions WHERE user_id NOT IN (SELECT id FROM users)")
        conn.commit()

        left = _count(conn, "SELECT COUNT(*) FROM users")
        print("Deleted %d account(s): %s." % (
            len(doomed), ", ".join("%s %d" % (k, v) for k, v in counts.items())))
        print("Kept %s (id %s). Accounts now: %d." % (keep, keep_id, left))
        if left != 1:
            print("! Expected one account to remain.")
    finally:
        conn.close()
    return 0


# ---------------------------------------------------------------------------

def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Inspect and administer the openBatteryFlux accounts database.")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("check", help="verify the store is reachable; create the tables").set_defaults(
        func=cmd_check)

    sub.add_parser("list", help="list accounts").set_defaults(func=cmd_list)

    admin = sub.add_parser("ensure-admin", help="create or promote the administrator")
    admin.add_argument("--email", default=os.environ.get("OBF_ADMIN_EMAIL", ""),
                       help="address of the administrator (default: OBF_ADMIN_EMAIL)")
    admin.add_argument("--name", default="", help="display name (default: the local part)")
    admin.add_argument("--password-file", default="",
                       help="read the password from this file instead of prompting")
    admin.add_argument("--reset-password", action="store_true",
                       help="ask for a new password even if the account exists")
    admin.set_defaults(func=cmd_ensure_admin)

    delete = sub.add_parser("delete", help="delete one account and its rows")
    delete.add_argument("--email", required=True, help="address of the account to delete")
    delete.add_argument("--yes", action="store_true",
                        help="actually delete; without it, only report")
    delete.set_defaults(func=cmd_delete)

    purge = sub.add_parser("purge", help="delete every account except one")
    purge.add_argument("--keep", default=os.environ.get("OBF_ADMIN_EMAIL", ""),
                       help="address to keep (default: OBF_ADMIN_EMAIL)")
    purge.add_argument("--yes", action="store_true", help="actually delete; without it, only report")
    purge.set_defaults(func=cmd_purge)

    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 2
    if args.command in ("ensure-admin", "purge") and not (args.email if args.command == "ensure-admin" else args.keep):
        sys.exit("Give an address with --email/--keep, or set OBF_ADMIN_EMAIL.")
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
