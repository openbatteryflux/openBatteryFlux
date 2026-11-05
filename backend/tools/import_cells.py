#!/usr/bin/env python3
"""List, export or import the cells stored in backend/data/cells.db.

The app reads the SQLite database directly, so anything you change here is live
as soon as you reload the page.

Usage (run from the project root; Python 3 is enough, no packages needed):

    python3 backend/tools/import_cells.py list
    python3 backend/tools/import_cells.py export cells.csv
    python3 backend/tools/import_cells.py import cells.csv
    python3 backend/tools/import_cells.py import cells.csv --prune

`export` writes one row per cell. Edit it in Excel, Numbers or any text editor,
then `import` writes the rows back (matched on the id column).
`--prune` also deletes cells that are missing from the file; without it they
stay in the database.

CSV columns:
    id, chemistry, brand, name, form, kind, capacity_ah, mass_g,
    max_c_rate, resistance_factor, coverage, notes

Only id, chemistry, capacity_ah and mass_g are required. `chemistry` must be
one of the ids in the chemistries table (`nmc`, `nca`, `lfp`, `lmfp`, `lco`,
`na`, `lto`, `lmb`, `alkaline` in the shipped database).
"""
import argparse
import csv
import os
import sqlite3
import sys
from pathlib import Path

FIELDS = [
    "id", "chemistry", "brand", "name", "form", "kind", "capacity_ah",
    "mass_g", "max_c_rate", "resistance_factor", "coverage", "notes",
]
NUMBERS = ["capacity_ah", "mass_g", "max_c_rate", "resistance_factor"]
REQUIRED = ["id", "chemistry", "capacity_ah", "mass_g"]


def database_path():
    return Path(os.environ.get("OBF_DB_PATH") or
                Path(__file__).resolve().parent.parent / "data" / "cells.db")


def connect():
    path = database_path()
    if not path.exists():
        sys.exit("Database not found: %s\nRun the app once, or restore backend/data/cells.db." % path)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def clean(row, chemistries):
    out = {}
    for key in FIELDS:
        value = (row.get(key) or "").strip()
        out[key] = value or None
    for key in REQUIRED:
        if not out[key]:
            raise ValueError("column '%s' is empty" % key)
    chemistry = out["chemistry"]
    if chemistry not in chemistries:
        raise ValueError("unknown chemistry '%s' (use one of: %s)" %
                         (chemistry, ", ".join(sorted(chemistries))))
    for key in NUMBERS:
        if key in ("max_c_rate", "resistance_factor") and not out[key]:
            out[key] = "1"
        try:
            out[key] = float(out[key])
        except (TypeError, ValueError):
            raise ValueError("column '%s' must be a number, got %r" % (key, out[key]))
    if out["capacity_ah"] <= 0:
        raise ValueError("capacity_ah must be greater than 0")
    if out["mass_g"] <= 0:
        raise ValueError("mass_g must be greater than 0")
    if out["max_c_rate"] <= 0:
        raise ValueError("max_c_rate must be greater than 0")
    if out["coverage"]:
        try:
            out["coverage"] = int(float(out["coverage"]))
        except ValueError:
            raise ValueError("coverage must be a number")
    else:
        out["coverage"] = 50
    return out


def cmd_list(conn):
    rows = conn.execute(
        "SELECT id, display_name, chemistry, capacity_ah, mass_g "
        "FROM cells_overview ORDER BY chemistry, id"
    ).fetchall()
    print("%-16s %-26s %-6s %8s %8s" % ("id", "name", "chem", "Ah", "g"))
    for r in rows:
        print("%-16s %-26s %-6s %8.2f %8.1f" % (r["id"], r["display_name"], r["chemistry"],
                                                r["capacity_ah"], r["mass_g"]))
    print("\n%d cells" % len(rows))


def cmd_export(conn, target):
    path = Path(target)
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=FIELDS)
        writer.writeheader()
        for r in conn.execute("SELECT %s FROM cells ORDER BY chemistry, id" % ", ".join(FIELDS)):
            writer.writerow({k: ("" if r[k] is None else r[k]) for k in FIELDS})
    print("Wrote %s" % path.resolve())


def cmd_import(conn, source, prune):
    path = Path(source)
    if not path.exists():
        sys.exit("CSV not found: %s" % path)
    chemistries = {r[0] for r in conn.execute("SELECT id FROM chemistries")}
    with path.open(newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        missing = [f for f in REQUIRED if f not in (reader.fieldnames or [])]
        if missing:
            sys.exit("The CSV needs these columns: %s" % ", ".join(REQUIRED))
        rows, errors = [], []
        for line, raw in enumerate(reader, start=2):
            try:
                rows.append(clean(raw, chemistries))
            except ValueError as err:
                errors.append("line %d: %s" % (line, err))
    if errors:
        print("Nothing was changed. Fix these rows first:", file=sys.stderr)
        for e in errors[:20]:
            print("  " + e, file=sys.stderr)
        sys.exit(1)
    if not rows:
        sys.exit("The CSV has no data rows, so nothing was changed.")

    columns = FIELDS
    updates = ", ".join("%s = excluded.%s" % (c, c) for c in columns if c != "id")
    sql = ("INSERT INTO cells (%s) VALUES (%s) ON CONFLICT(id) DO UPDATE SET %s"
           % (", ".join(columns), ", ".join("?" * len(columns)), updates))
    with conn:
        conn.executemany(sql, [[r[c] for c in columns] for r in rows])
        removed = 0
        if prune:
            ids = [r["id"] for r in rows]
            marks = ", ".join("?" * len(ids)) or "''"
            removed = conn.execute("DELETE FROM cells WHERE id NOT IN (%s)" % marks, ids).rowcount
    print("Imported %d rows from %s%s." %
          (len(rows), path.resolve(), (", removed %d stale rows" % removed) if prune else ""))
    cmd_list(conn)


def main():
    parser = argparse.ArgumentParser(description="Manage the openBatteryFlux cell database.")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list", help="show the cells in the database")
    export = sub.add_parser("export", help="write all cells to a CSV file")
    export.add_argument("file", help="CSV file to write, e.g. cells.csv")
    imp = sub.add_parser("import", help="add or update cells from a CSV file")
    imp.add_argument("file", help="CSV file to read, e.g. cells.csv")
    imp.add_argument("--prune", action="store_true",
                     help="also delete cells that are not in the CSV")
    args = parser.parse_args()

    conn = connect()
    try:
        if args.command == "list":
            cmd_list(conn)
        elif args.command == "export":
            cmd_export(conn, args.file)
        else:
            cmd_import(conn, args.file, args.prune)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
