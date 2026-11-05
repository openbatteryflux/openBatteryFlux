"""Read-only access to the cell database (backend/data/cells.db)."""
import json
import logging
import os
import sqlite3
from pathlib import Path

log = logging.getLogger("openbatteryflux.db")


def database_path() -> Path:
    configured = os.environ.get("OBF_DB_PATH")
    if configured:
        return Path(configured)
    return Path(__file__).resolve().parent.parent / "data" / "cells.db"


def connect() -> sqlite3.Connection:
    """Open the database read-only: the API never writes, so a bad edit can
    never be overwritten by the server."""
    path = database_path()
    if not path.exists():
        raise FileNotFoundError(
            "Cell database not found at %s (set OBF_DB_PATH to change it)." % path
        )
    conn = sqlite3.connect("file:%s?mode=ro" % path.resolve().as_posix(), uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def chemistries(conn: sqlite3.Connection) -> list:
    rows = conn.execute(
        """SELECT id, name, nominal_v, v_max, v_min, ocv_json, r_k, r1_ratio,
                  tau_s, arrhenius_b, temp_min_c, temp_max_c
           FROM chemistries ORDER BY sort_order, name"""
    ).fetchall()
    out = []
    for row in rows:
        item = dict(row)
        try:
            ocv = json.loads(item.pop("ocv_json"))
            item["ocv"] = [float(v) for v in ocv]
        except (ValueError, TypeError) as err:
            log.warning("Chemistry %s has an invalid ocv_json and was skipped: %s",
                        item.get("id"), err)
            continue
        if len(item["ocv"]) < 2:
            log.warning("Chemistry %s needs at least 2 OCV points; it was skipped.",
                        item.get("id"))
            continue
        out.append(item)
    return out


# richer columns now present in cells.db (added by backend/tools/rebuild_db.py)
CELL_FIELDS = (
    "id, chemistry, chemistry_detail, cathode, anode, brand, country, release,"
    "model, name, form, kind, capacity_ah, mass_g, max_c_rate, resistance_factor,"
    "nominal_voltage_v, ocv_v, cutoff_voltage_v, specific_energy_wh_kg_calc,"
    "specific_power_w_kg, energy_wh, cycle_life_cycles, coverage, notes,"
    "length_mm, width_mm, thickness_mm, diameter_mm, volume_ccm,"
    "internal_resistance_ac_mohm, data_flags"
)


def cells(conn: sqlite3.Connection, cell_id: str = None) -> list:
    sql = f"SELECT {CELL_FIELDS} FROM cells"
    args = ()
    if cell_id is not None:
        sql += " WHERE id = ?"
        args = (cell_id,)
    sql += " ORDER BY chemistry, id"
    rows = conn.execute(sql, args)
    return [dict(row) for row in rows]


def library() -> dict:
    conn = connect()
    try:
        return {"chemistries": chemistries(conn), "cells": cells(conn)}
    finally:
        conn.close()
