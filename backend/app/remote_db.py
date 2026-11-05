"""Where the accounts database lives.

By default accounts are kept in the local SQLite file (OBF_APP_DB_PATH, or
backend/data/app.db next to the code). That is what local development,
docker-compose and a VPS use, and it is the fastest option.

A serverless host gives the app a read-only filesystem apart from a scratch
/tmp, so no file can outlive the request. Set OBF_DATABASE_URL there instead and
accounts are kept in a hosted Turso database (libSQL): `turso_serverless` speaks
DB-API 2.0 over HTTP using only the standard library, so every statement in
accounts.py runs unchanged against it.

Recognised variables — the TURSO_* names are the ones Turso's own Vercel
integration writes, so either pair works:

    OBF_DATABASE_URL    / TURSO_DATABASE_URL     turso://<database>-<org>.turso.io
    OBF_DATABASE_TOKEN  / TURSO_AUTH_TOKEN

The cell library is not affected: it is read-only and ships inside the
deployment, so a read-only filesystem is exactly what it wants.
"""
from __future__ import annotations

import os

URL_VARS = ("OBF_DATABASE_URL", "TURSO_DATABASE_URL")
TOKEN_VARS = ("OBF_DATABASE_TOKEN", "TURSO_AUTH_TOKEN")


def _first(names: tuple[str, ...]) -> str:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""


def url() -> str:
    return _first(URL_VARS)


def token() -> str:
    return _first(TOKEN_VARS)


def enabled() -> bool:
    """True when a hosted database is configured, so no local file is used."""
    return bool(url())


def _driver():
    try:
        import turso_serverless
    except ImportError as err:  # pragma: no cover - configuration mistake
        raise RuntimeError(
            "OBF_DATABASE_URL is set but the turso_serverless driver is not "
            "installed. Install it with: pip install turso_serverless"
        ) from err
    return turso_serverless


def connect():
    """Open the hosted database with dict-like rows, as sqlite3 does here."""
    driver = _driver()
    conn = driver.connect(url(), auth_token=token() or None)
    conn.row_factory = driver.Row
    return conn


def error_types() -> tuple:
    """The exceptions the driver raises, so the API can answer with a 503."""
    try:
        import turso_serverless as driver
    except ImportError:
        return (RuntimeError,)
    return (driver.Error, RuntimeError)


def integrity_errors() -> tuple:
    """Constraint violations, for turning a duplicate email into a 409."""
    try:
        import turso_serverless as driver
    except ImportError:
        return ()
    return (driver.IntegrityError,)
