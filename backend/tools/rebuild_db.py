#!/usr/bin/env python3
"""Rebuild the app's cell database (backend/data/cells.db) from the merged CSV.

The merged CSV (scrapers/cells/cells.csv) carries far more per-cell information
than the app's 12-column schema. This tool:

  1. writes the `chemistries` table from backend/tools/chem_profiles.py - every
     chemistry with its datasheet window and its 101-point (1 % SOC) default
     OCV curve, including lmfp;
  2. recreates `cells` from the CSV with EVERY column in it, so the API returns
     the richer dataset;
  3. computes `name` as  "<brand> <model> · <capacity> Ah"  so the library
     displays brand + model + capacity (the app falls back to this when `name`
     is present, otherwise it would use only chemistry + form + capacity).
     A model that repeats its own brand is de-duplicated first, and a model that
     is nothing but the brand name leaves just the brand: "Samsung SDI · 94 Ah".

Usage:
    .venv/bin/python backend/tools/rebuild_db.py
    OBF_DB_PATH=/tmp/other.db .venv/bin/python backend/tools/rebuild_db.py
"""
import csv
import os
import re
import sqlite3
import sys
from pathlib import Path

import chem_profiles

ROOT = Path(__file__).resolve().parent.parent.parent
CSV = ROOT / "scrapers" / "cells" / "cells.csv"
DB = Path(os.environ.get("OBF_DB_PATH") or ROOT / "backend" / "data" / "cells.db")


def display_model(brand, model):
    """Drop the brand words a model repeats, so names stop stuttering.

    "Samsung SDI / 三星SDI" + "SDI"  -> ""      (brand alone is enough)
    "CATL / 宁德时代" + "CATL 811"    -> "811"

    Only *leading* words that already appear in the brand are dropped, so a part
    number like "INR21700-50E" or "NCR21700A" is never touched.
    """
    words = model.split()
    brand_words = set(re.findall(r"[a-z0-9]+", brand.lower()))
    cut = 0
    while cut < len(words):
        if re.sub(r"[^a-z0-9]", "", words[cut].lower()) not in brand_words:
            break
        cut += 1
    return " ".join(words[cut:])


def main():
    if not CSV.exists():
        sys.exit(f"merged CSV not found: {CSV}")

    # ---- load CSV ---------------------------------------------------------
    with CSV.open(newline="", encoding="utf-8") as fh:
        rd = csv.DictReader(fh)
        header = list(rd.fieldnames)
        rows = list(rd)

    # ---- current chemistries ----------------------------------------------
    chem_rows = chem_profiles.rows()

    # ---- write new DB ------------------------------------------------------
    if DB.exists():
        DB.unlink()
    DB.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB)
    cur = con.cursor()

    cur.execute("""CREATE TABLE chemistries (
        id TEXT PRIMARY KEY, name TEXT, sort_order INTEGER,
        nominal_v REAL, v_max REAL, v_min REAL, ocv_json TEXT,
        r_k REAL, r1_ratio REAL, tau_s REAL, arrhenius_b REAL,
        temp_min_c REAL, temp_max_c REAL)""")
    all_chems = chem_rows
    for c in all_chems:
        cur.execute(
            "INSERT INTO chemistries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [c["id"], c["name"], c["sort_order"], c["nominal_v"], c["v_max"],
             c["v_min"], c["ocv_json"], c["r_k"], c["r1_ratio"], c["tau_s"],
             c["arrhenius_b"], c["temp_min_c"], c["temp_max_c"]])

    cols = [f'"{h}"' for h in header]
    cur.execute(f"CREATE TABLE cells ({', '.join(cols)})")
    ins = f"INSERT INTO cells ({', '.join(cols)}) VALUES ({', '.join('?' * len(header))})"
    batch = []
    def cell_val(value):
        if value in ("", None):
            return None
        try:
            return float(value)
        except (TypeError, ValueError):
            return value

    for r in rows:
        vals = [r[c] for c in header]
        if "name" in header:
            model = (r.get("model") or "").strip()
            brand = str(r.get("brand") or "").split(" / ")[0].strip()
            model = display_model(brand, model)
            cap = r.get("capacity_ah") or ""
            head = " ".join(part for part in (brand, model) if part)
            vals[header.index("name")] = f"{head} · {cap} Ah"
        batch.append([cell_val(v) for v in vals])
    cur.executemany(ins, batch)
    cur.execute("CREATE INDEX idx_cells_chemistry ON cells(chemistry)")
    cur.execute("CREATE INDEX idx_cells_id ON cells(id)")
    # compat view used by backend/tools/import_cells.py list/export
    cur.execute("""
        CREATE VIEW cells_overview AS
        SELECT c.id, COALESCE(NULLIF(trim(c.name), ''), c.model) AS display_name,
               c.chemistry, c.capacity_ah, c.mass_g
        FROM cells c
    """)
    con.commit()

    n_cells = cur.execute("SELECT COUNT(*) FROM cells").fetchone()[0]
    n_chems = cur.execute("SELECT COUNT(*) FROM chemistries").fetchone()[0]
    from collections import Counter
    chem_dist = dict(Counter(r["chemistry"] for r in rows))
    con.close()
    print(f"wrote {DB}")
    print(f"  cells: {n_cells}  chemistries: {n_chems}")
    print("  chemistry distribution:", chem_dist)
    # a cell whose chemistry has no profile cannot be simulated: say so loudly
    unknown = sorted({r.get("chemistry") for r in rows} - {c["id"] for c in chem_rows})
    if unknown:
        print("  WARNING: cells with no chemistry profile:", ", ".join(unknown))
    print("  name example:", rows[0]["model"])


if __name__ == "__main__":
    main()
