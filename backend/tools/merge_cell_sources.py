#!/usr/bin/env python3
"""Merge CellDB.xlsx + StateOfTheArt_BatteryCells_ISI_TUM.xlsx into one normalized
dataset that follows the openBatteryFlux cells.csv naming convention.

Output
    cells_merged.csv  -> normalized merged table
    cells_merged.xlsx -> same data, datasheet_url written as a real hyperlink

V2 changes (per project requirements)
    1. Chemistry is kept in two independent columns: `chemistry` (coarse app id,
       e.g. nmc/lfp/na/lco/...) and `chemistry_detail` (the detailed string as it
       appears in the sources, e.g. "NMC 811"). Two extra columns, `cathode` and
       `anode`, carry the electrode materials.
    2. `model` = the cell model/product number WITHOUT capacity embedded in the
       name (e.g. "IFP23140160-50Ah" -> "IFP23140160"); capacity stays in
       `capacity_ah`.
    3. `name` is intentionally left blank - the app generates the display name
       from model + form + capacity.
    4. `form` is categorical only: Prismatic | Pouch | Cylindrical | Blade (no
       numeric sizes; dimensions live in length_mm/.../diameter_mm).
    5. The `source` column is removed.
    6. Every row carries the platform minimums: id, chemistry, capacity_ah,
       mass_g. Where a value is genuinely absent it is filled with the best
       available public-spec data or a clearly flagged estimate (see `data_flags`
       and `mass_g_source`).
"""
import argparse
import csv
import math
import re
import unicodedata
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.styles import Font

ROOT = Path(__file__).resolve().parent.parent.parent
CELLDB = ROOT / "CellDB.xlsx"
TUM = ROOT / "StateOfTheArt_BatteryCells_ISI_TUM.xlsx"
OUT_DIR = ROOT / "scrapers" / "cells"
OUT_CSV = OUT_DIR / "cells.csv"
OUT_XLSX = OUT_DIR / "cells.xlsx"
CURATED = ROOT / "scrapers" / "data" / "curated_cells.json"

# ----------------------------------------------------------------------------
# Brand / company handling
# ----------------------------------------------------------------------------

TUM_BRAND_CANON = {
    "CALB": "CALB / 中创新航",
    "EVE Energy": "EVE Energy / 亿纬锂能",
    "Samsung SDI": "Samsung SDI / 三星SDI",
    "Panasonic": "Panasonic / 松下",
    "Lishen": "Lishen / 力神电池",
    "BAK": "BAK / 比克动力",
    "Molicel": "Molicel / 能元科技",
    "CATL": "CATL / 宁德时代",
    "Great Power": "Great Power / 鹏辉能源",
    "Sinopoly": "Sinopoly / 中聚电池",
    "LG Chem": "LG Energy Solution / LG新能源",
    "JIANGSU HIGEE": "HIGEE / 海基新能源",
    "Jiangsu FREY": "FREY / 江苏弗雷",
    "Yinglong": "Yinlong / 银隆",
    "GBS ZhEJIANG Systems": "GBS",
    "ATL - Amperex Technology": "ATL / 东莞新能源",
    "Neosonic Li-Polymer Energy": "Neosonic",
    "Yoku Energy (Shenzhen) Co": "Yoku / 深圳移客",
    "Wuhan Lisun Power Corp. Ltd": "Wuhan Lisun / 武汉力神",
}

# Same manufacturer written differently across sources (case, abbreviation,
# English-only vs English + Chinese, parent company). Value = canonical brand.
BRAND_CANON = {
    "BAK": "BAK / 比克动力",
    "A123": "A123 Systems",
    "TENPOWER / 天鹏": "Tenpower / 天鹏",
    "Keeppower": "KeepPower",
    "LinkData": "LINKDATA / 联动天翼",
    "Linkdata": "LINKDATA / 联动天翼",
    "Sunpower": "SunPower / 长虹三杰",
    "SVOLT": "SVOLT / 蜂巢能源",
    "Sunwoda": "Sunwoda / 欣旺达",
    "FREY": "FREY / 江苏弗雷",
    "Zhongna Energy / 众钠": "Zhongna Energy / 中钠",
    "REPT": "REPT BATTERO / 瑞浦兰钧",
    "E-One Moli Energy (Canada) Limited": "Molicel / 能元科技",
    "sinowatt": "Sinowatt",
    "Kayo battery co., ltd": "Kayo Battery Co., Ltd",
    "Guangzhou FULLRIVER Battery New Technology Co": "Guangzhou Fullriver Battery New Technology Co",
}


def canon_brand(brand):
    """Return the canonical brand string for a manufacturer alias."""
    b = str(brand or "").strip()
    return BRAND_CANON.get(b, b)


TUM_COMPANY_COUNTRY = {
    "Kokam": "South Korea",
    "Saft": "France",
    "Thunder-Sky": "China",
    "Amita Technologies": "Taiwan",
    "ENERTECH": "France",
    "Eagle Picher Technologies LLC": "USA",
    "EAS Batteries": "Germany",
    "A123": "USA",
    "Headway Group": "China",
    "BMZ / Sony": "Germany",
    "BMZ / TerraE": "Germany",
    "ENERDEL": "USA",
    "Hitachi": "Japan",
    "Zenlabs / Envia": "USA",
    "Melasta": "China",
    "ENAX": "Japan",
    "Auto Energy Technology Co": "Taiwan",
    "Gaia": "China",
    "HYB Battery Co": "China",
    "Kayo battery co., ltd": "China",
    "GS Yuasa Technology": "Japan",
    "Amprius / Wuxi Lead": "USA / China",
    "COSLIGHT": "China",
    "ECO POWER GROUP": "China",
    "GFB": "China",
    "CRJ Technology Limited": "China",
    "KeepPower": "China",
    "OSN": "China",
    "VAPCELL": "China",
    "SKI": "South Korea",
    "Keeppower": "China",
    "Hypercell": "Australia",
    "ELERIX": "France",
    "Advanced Electronics Energy": "China",
    "E-One Moli Energy (Canada) Limited": "Canada",
    "Battronix": "USA",
    "Optimum Battery Co Ltd": "Taiwan",
    "Chengdu Jianzhong Lithium Battery Company Ltd": "China",
    "Quallion LLC": "USA",
    "Guangzhou FULLRIVER Battery New Technology Co": "China",
    "Hangzhou Future Power Technology Co": "China",
    "Murata": "Japan",
    "Dongguan K-Tech New Energy": "China",
    "Tesla/Panasonic": "USA / Japan",
    "Eemb Co": "Taiwan",
    "General Electronics Battery Co": "Taiwan",
    "LECLANCH\u00c9": "Switzerland",
    "Wuhan Lisun": "China",
}

CELLDB_BRAND_BY_EN = {}
_cdb_wb = load_workbook(CELLDB, data_only=True, read_only=True)
_cdb_ws = _cdb_wb.worksheets[0]
_cdb_rows = list(_cdb_ws.iter_rows(values_only=True))
_cdb_header = _cdb_rows[0]
_BI = {name: i for i, name in enumerate(_cdb_header)}
for _r in _cdb_rows[1:]:
    _b = str(_r[_BI["Brand"]]).strip() if _r[_BI["Brand"]] else ""
    if _b:
        CELLDB_BRAND_BY_EN.setdefault(_b.split(" / ")[0].strip().lower(), _b)


# Home country for CellDB brands keyed by the English part of the brand
# ("English / 中文"). A CJK name implies China unless listed here; brands
# without a CJK name default via this map.
CELLDB_BRAND_COUNTRY = {
    "molicel": "Taiwan",
    "samsung sdi": "South Korea",
    "panasonic": "Japan",
    "lg energy solution": "South Korea",
    "zeus battery products": "USA",
    "frey": "China",
    "dnk": "China",
    "gbs": "China",
    "tesson": "China",
    "yuhuang": "China",
    "daoming": "China",
    "guanjia": "China",
    "hualiyuan": "China",
    "huaxing": "China",
    "xinhuiyuan": "China",
    "winston": "China",
    "seplos": "China",
    "taihang": "China",
    "natfound": "China",
    "gona(allgrand)": "China",
    "gona": "China",
    "gsp": "China",
    "sapt": "China",
    "yinlong": "China",
    "godsend": "China",
    "liao": "China",
    "mcnair": "China",
    "gsp": "China",
}


def brand_for(company, source):
    """Return a clean brand string WITHOUT country in parentheses. TUM companies
    map to the CellDB canonical 'English / 中文' style where possible, otherwise
    the plain company name."""
    if source == "CellDB":
        return str(company).strip()
    if company is None:
        return ""
    name = str(company).strip() or ""
    if not name or name.lower() in PLACEHOLDER:
        return ""
    canon = TUM_BRAND_CANON.get(name)
    if canon:
        return canon
    en = name.split(" / ")[0].strip().lower()
    found = CELLDB_BRAND_BY_EN.get(en)
    if found:
        return found
    return name


def country_for(company, source):
    """Home country for a CellDB brand or TUM company. CellDB brands that carry a
    Chinese name are Chinese unless a known exception applies; TUM companies use
    the TUM_COMPANY_COUNTRY table."""
    if source == "TUM":
        if company is None:
            return ""
        name = str(company).strip()
        c = TUM_COMPANY_COUNTRY.get(name)
        if c:
            return c
        canon = TUM_BRAND_CANON.get(name)
        return "China" if canon else ""
    # CellDB brand
    b = str(company).strip()
    if not b or b.lower() in PLACEHOLDER:
        return ""
    en = b.split(" / ")[0].strip().lower()
    if en in CELLDB_BRAND_COUNTRY:
        return CELLDB_BRAND_COUNTRY[en]
    # any brand with a Chinese name (contains CJK) is Chinese
    if re.search(r"[\u4e00-\u9fff]", b):
        return "China"
    return CELLDB_BRAND_COUNTRY.get(en, "")


# ----------------------------------------------------------------------------
# Parsing helpers
# ----------------------------------------------------------------------------

PLACEHOLDER = {"not provided", "not applicable", "not defined", "n/a", "none",
               "-", "", "\xa0", "not applicable ", "not defined "}


def clean(value):
    if value is None:
        return ""
    s = unicodedata.normalize("NFKC", str(value)).strip()
    s = s.replace("\xa0", " ")
    return s


def silent(text):
    """Return '' when the text is a placeholder ('Not provided', '-', ...)."""
    s = clean(text)
    if s.lower() in PLACEHOLDER:
        return ""
    return s


def first_number(text):
    if not text:
        return None
    m = re.search(r"\d+(?:[.,]\d+)*", str(text))
    if not m:
        return None
    return m.group(0).replace(",", "")


def to_float(text, default=None):
    if text is None:
        return default
    if isinstance(text, (int, float)):
        return float(text)
    s = clean(text)
    if s.lower() in PLACEHOLDER:
        return default
    n = first_number(s)
    return float(n) if n is not None else default


def parse_amp_str(text):
    if not text:
        return None
    s = clean(text)
    s = re.sub(r"Conditions and evidence.*$", "", s)
    n = first_number(s)
    return float(n) if n is not None else None


def parse_pulse(text):
    if not text:
        return None, None
    s = clean(text)
    s = re.sub(r"Conditions and evidence.*$", "", s)
    m = re.search(r"(\d+(?:[.,]\d+)*)\s*A\s*/\s*(\d+(?:[.,]\d+)*)?\s*s", s)
    if m:
        return float(m.group(1).replace(",", "")), (float(m.group(2).replace(",", "")) if m.group(2) else None)
    n = first_number(s)
    return (float(n) if n is not None else None, None)


def parse_internal_resistance(text):
    if not text:
        return None, None
    s = clean(text)
    s = re.sub(r"Conditions and evidence.*$", "", s)
    ac = dc = None
    if "dc" in s.lower():
        m = re.search(r"(\d+(?:[.,]\d+)*)\s*m\u03a9.*?dc", s, re.I) or \
            re.search(r"dc[^;]*?(\d+(?:[.,]\d+)*)\s*m\u03a9", s, re.I)
        if m:
            dc = float(m.group(1).replace(",", ""))
    if "ac" in s.lower():
        m = re.search(r"(\d+(?:[.,]\d+)*)\s*m\u03a9", s)
        if m:
            ac = float(m.group(1).replace(",", ""))
    if ac is None and dc is None:
        m = re.search(r"(\d+(?:[.,]\d+)*)\s*m\u03a9", s)
        if m:
            ac = float(m.group(1).replace(",", ""))
    return ac, dc


def parse_cycle_life(text):
    if not text:
        return None, None
    s = clean(text)
    s = re.sub(r"Conditions and evidence.*$", "", s)
    m = re.search(r"(\d+(?:[.,]\d+)*)\s*cycles?", s, re.I)
    cycles = float(m.group(1).replace(",", "")) if m else None
    e = re.search(r"eol\s*(\d+(?:\.\d+)?)\s*%", s, re.I)
    eol = float(e.group(1)) if e else None
    return cycles, eol


def parse_size_mm(text):
    """Best-effort parse of '173.9 × 48.8 × 170.7' or 'Ø60.35 × 145.83'."""
    if not text:
        return {}
    s = clean(text)
    s = re.sub(r"Conditions and evidence.*$", "", s)
    dims = {}
    if s.lower().startswith("\u00d8") or "\u00d8" in s[:3] or re.match(r"^\s*\u00d8", s):
        m = re.search(r"\u00d8\s*(\d+(?:\.\d+)?)\s*\u00d7\s*(\d+(?:\.\d+)?)", s)
        if m:
            dims["diameter_mm"] = float(m.group(1))
            dims["length_mm"] = float(m.group(2))
            return dims
    nums = [float(x.replace(",", "")) for x in re.findall(r"\d+(?:[.,]\d+)*", s)]
    if len(nums) >= 3:
        dims["length_mm"], dims["thickness_mm"], dims["width_mm"] = nums[0], nums[1], nums[2]
    elif len(nums) == 2 and "\u00d7" in s:
        dims["diameter_mm"], dims["length_mm"] = nums[0], nums[1]
    return dims


def volume_ccm_from_dims(dims):
    """Approximate cell volume in cm**3 from parsed dimensions (mm)."""
    if dims.get("diameter_mm") and dims.get("length_mm"):
        r = dims["diameter_mm"] / 2.0
        return math.pi * r ** 2 * dims["length_mm"] / 1000.0
    if all(dims.get(k) for k in ("length_mm", "thickness_mm", "width_mm")):
        return dims["length_mm"] * dims["thickness_mm"] * dims["width_mm"] / 1000.0
    return None


# ----------------------------------------------------------------------------
# Chemistry handling
# ----------------------------------------------------------------------------

# Typical cathode / anode materials per coarse chemistry, refined by detail.
CATHODE = {
    "nmc": "LiNiMnCoO2 (NMC)",
    "nca": "LiNiCoAlO2 (NCA)",
    "lfp": "LiFePO4",
    "lmfp": "Li(Mn,Fe)PO4 (LMFP)",
    "lco": "LiCoO2 (LCO)",
    "lto": "LiMn2O4 or NMC oxide",
    "na": "Layered Na-oxide / Prussian blue",
    "lmb": "Ni-rich oxide (NMC/NCA)",
    "lmo": "LiMn2O4 (LMO)",
    "alkaline": "MnO2 (manganese dioxide)",
}
ANODE = {
    "nmc": "graphite",
    "nca": "graphite",
    "lfp": "graphite",
    "lmfp": "graphite",
    "lco": "graphite",
    "lto": "Li4Ti5O12 (LTO)",
    "na": "hard carbon",
    "lmb": "lithium metal",
    "lmo": "graphite",
    "alkaline": "zinc (Zn)",
}

# density used for volume-based mass estimation (g / cm**3 of cell volume)
FORM_DENSITY = {"Prismatic": 2.1, "Pouch": 2.1, "Cylindrical": 2.7, "Blade": 2.1}

# typical cell-level specific energy (Wh/kg) for energy-based mass estimation
TYP_WHKG = {"nmc": 220.0, "nca": 235.0, "lfp": 160.0, "lmfp": 175.0, "lco": 200.0,
            "lto": 95.0, "na": 125.0, "lmb": 300.0, "lmo": 180.0, "alkaline": 180.0}


def _raw_is_blank(chemistry_raw):
    return not chemistry_raw or clean(chemistry_raw).lower() in PLACEHOLDER


def infer_chemistry_from_model(model, chemistry_raw):
    """Return (coarse_id, detail) for CellDB rows (generic/blank values resolved
    from IEC 61960 prefixes + common manufacturer codes)."""
    m = (model or "").upper().replace(" ", "")
    if not _raw_is_blank(chemistry_raw):
        c = chemistry_raw.lower()
        if "lmfp" in c or "lifemn" in c or "lfp-m" in c or "manganese phosphate" in c:
            return "lmfp", chemistry_raw
        if "lfp" in c or "lifepo4" in c or "磷酸铁锂" in c:
            return "lfp", chemistry_raw if chemistry_raw.lower() != "lfp" else "LFP"
        if "nmc" in c or "ncm" in c:
            return "nmc", chemistry_raw
        if "nca" in c:
            return "nca", chemistry_raw
        if "lto" in c or "titanate" in c:
            return "lto", chemistry_raw
        if "lco" in c or "cobalt" in c:
            return "lco", chemistry_raw
        if "sodium" in c or "na-ion" in c or "naion" in c:
            return "na", chemistry_raw
        if "li-metal" in c or "lmb" in c:
            return "lmb", chemistry_raw
        if "lmo" in c or "manganese" in c or "spinel" in c:
            return "lmo", chemistry_raw
        if "li-ion" in c or "li ion" in c or c == "li-ion":
            pass
        else:
            return None, chemistry_raw
    if re.match(r"^(IFP|LFP|IFR|LPF)", m):
        return "lfp", "LFP"
    if re.match(r"^(LYP|LF\d|LFP)", m):
        return "lfp", "LFP"
    if "LYP" in m:
        return "lfp", "LYP"
    if re.match(r"^(NCR|NCA)", m):
        return "nca", "NCA"
    if re.match(r"^(INR|INP|ICR|NMC|NCM|MCN|IN)", m):
        return "nmc", "NMC"
    if re.match(r"^(NR|LR)\d{3,5}", m):
        return "nmc", "NMC"
    if re.match(r"^(LTO|IT)", m):
        return "lto", "LTO"
    if re.match(r"^(SIB|SBP|Na|NA|NACP|IFPNA)", m):
        return "na", "Na-ion"
    if re.match(r"^N\d{3,5}", m):
        return "nmc", "NMC"
    if re.match(r"^L\d+F", m):
        return "lfp", "LFP"
    if re.match(r"^L\d+N", m):
        return "nmc", "NMC"
    if re.match(r"^L\d+T", m):
        return "lto", "LTO"
    if "LMFP" in m or "LFP-M" in m or "LFMP" in m:
        return "lmfp", "LMFP"
    if "LFP" in m:
        return "lfp", "LFP"
    if "NCA" in m:
        return "nca", "NCA"
    if "NMC" in m or "NCM" in m:
        return "nmc", "NMC"
    return None, ""


def tum_coarse_chemistry(chemistry, detail):
    chem = clean(chemistry).lower()
    det = clean(detail)
    if det and det != "-":
        d = det.lower()
        for token, coarse in (("lco", "lco"), ("lto", "lto"), ("lfp", "lfp"),
                              ("nca", "nca"), ("nmc", "nmc"), ("lmfp", "lmfp")):
            if token in d:
                return coarse, det
    if "lfp" in chem:
        return "lfp", det if det and det != "-" else "LFP"
    if "lto" in chem:
        return "lto", det if det and det != "-" else "LTO"
    if "lco" in chem:
        return "lco", det if det and det != "-" else "LCO"
    if "ni-rich" in chem:
        return "nmc", det if det and det != "-" else "Ni-Rich (NMC)"
    return None, det


def pretty_detail(coarse, detail):
    if detail and detail.strip() not in ("-", ""):
        return detail.strip()
    return {"nmc": "NMC", "nca": "NCA", "lfp": "LFP", "lmfp": "LMFP", "na": "Na-ion",
            "lto": "LTO", "lco": "LCO", "lmb": "Li-metal", "lmo": "LMO"}.get(coarse, "")


def refine_electrodes(coarse, detail):
    """Return (cathode, anode) refined by a detailed chemistry string."""
    cathode = CATHODE.get(coarse, "")
    anode = ANODE.get(coarse, "")
    d = (detail or "").lower()
    if coarse == "nmc":
        if "811" in d:
            cathode = "LiNi0.8Mn0.1Co0.1O2 (NMC 811)"
        elif "622" in d:
            cathode = "LiNi0.6Mn0.2Co0.2O2 (NMC 622)"
        elif "532" in d:
            cathode = "LiNi0.5Mn0.3Co0.2O2 (NMC 532)"
    if "silicon" in d:
        anode = "silicon (Si) composite"
        if "nanowire" in d:
            anode = "silicon nanowire"
    return cathode, anode


# ----------------------------------------------------------------------------
# Kind / form
# ----------------------------------------------------------------------------

def kind_from_crate(crate):
    if crate is None:
        return ""
    if crate >= 3.5:
        return "Power"
    if crate <= 1.0:
        return "Energy"
    return "Balanced"


def normalize_form(factor_raw, cell_format_raw=None, size_text=""):
    f = clean(factor_raw or cell_format_raw).lower()
    if "prismatic" in f:
        return "Prismatic"
    if "pouch" in f:
        return "Pouch"
    if "blade" in f or "刀片" in f:
        return "Blade"
    if "cylindrical" in f or "圆柱" in f:
        return "Cylindrical"
    if f:
        return ""
    # inferred when the datasheet omits the form factor
    if "\u00d8" in clean(size_text):
        return "Cylindrical"
    if len(re.findall(r"\d+(?:\.\d+)?", clean(size_text))) >= 3:
        return "Prismatic"
    return ""


def strip_capacity_from_model(model):
    """Remove capacity from the model name so capacity lives only in
    capacity_ah. Handles 'IFP23140160-50Ah' -> 'IFP23140160',
    'FBTech IFR14500 600mAh 3.2V' -> 'IFR14500 3.2V',
    'WB-LYP400AHA' -> 'WB-LYP', 'GSP71173204F (170Ah sodium)' -> 'GSP71173204F'.
    Product codes without an Ah unit ('INR21700-30T') stay intact. A model that
    is *only* a capacity ('153AH', '35Ah') keeps the number without the unit."""
    s = clean(model)
    if not s:
        return s
    # pure-capacity model: '153AH'/'35Ah' -> number only
    m = re.match(r"^\s*(\d+(?:\.\d+)?)\s*(?:m)?ah\s*$", s, re.I)
    if m:
        return m.group(1)
    # parenthetical capacity annotation: "(170Ah sodium)" -> removed whole
    s = re.sub(r"\(\s*\d+(?:\.\d+)?\s*(?:m)?ah[^)]*\)", "", s, flags=re.I)
    # generic capacity token: optional leading sep, number, mAh/Ah, optional
    # single variant letter that is glued on (e.g. the 'A' in '400AHA')
    s = re.sub(r"(?i)(\s*[-/–]?\s*)\d+(?:\.\d+)?\s*(?:m)?ah(?:[a-z](?![a-z]))?",
               "", s)
    # collapse repeated separators / stray parens left behind (e.g. "(  sodium)")
    s = re.sub(r"\(\s*\)", "", s)
    s = re.sub(r"\s*[-/]\s*[-/]\s*", " / ", s)
    s = re.sub(r"\s{2,}", " ", s).strip(" -/")
    return s or clean(model)


# ----------------------------------------------------------------------------
# Coverage
# ----------------------------------------------------------------------------

def compute_coverage(row, key_fields):
    filled = sum(1 for k in key_fields if row.get(k) not in (None, "", 0.0, 0))
    return round(100 * filled / len(key_fields))


# ----------------------------------------------------------------------------
# Row extraction
# ----------------------------------------------------------------------------

BASE_FIELDS = ["id", "chemistry", "brand", "name", "form", "kind", "capacity_ah",
               "mass_g", "max_c_rate", "resistance_factor", "coverage", "notes"]

KEY_FIELDS = ["id", "chemistry", "brand", "form", "capacity_ah", "mass_g",
              "max_c_rate", "nominal_voltage_v", "cycle_life_cycles",
              "specific_energy_wh_kg_calc"]


def extract_celldb_rows():
    wb = load_workbook(CELLDB, data_only=True, read_only=False)
    ws = wb.worksheets[0]
    rows = list(ws.iter_rows())
    header = [c.value for c in rows[0]]
    I = {name: i for i, name in enumerate(header)}
    out = []
    for r in rows[1:]:
        get = lambda c: r[I[c]].value if I[c] < len(r) else None
        size_text = silent(get("Size (mm)"))
        model_raw = clean(get("Model"))
        model = strip_capacity_from_model(model_raw)
        cap_text = clean(get("Capacity"))
        capacity = to_float(cap_text)
        mass = parse_amp_str(str(get("Cell weight")))
        chem_raw = clean(get("Chemistry"))
        brand_text = clean(get("Brand"))
        coarse, detail = infer_chemistry_from_model(model_raw, chem_raw)
        if not coarse:
            brand_lfp = ("sinopoly", "hithium", "phylion", "narf")
            if any(b in brand_text.lower() for b in brand_lfp):
                coarse, detail = "lfp", detail or "LFP"
        if not coarse:
            # CHEMI-1: nominal-voltage hint used only as a fallback (flagged later)
            pass
        if coarse and not detail:
            detail = pretty_detail(coarse, detail)
        nom_v = to_float(get("Nominal V"))
        raw_form = clean(get("Form factor"))
        form = normalize_form(raw_form, size_text=size_text)
        if not form:
            # large storage cells (LFP 200 Ah GBS, NaP...) are prismatic
            form = "Prismatic"
        # keep the generic "Cylindrical" (numeric sizes live in dimensions)
        dims = parse_size_mm(size_text) if size_text else {}
        if form == "Cylindrical" and not dims.get("diameter_mm"):
            cyl = parse_size_mm(size_text)
            if cyl:
                dims = cyl
        max_dchg_a = parse_amp_str(str(get("Max continuous discharge")))
        max_chg_a = parse_amp_str(str(get("Max continuous charge")))
        pchg_a, pchg_s = parse_pulse(str(get("Max pulse charge")))
        pdchg_a, pdchg_s = parse_pulse(str(get("Max pulse discharge")))
        ir_ac, ir_dc = parse_internal_resistance(str(get("Internal resistance")))
        cycles, eol = parse_cycle_life(str(get("Cycle life")))
        max_c_rate = (max_dchg_a / capacity) if (max_dchg_a and capacity) else None
        cathode, anode = refine_electrodes(coarse, detail)
        row = {
            "_src": "CellDB",
            "brand": brand_for(get("Brand"), "CellDB"),
            "country": country_for(get("Brand"), "CellDB"),
            "release": "",
            "model": model,
            "name": "",                      # app generates the display name
            "form": form,
            "chemistry": coarse,
            "chemistry_detail": pretty_detail(coarse, detail),
            "cathode": cathode,
            "anode": anode,
            "capacity_ah": capacity,
            "mass_g": mass,
            "max_c_rate": max_c_rate,
            "nominal_voltage_v": nom_v,
            "max_discharge_a": max_dchg_a,
            "max_charge_a": max_chg_a,
            "pulse_charge_a": pchg_a,
            "pulse_discharge_a": pdchg_a,
            "pulse_duration_s": pchg_s or pdchg_s,
            "internal_resistance_ac_mohm": ir_ac,
            "internal_resistance_dc_mohm": ir_dc,
            "size_mm": size_text,
            "operating_temperature": silent(get("Operating temperature")),
            "cycle_life_cycles": cycles,
            "cycle_life_eol_pct": eol,
            "evidence": silent(get("Evidence")),
            "datasheet_url": "",
            "data_flags": "",
        }
        row.update({k: v for k, v in dims.items()})
        if nom_v and capacity:
            row["energy_wh"] = capacity * nom_v
            if mass:
                row["specific_energy_wh_kg_calc"] = row["energy_wh"] * 1000.0 / mass
        ir_ac_ohm = (ir_ac / 1000.0) if ir_ac else None
        row["resistance_factor"] = compute_resistance_factor(coarse, ir_ac_ohm, capacity)
        row["kind"] = kind_from_crate(max_c_rate)
        notes_parts = []
        for src, label in ((get("Cycle life"), "cycle life"),
                           (get("Nominal V"), "nominal"),
                           (get("Internal resistance"), "resistance"),
                           (get("Operating temperature"), "temperature")):
            s = silent(src)
            if s and "Conditions and evidence" not in s:
                notes_parts.append(f"{label}: {s}")
        row["notes"] = "; ".join(notes_parts)
        cell = r[I["View"]]
        if cell.hyperlink and cell.hyperlink.target:
            row["datasheet_url"] = cell.hyperlink.target
        out.append(row)
    return out


def extract_tum_rows():
    wb = load_workbook(TUM, data_only=True, read_only=True)
    ws = wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    header = rows[0]
    I = {name: i for i, name in enumerate(header)}
    out = []
    for r in rows[1:]:
        get = lambda c: r[I[c]] if I[c] < len(r) else None
        company = clean(get("Company"))
        product = strip_capacity_from_model(get("Product_Number"))
        coarse, detail = tum_coarse_chemistry(get("Chemistry"), get("Chemistry_Detail"))
        capacity = to_float(get("Capacity_Ah"))
        weight = to_float(get("Weight_gr"))
        max_dchg_crate = to_float(get("Discharge_MaxConstant_Crate")) or \
            (to_float(get("Discharge_MaxConstant_A")) / capacity if to_float(get("Discharge_MaxConstant_A")) and capacity else None)
        max_chg_crate = to_float(get("Charge_MaxConstant_Crate")) or None
        max_dchg_a = to_float(get("Discharge_MaxConstant_A"))
        sd_a = to_float(get("Discharge_Standard_A"))
        sc_a = to_float(get("Charge_Standard_A"))
        cycle_life = to_float(get("CycleLife"))
        residual = to_float(get("LastCycle_ResidualCapacity_%"))
        cathode, anode = refine_electrodes(coarse, detail)
        row = {
            "_src": "ISI_TUM",
            "brand": brand_for(company, "TUM"),
            "country": country_for(company, "TUM"),
            "release": to_float(get("Year")),
            "model": product,
            "name": "",
            "form": normalize_form(get("Cell_Format")),
            "chemistry": coarse,
            "chemistry_detail": pretty_detail(coarse, detail),
            "cathode": cathode,
            "anode": anode,
            "capacity_ah": capacity,
            "mass_g": weight,
            "max_c_rate": max_dchg_crate,
            "nominal_voltage_v": to_float(get("NomVoltage_Volt")),
            "ocv_v": to_float(get("OCV_Volt")),
            "cutoff_voltage_v": to_float(get("CutOff_Voltage_Volt")),
            "specific_energy_wh_kg_spec": to_float(get("SpecEnergy_WhKg_Spec")),
            "specific_energy_wh_kg_calc": to_float(get("SpecEnergy_WhKg_Calc")),
            "volumetric_energy_density_whl_spec": to_float(get("Vol_ED_WhL_Spec")),
            "volumetric_energy_density_whl_calc": to_float(get("Vol_ED_WhL_Calc")),
            "volume_ccm": to_float(get("Volume_Calc_ccm")),
            "max_discharge_a": max_dchg_a,
            "max_charge_a": to_float(get("Charge_MaxConstant_A")),
            "max_charge_c_rate": max_chg_crate,
            "charge_standard_a": sc_a,
            "charge_standard_c_rate": to_float(get("Charge_Standard_Crate")),
            "discharge_standard_a": sd_a,
            "discharge_standard_c_rate": to_float(get("Discharge_Standard_Crate")),
            "crate_discharge_cyclelife": to_float(get("Crate_Discharge_cyclelife")),
            "crate_charge_cyclelife": to_float(get("Crate_Charge_cyclelife")),
            "length_mm": to_float(get("Length_mm")),
            "thickness_mm": to_float(get("Thickness_Height_mm")),
            "width_mm": to_float(get("Width_mm")),
            "diameter_mm": to_float(get("Diameter_mm")),
            "year": to_float(get("Year")),
            "cycle_life_cycles": cycle_life,
            "residual_capacity_pct": residual,
            "datasheet_available": clean(get("DataSheet")) in ("x", "1", "yes", "y"),
            "secondary_source": clean(get("Secondary")) in ("x", "1", "yes", "y"),
            "document_id_date": silent(get("DocumentID_Date")),
            "charging_method": silent(get("Charging Methode")),
            "crate_cv_cutoff": silent(get("Crate_CV_cutoff")),
            "t_cycle_dod": to_float(get("t_cycle_DOD")),
            "t_rest_h": to_float(get("t_rest_h")),
            "notes": silent(get("Notes")),
            "data_flags": "",
        }
        if capacity and weight:
            row["energy_wh"] = capacity * (row["nominal_voltage_v"] or 3.6)
            if not row.get("specific_energy_wh_kg_calc"):
                row["specific_energy_wh_kg_calc"] = row["energy_wh"] * 1000.0 / weight
        row["internal_resistance_ac_mohm"] = None
        row["internal_resistance_dc_mohm"] = None
        row["resistance_factor"] = compute_resistance_factor(coarse, None, capacity)
        row["kind"] = kind_from_crate(max_dchg_crate)
        out.append(row)
    return out


R_K = {"nmc": 0.08, "nca": 0.084, "lfp": 0.04, "lmfp": 0.045, "na": 0.0585, "lto": 0.05, "lmb": 0.1}


def compute_resistance_factor(chemistry, ir_ohm, capacity_ah):
    """r0 = r_k * factor / Ah  =>  factor = r0 * Ah / r_k."""
    if not chemistry or ir_ohm is None or not capacity_ah:
        return None
    rk = R_K.get(chemistry)
    if not rk:
        return None
    return round(ir_ohm * capacity_ah / rk, 3)


# ----------------------------------------------------------------------------
# ID generation
# ----------------------------------------------------------------------------

def slugify(text, fallback="cell"):
    s = unicodedata.normalize("NFKD", text or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or fallback


# ----------------------------------------------------------------------------
# Token-based model matching (used by collapse_near_duplicates)
# ----------------------------------------------------------------------------

# Tokens that appear in many model names and do NOT distinguish cells:
# IEC 61960 chemistry prefixes, form-factor sizes and generic words.
_IEC_PREFIXES = ("inr", "icr", "ifr", "imr", "ncr", "nca", "lfr", "lmo",
                 "lco", "lfp", "nmc", "ncm", "lto", "na", "li")
_SIZES = ("18650", "21700", "26650", "26700", "26800", "32650", "32700",
          "32900", "38120", "40135", "42100", "46120", "4680", "4695",
          "46950", "46800", "2170", "1865", "14500", "16340", "18350",
          "18500", "22650", "25500", "26500", "32600", "32130", "34145",
          "34134", "46800")
_GENERIC_WORDS = {"battery", "cell", "rechargeable", "high", "power",
                  "energy", "series", "version", "gen", "type", "model",
                  "standard", "new", "plus", "pro", "max", "ultra",
                  "v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9",
                  "gen1", "gen2", "gen3", "gen4", "gen5", "gen6", "gen7",
                  "gen8", "gen9", "gen10"}

MERGE_CONFLICTS = []   # conflicting values found while merging duplicates


def _norm_model(m):
    n = slugify(m)
    return re.sub(r"[^a-z0-9]+", "", n)  # alnum only (dashes/separators)


def _model_tokens(model):
    s = unicodedata.normalize("NFKD", model or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    return [t for t in re.split(r"[^a-z0-9]+", s) if t]


def _is_generic_token(t):
    if t in _GENERIC_WORDS or t in _SIZES:
        return True
    for p in _IEC_PREFIXES:
        if t.startswith(p) and t[len(p):] in _SIZES:
            return True
    return False


def _core_tokens(model):
    """Distinguishing tokens of a model name (generic IEC/size tokens removed)."""
    return [t for t in _model_tokens(model) if not _is_generic_token(t)]


def _similar_model(a, b):
    """True when two model strings describe the same product code.

    Strict rules so distinct SKUs that merely share a generic prefix
    ('INR18650', '21700', ...) or a common base ('NCR18650B' vs
    'NCR18650BD') are NOT merged:
      1. equal after normalisation (separators ignored, trailing numbers
         stripped), e.g. 'INR21700M50L' == 'INR21700-M50L'
      2. every distinguishing token of the shorter model is present in the
         longer model, e.g. 'M50A' vs 'INR-21700-M50A', '25P' vs
         'INR18650/25P', 'L135F72' vs 'L135F72 (CAM72)'.
    """
    na, nb = _norm_model(a), _norm_model(b)
    if na == nb:
        return True
    ca, cb = _core_tokens(a), _core_tokens(b)
    if not ca or not cb:
        return False
    small, big = (ca, cb) if len(ca) <= len(cb) else (cb, ca)
    return all(t in big for t in small)


def _merge_dup(target, source):
    """Merge `source` into `target` (target survives); log conflicting values."""
    merged = merge_two(target, source)
    merged["data_flags"] = "; ".join(
        dict.fromkeys([f for f in (merged.get("data_flags") or "").split("; ")
                       if f] + ["merged-dup"]))
    # source-metadata fields are not physical properties: the model rename is
    # intentional (keep the more-token model) and URLs/evidence are per-source
    _META = ("_tum", "_cdb", "_src", "data_flags", "notes", "id", "model",
             "datasheet_url", "datasheet_available", "source",
             "secondary_source", "evidence", "document_id_date")
    for k, v in source.items():
        if k in _META:
            continue
        if v in (None, "", 0.0):
            continue
        cur = target.get(k)
        if cur in (None, "", 0.0):
            continue
        if str(cur).strip().lower() != str(v).strip().lower():
            MERGE_CONFLICTS.append({
                "id": target.get("id", ""),
                "brand": target.get("brand", ""),
                "model": target.get("model", ""),
                "field": k,
                "kept": cur,
                "merged": v,
            })
    return merged


def collapse_near_duplicates(rows):
    """Collapse rows that describe the same physical cell when they arrive from
    different sources with slightly different (nominal vs measured) capacities.

    Pass 1 (prefix): same brand + form + normalised model (trailing numbers
      stripped), capacities within 5% -> merge, keep the richer record.
    Pass 2 (token): same brand + form, capacities within 8% and the model
      names are token-equivalent (one is a token-subset of the other, e.g.
      'Molicel INR-21700-M50A' == 'Molicel M50A') -> merge, keep the model
      with MORE tokens (tie -> richer record).

    Distinct SKUs that share a common base but differ in capacity or in a
    distinguishing token (e.g. 18650 at 2.5/3.0/3.35 Ah, '40P' vs '40PL',
    'HG2' vs 'HJ2') are kept separate. Missing fields are filled from the
    merged row; conflicting values keep the survivor's and are logged to
    merge_conflicts.csv for review.
    """
    def _base_score(r):
        return sum(1 for k in ("capacity_ah", "mass_g", "max_c_rate",
                               "nominal_voltage_v", "specific_energy_wh_kg_calc",
                               "cycle_life_cycles", "length_mm", "diameter_mm")
                   if r.get(k))

    keep_ids = set(range(len(rows)))
    base_scores = [_base_score(r) for r in rows]

    def _apply(merged_into):
        for source, target in merged_into.items():
            if source not in keep_ids:
                continue
            # resolve chains (A->B, B->C  =>  A->C); guard against cycles
            seen = {source}
            while (target in merged_into and merged_into[target] != target
                   and target not in seen):
                seen.add(target)
                target = merged_into[target]
            if source == target:
                continue
            rows[target] = _merge_dup(rows[target], rows[source])
            keep_ids.discard(source)

    # ---- pass 1: exact / prefix model match ------------------------------
    groups = {}
    for i, r in enumerate(rows):
        key = (norm_brand_en(r["brand"]), slugify(r["form"]), _norm_model(r["model"]))
        groups.setdefault(key, []).append(i)

    for idxs in groups.values():
        if len(idxs) < 2:
            continue
        merged_into = {}
        for i in idxs:
            for j in idxs:
                if j <= i:
                    continue
                ci = rows[i].get("capacity_ah")
                cj = rows[j].get("capacity_ah")
                # equal normalised model = same cell; only conflicting capacities
                # (both present, beyond tolerance) block the merge
                if ci and cj and abs(float(ci) - float(cj)) / max(float(ci), float(cj)) > 0.05:
                    continue
                # pick the richer as the survivor (tie -> lower index)
                a, b = (i, j) if base_scores[i] >= base_scores[j] else (j, i)
                merged_into[b] = a
        _apply(merged_into)

    # ---- pass 2: token-subset model match --------------------------------
    groups2 = {}
    for i, r in enumerate(rows):
        key = (norm_brand_en(r["brand"]), slugify(r["form"]))
        groups2.setdefault(key, []).append(i)

    for idxs in groups2.values():
        if len(idxs) < 2:
            continue
        merged_into = {}
        for i in idxs:
            if i not in keep_ids:
                continue
            for j in idxs:
                if j <= i or j not in keep_ids:
                    continue
                ci = rows[i].get("capacity_ah")
                cj = rows[j].get("capacity_ah")
                # token-equivalent model = same cell; only conflicting capacities
                # (both present, beyond tolerance) block the merge
                if ci and cj and abs(float(ci) - float(cj)) / max(float(ci), float(cj)) > 0.08:
                    continue
                if not _similar_model(rows[i]["model"], rows[j]["model"]):
                    continue
                # keep the model with MORE tokens (user rule); tie -> richer
                ti = len(_model_tokens(rows[i]["model"]))
                tj = len(_model_tokens(rows[j]["model"]))
                if ti > tj:
                    a, b = i, j
                elif tj > ti:
                    a, b = j, i
                else:
                    a, b = (i, j) if base_scores[i] >= base_scores[j] else (j, i)
                merged_into[b] = a
        _apply(merged_into)

    out = [rows[i] for i in sorted(keep_ids)]
    print(f"collapse_near_duplicates: {len(rows)} -> {len(out)} "
          f"({len(rows)-len(out)} duplicates merged)")
    return out


def build_ids(rows):
    used = {}
    for row in rows:
        base = slugify(row["model"]) or "cell"
        brand = slugify(str(row["brand"]).split(" / ")[0])
        key = f"{brand}-{base}" if brand else base
        n = used.get(key, 0)
        used[key] = n + 1
        row["id"] = key if n == 0 else f"{key}-{n + 1}"


# ----------------------------------------------------------------------------
# Deduplication & cross-file merge
# ----------------------------------------------------------------------------

def norm_brand_en(brand):
    return slugify(str(brand).split(" / ")[0])


def dedupe_and_merge(all_rows):
    merged = {}
    exact_seen = {}
    for row in all_rows:
        key = (row["_src"], norm_brand_en(row["brand"]), slugify(row["model"]),
               round(row["capacity_ah"] or 0, 3), slugify(row["form"]))
        if key in exact_seen:
            continue
        exact_seen[key] = True
        cross = (norm_brand_en(row["brand"]), slugify(row["model"]),
                 round(row["capacity_ah"] or 0, 3), slugify(row["form"]))
        if cross in merged:
            merged[cross] = merge_two(merged[cross], row)
        else:
            merged[cross] = dict(row)
    result = list(merged.values())
    for row in result:
        if "_tum" in row:
            del row["_tum"]
        if "_cdb" in row:
            del row["_cdb"]
    return result


def merge_two(a, b):
    out = dict(a)
    out["_tum"] = (a.get("_tum") or a["_src"] == "ISI_TUM" or
                   b.get("_tum") or b["_src"] == "ISI_TUM")
    out["_cdb"] = (a.get("_cdb") or a["_src"] == "CellDB" or
                   b.get("_cdb") or b["_src"] == "CellDB")
    for k, v in b.items():
        if k in ("_tum", "_cdb", "_src"):
            continue
        if k == "brand":
            if a.get("brand") and b.get("brand"):
                out["brand"] = a["brand"] if " / " in str(a["brand"]) else b["brand"]
            continue
        if v in (None, "", 0.0):
            continue
        if k == "chemistry_detail":
            # keep the more specific / non-generic detail
            cur = out.get(k) or ""
            if cur in ("", "LFP", "NMC", "NCA", "LTO", "LCO", "Na-ion"):
                out[k] = v if v not in ("NMC", "NCA", "LFP", "LTO", "LCO", "Na-ion") else cur
            continue
        if out.get(k) in (None, "", 0.0):
            out[k] = v
        elif k == "notes":
            parts = [p.strip() for p in [str(out.get(k, "")), str(v)]
                     if p and p.strip() and p.strip().lower() not in PLACEHOLDER]
            out[k] = "; ".join(dict.fromkeys(parts))
    return out


# ----------------------------------------------------------------------------
# Enrichment (minimum required fields) - known public specs + estimates
# ----------------------------------------------------------------------------

# Well-known cells with published mass/chemistry (used when the sheets were
# missing those values). Keys are lowercased "brandslug|modelslug".
KNOWN_SPECS = {
    "lg-energy-solution|inr21700m50": dict(capacity_ah=5.0, mass_g=68.0, chemistry="nmc"),
    "lg-energy-solution|inr21700m50l": dict(capacity_ah=5.0, mass_g=68.0, chemistry="nmc"),
    "samsung-sdi|inr21700-30t": dict(mass_g=69.0),
    "samsung-sdi|inr21700-40t": dict(mass_g=69.0),
    "samsung-sdi|inr21700-50e": dict(mass_g=68.0),
    "molicel|inr21700-p42a": dict(mass_g=70.0),
    "molicel|inr21700-p45b": dict(mass_g=70.0),
    "molicel|inr18650-p28a": dict(mass_g=48.0),
    "molicel|inr18650-p26a": dict(mass_g=44.0),
    "molicel|inr21700-m50": dict(mass_g=68.0),
    "panasonic|ncr18650b": dict(mass_g=48.5),
    "panasonic|ncr18650a": dict(mass_g=46.5),
    "panasonic|ncr18650g": dict(mass_g=47.5),
    "panasonic|ncr21700a": dict(mass_g=70.0),
    "lg-energy-solution|lghg2": dict(mass_g=48.0),
    "lg-energy-solution|lgea1": dict(mass_g=48.0),
    "lg-energy-solution|lgmj1": dict(mass_g=49.0),
    "atp|lp18650": dict(mass_g=45.0),
}

# brand-only fallback -> chemistry for known LFP-only / NMC-only makers
BRAND_CHEMISTRY = {
    "sinopoly": "lfp",
    "hithium": "lfp",
    "phylion": "lfp",
    "rept battero": "lfp",
    "lishen": None,          # mixed portfolio - resolved via model prefix
    "svolt": None,
    "zenergy": None,
    "great power": None,
}

# brand|model -> chemistry for cells that could not be resolved otherwise.
# These are flagged as assumptions (data_flags), not datasheet facts.
MODEL_CHEMISTRY = {
    "zeus-battery-products|aa-size": "alkaline",
    "calb|se200fi": "lfp",
    "great-power|gsp09184165": "lfp",
    "great-power|gsp09185200": "lfp",
    "great-power|gsp27135206e": "lfp",
    "great-power|gsp34135214e": "lfp",
    "hualiyuan|26650": "lfp",
    "lishen|lp2714897": "nmc",
    "lishen|lp44147272": "nmc",
    "svolt|cl01": "lfp",
    "svolt|ce05": "nmc",
    "svolt|cp01": "nmc",
    "zenergy|5214895": "lfp",
    "baojia-battery|bj18650p": "nmc",
}

# nominal voltage (V) assumed per chemistry when the datasheet omits it; used
# only to derive energy / estimate mass, and flagged.
CHEM_NOM_V = {"lfp": 3.2, "lmfp": 3.6, "nmc": 3.6, "nca": 3.6, "lco": 3.7, "lto": 2.3,
              "na": 3.0, "lmb": 3.8, "lmo": 3.7, "alkaline": 1.5}

# cell voltage window per chemistry - mirrors the app's chemistries table
# (v_max / v_min) plus datasheet-typical LCO/LMO/Alkaline values.
CHEM_VMAX = {"lfp": 3.65, "lmfp": 4.2, "nmc": 4.2, "nca": 4.2, "lco": 4.2, "lto": 2.8,
             "na": 4.0, "lmb": 4.4, "lmo": 4.2, "alkaline": 1.6}
CHEM_VMIN = {"lfp": 2.0, "lmfp": 2.5, "nmc": 2.5, "nca": 2.5, "lco": 3.0, "lto": 1.5,
             "na": 1.8, "lmb": 3.0, "lmo": 3.0, "alkaline": 0.9}


def enrich_minimums(rows):
    """Guarantee platform minimums (id, chemistry, capacity_ah, mass_g):
    1) known public specs, 2) model-prefix chemistry, 3) volume/energy
    estimates for mass. Everything estimated is flagged in data_flags."""
    filled_mass, filled_chem, filled_cap = 0, 0, 0
    for row in rows:
        # keep the provenance a source brought with it (scraped rows, curated
        # rows) so enrichment only adds to it instead of replacing it
        flags = [f for f in str(row.get("data_flags") or "").split("; ") if f]
        # --- known specs (brand + model) ---
        bmat = (slugify(str(row["brand"]).split(" / ")[0]), slugify(row["model"]))
        spec = KNOWN_SPECS.get(f"{bmat[0]}|{bmat[1]}")
        if spec:
            for k, v in spec.items():
                if not row.get(k):
                    row[k] = v
                    if k == "mass_g":
                        filled_mass += 1
                    if k == "chemistry":
                        filled_chem += 1
                        row["chemistry_detail"] = pretty_detail(v, row.get("chemistry_detail"))
                        row["cathode"], row["anode"] = refine_electrodes(v, row.get("chemistry_detail"))
                    if k == "capacity_ah":
                        filled_cap += 1

        # --- chemistry fallbacks ---
        if not row.get("chemistry"):
            brand = norm_brand_en(row["brand"])
            model_key = f"{slugify(str(row['brand']).split(' / ')[0])}|{slugify(row['model'])}"
            model_chem = MODEL_CHEMISTRY.get(model_key) or \
                MODEL_CHEMISTRY.get(f"{brand}|{slugify(row['model'])}")
            if model_chem:
                row["chemistry"] = model_chem
                row["chemistry_detail"] = pretty_detail(model_chem, row.get("chemistry_detail"))
                row["cathode"], row["anode"] = refine_electrodes(model_chem, row.get("chemistry_detail"))
                flags.append(f"chemistry:model-assumed({row['model']})")
                filled_chem += 1
            elif BRAND_CHEMISTRY.get(brand):
                row["chemistry"] = BRAND_CHEMISTRY[brand]
                row["chemistry_detail"] = pretty_detail(row["chemistry"], "")
                row["cathode"], row["anode"] = refine_electrodes(row["chemistry"], "")
                flags.append("chemistry:brand-assumed")
                filled_chem += 1
            elif row.get("nominal_voltage_v"):
                v = row["nominal_voltage_v"]
                guess = None
                if abs(v - 3.2) < 0.15:
                    guess = "lfp"
                elif abs(v - 2.3) < 0.2:
                    guess = "lto"
                elif abs(v - 3.0) < 0.2:
                    guess = "na"
                elif abs(v - 3.6) < 0.2 or abs(v - 3.65) < 0.2:
                    guess = "nmc"
                elif abs(v - 3.8) < 0.2:
                    guess = "nmc"
                if guess:
                    row["chemistry"] = guess
                    row["chemistry_detail"] = pretty_detail(guess, "")
                    row["cathode"], row["anode"] = refine_electrodes(guess, "")
                    flags.append(f"chemistry:voltage-assumed({v}V)")
                    filled_chem += 1

        # --- mass estimates (only when we know enough to be useful) ---
        if not row.get("mass_g"):
            est = estimate_mass(row)
            if est:
                row["mass_g"] = round(est, 1)
                flags.append(row.get("_mass_flag", "mass:estimated"))
                filled_mass += 1

        row["data_flags"] = "; ".join(flags)

    # ---- pass 2: fill every remaining empty/not-provided field -------------
    for row in rows:
        flags = [f for f in (row.get("data_flags") or "").split("; ") if f]
        chem = row.get("chemistry")
        nom_v = row.get("nominal_voltage_v")

        # nominal / ocv (vmax) / cutoff (vmin) from chemistry defaults
        if not nom_v and chem:
            row["nominal_voltage_v"] = CHEM_NOM_V.get(chem)
            flags.append(f"voltage:chem-default({CHEM_NOM_V.get(chem)})")
        if chem:
            if not row.get("ocv_v"):
                row["ocv_v"] = CHEM_VMAX.get(chem)
                flags.append("ocv_v:chem-vmax")
            if not row.get("cutoff_voltage_v"):
                row["cutoff_voltage_v"] = CHEM_VMIN.get(chem)
                flags.append("cutoff_v:chem-vmin")

        # C-rate: derive from current/capacity, else use a typical estimate
        cap = row.get("capacity_ah")
        if not row.get("max_c_rate") and cap:
            if row.get("max_discharge_a"):
                row["max_c_rate"] = round(float(row["max_discharge_a"]) / float(cap), 3)
                flags.append("max_c_rate:derived")
            elif chem and row.get("form"):
                row["max_c_rate"] = TYP_CRATE.get(chem, {}).get(row["form"])
                flags.append("max_c_rate:typical")

        # form directly from the model code when still unknown
        if not row.get("form"):
            if re.search(r"(?i)(SCIB|CYCL|\d4\d{2,3}|\d2\d{3}-|INR|ICR|NCR|IFR|IFP|NA|LTO|LFP)", (row.get("model") or "")):
                if "IFP" in (row.get("model") or "").upper() or "LP" in (row.get("model") or "")[:3]:
                    row["form"] = "Prismatic"
                elif re.search(r"(?i)INR|ICR|NCR|SCIB|LTO|\d4\d{2,3}|40135|18650|21700", (row.get("model") or "")):
                    row["form"] = "Cylindrical"
            flags.append("form:from-model") if row.get("form") else None

        # dimensions: fill standard cylindrical dims from the model code
        if row.get("form") == "Cylindrical" and not (row.get("diameter_mm") or row.get("length_mm")):
            std = infer_cyl_dims_from_model(row.get("model"))
            if std:
                row.update(std)
                flags.append("dims:standard-cyl")
        # volume from dimensions whenever they are now available
        if not row.get("volume_ccm"):
            dims = {k: row[k] for k in
                    ("length_mm", "thickness_mm", "width_mm", "diameter_mm") if row.get(k)}
            vv = volume_ccm_from_dims(dims)
            if vv:
                row["volume_ccm"] = round(vv, 3)
                flags.append("volume:from-dims")

        # specific energy & power whenever the parts are known
        if cap and row.get("mass_g"):
            v = row.get("nominal_voltage_v") or CHEM_NOM_V.get(chem)
            if v:
                row["energy_wh"] = round(float(cap) * float(v), 3)
                spec = float(cap) * float(v) * 1000.0 / float(row["mass_g"])
                if not row.get("specific_energy_wh_kg_calc"):
                    row["specific_energy_wh_kg_calc"] = round(spec, 2)
                if row.get("max_c_rate"):
                    row["specific_power_w_kg"] = round(spec * float(row["max_c_rate"]), 1)

        # resistance_factor: from AC internal resistance else the app neutral 1.0
        if not row.get("resistance_factor"):
            ir = row.get("internal_resistance_ac_mohm")
            if ir:
                row["resistance_factor"] = compute_resistance_factor(
                    chem, ir / 1000.0, cap)
                flags.append("resistance_factor:from-IR")
            else:
                row["resistance_factor"] = 1.0
                flags.append("resistance_factor:app-default")

        # release year for famous cells (public launch data)
        if not row.get("release"):
            bmat = (slugify(str(row["brand"]).split(" / ")[0]), slugify(row["model"]))
            row["release"] = KNOWN_RELEASE.get(f"{bmat[0]}|{bmat[1]}")

        # country from the brand when the web source did not provide one
        if not row.get('country') and row.get('brand'):
            en = str(row['brand']).split(' / ')[0].strip().lower()
            web_country = {
                "ampace": "China", "amprius": "USA", "v4smart": "Germany",
                "v4drive": "Germany", "ses": "USA", "enpower greentech": "China",
                "innolith": "Switzerland", "welion": "China", "reliance": "India",
                "rincell": "Netherlands", "storedot": "Israel", "customcells": "Germany",
                "inobat": "Slovakia", "trydan tech": "Spain", "grepow": "China",
                "american lithium energy": "USA", "tianneng": "China", "tiankang": "China",
                "thlb": "China", "goldencell": "China", "golden feather": "China",
                "sinowatt": "China", "farasis": "China", "hohmtech": "USA",
                "terrae": "Germany", "a123 systems": "USA", "altairnano": "USA",
                "cbak": "China", "cham": "China", "dmegc": "China", "efest": "China",
                "aspilsan": "Turkey", "apex (wuxi)": "China", "feb": "China",
                "lithplus": "China", "melasta": "China", "nitecore": "China",
                "beyonder as": "Norway", "linkdata": "China", "rept": "China",
                "svolt": "China", "varta": "Germany", "v4smart": "Germany",
                "rincell": "Netherlands", "storeDot": "Israel",
                "real-cell": "China", "sapb": "China", "sinc": "China",
                "ski": "South Korea", "sunpower": "South Korea", "sunwoda": "China",
                "zeekr": "China", "reliance": "India",
            }
            if en in CELLDB_BRAND_COUNTRY:
                row['country'] = CELLDB_BRAND_COUNTRY[en]
            elif re.search(r'[\u4e00-\u9fff]', str(row['brand'])):
                row['country'] = 'China'
            elif en in web_country:
                row['country'] = web_country[en]
        if not row.get('country') and not row.get('brand'):
            row['country'] = 'Unknown'
        if not row.get('brand'):
            # anonymous datasheet row (e.g. TUM 'not defined' company): it has no
            # manufacturer, so it is dropped from the library (see main())
            flags.append("anonymous:no-brand")
        row["data_flags"] = "; ".join(dict.fromkeys(flags))
        if not row.get("data_flags"):
            row["data_flags"] = "platform-default"
    return filled_mass, filled_chem, filled_cap


def estimate_mass(row):
    """Best-available mass estimate:
    1) volume (from dims) x form density,
    2) energy / typical specific energy (a chemistry-default nominal voltage is
       used when the datasheet omits it; flagged as an estimate),
    returns grams or None."""
    row["_mass_flag"] = "mass:estimated"
    dims = {}
    for k in ("length_mm", "thickness_mm", "width_mm", "diameter_mm"):
        if row.get(k):
            dims[k] = float(row[k])
    vol = row.get("volume_ccm") or volume_ccm_from_dims(dims)
    if vol:
        row["_mass_flag"] = "mass:volume-estimated"
        density = FORM_DENSITY.get(row.get("form"), 2.1)
        return vol * density
    if row.get("capacity_ah") and row.get("chemistry"):
        v = row.get("nominal_voltage_v") or CHEM_NOM_V.get(row["chemistry"])
        if v:
            energy = float(row["capacity_ah"]) * float(v)
            whkg = TYP_WHKG.get(row["chemistry"])
            if whkg:
                row["_mass_flag"] = "mass:energy-estimated"
                return energy * 1000.0 / whkg
    return None


# typical continuous C-rate (1C-family) per chemistry-for-form, used only when
# a cell has no discharge data at all; flagged as an estimate.
TYP_CRATE = {
    "lfp": {"Prismatic": 0.5, "Blade": 0.5, "Pouch": 1.0, "Cylindrical": 1.0},
    "lmfp": {"Prismatic": 0.5, "Blade": 0.5, "Pouch": 1.0, "Cylindrical": 1.0},
    "nmc": {"Prismatic": 1.0, "Blade": 1.0, "Pouch": 2.0, "Cylindrical": 2.0},
    "nca": {"Prismatic": 1.0, "Blade": 1.0, "Pouch": 2.0, "Cylindrical": 2.0},
    "lco": {"Prismatic": 1.0, "Blade": 1.0, "Pouch": 1.0, "Cylindrical": 1.0},
    "lto": {"Prismatic": 5.0, "Blade": 5.0, "Pouch": 5.0, "Cylindrical": 5.0},
    "na": {"Prismatic": 1.0, "Blade": 1.0, "Pouch": 1.0, "Cylindrical": 1.0},
    "lmo": {"Prismatic": 1.0, "Blade": 1.0, "Pouch": 2.0, "Cylindrical": 2.0},
    "lmb": {"Prismatic": 1.0, "Blade": 1.0, "Pouch": 1.0, "Cylindrical": 1.0},
    "alkaline": {"Prismatic": 0.1, "Blade": 0.1, "Pouch": 0.1, "Cylindrical": 0.1},
}

# standard cylindrical sizes implied by model codes (diameter x length, mm)
CYL_STANDARD = {
    "10180": (10.0, 18.0), "10280": (10.0, 28.0), "14500": (14.0, 50.0),
    "16340": (16.0, 34.0), "17335": (17.0, 33.5), "17490": (17.0, 49.0),
    "17500": (17.0, 50.0), "17670": (17.0, 67.0), "18350": (18.0, 35.0),
    "18490": (18.0, 49.0), "18500": (18.0, 50.0), "18650": (18.0, 65.0),
    "18700": (18.0, 70.0), "19670": (19.0, 67.0), "20700": (20.0, 70.0),
    "21700": (21.0, 70.0), "22100": (21.7, 100.0), "22650": (22.0, 65.0),
    "25500": (25.0, 50.0), "26500": (26.0, 50.0), "26650": (26.0, 65.0),
    "26670": (26.0, 67.0), "26700": (26.0, 70.0), "32600": (32.0, 60.0),
    "32700": (32.2, 70.0), "32900": (32.2, 90.0), "33140": (33.1, 140.0),
    "38120": (38.0, 120.0), "40152": (40.0, 152.0), "46800": (46.0, 80.0),
    "46130": (46.0, 130.0),
}

# known release year for famous cells (from public launch data)
KNOWN_RELEASE = {
    "lg-energy-solution|inr21700m50": 2017,
    "lg-energy-solution|inr21700m50l": 2017,
    "samsung-sdi|inr21700-30t": 2018,
    "samsung-sdi|inr21700-40t": 2020,
    "samsung-sdi|inr21700-50e": 2017,
    "molicel|inr21700-p42a": 2019,
    "molicel|inr21700-p45b": 2021,
    "molicel|inr18650-p28a": 2020,
    "molicel|inr18650-p26a": 2017,
    "panasonic|ncr18650b": 2013,
    "panasonic|ncr18650a": 2011,
    "panasonic|ncr18650g": 2016,
    "panasonic|ncr21700a": 2018,
    "lg-energy-solution|inr18650-mj1": 2015,
    "lg-energy-solution|inr18650-hg2": 2014,
    "samsung-sdi|inr18650-30q": 2015,
    "samsung-sdi|inr18650-25r": 2013,
    "samsung sdi|inr18650-30q": 2015,
    "samsung sdi|inr18650-25r": 2013,
}


def infer_cyl_dims_from_model(model):
    """For cylindrical cells, fill standard dims from the model code
    ('INR21700-50E' -> diameter 21 mm, length 70 mm)."""
    m = (model or "").upper()
    for size, (d, l) in CYL_STANDARD.items():
        if size in m:
            return {"diameter_mm": d, "length_mm": l}
    nums = re.findall(r"\d{4,5}", m)
    if nums:
        return {}
    return {}


# ----------------------------------------------------------------------------
# Output schema
# ----------------------------------------------------------------------------

EXTRA_FIELDS = [
    "country", "release", "model", "chemistry_detail", "cathode", "anode",
    "nominal_voltage_v", "ocv_v",
    "cutoff_voltage_v", "specific_energy_wh_kg_spec", "specific_energy_wh_kg_calc",
    "specific_power_w_kg",
    "volumetric_energy_density_whl_spec", "volumetric_energy_density_whl_calc",
    "energy_wh", "max_discharge_a", "max_charge_a", "max_charge_c_rate",
    "charge_standard_a", "charge_standard_c_rate", "discharge_standard_a",
    "discharge_standard_c_rate", "pulse_charge_a", "pulse_discharge_a",
    "pulse_duration_s", "cycle_life_cycles", "cycle_life_eol_pct",
    "residual_capacity_pct", "length_mm", "thickness_mm", "width_mm",
    "diameter_mm", "size_mm", "volume_ccm", "internal_resistance_ac_mohm",
    "internal_resistance_dc_mohm", "operating_temperature", "crate_discharge_cyclelife",
    "crate_charge_cyclelife", "evidence", "year", "datasheet_url",
    "datasheet_available", "secondary_source", "document_id_date",
    "charging_method", "crate_cv_cutoff", "t_cycle_dod", "t_rest_h", "data_flags",
]

FIELDS = BASE_FIELDS + EXTRA_FIELDS


def round_vals(row):
    for k in list(row):
        if isinstance(row[k], float):
            row[k] = round(row[k], 4)
    return row


def write_csv(rows):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with OUT_CSV.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS, extrasaction="ignore")
        w.writeheader()
        for row in rows:
            w.writerow({k: ("" if row.get(k) is None else row[k]) for k in FIELDS})
    print("wrote", OUT_CSV)


def write_xlsx(rows):
    from openpyxl import Workbook
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    wb = Workbook()
    ws = wb.active
    ws.title = "cells"
    ws.append(FIELDS)
    link_font = Font(color="0563C1", underline="single")
    for row in rows:
        vals = [("" if row.get(k) is None else row[k]) for k in FIELDS]
        ws.append(vals)
        i = FIELDS.index("datasheet_url") + 1
        if row.get("datasheet_url"):
            c = ws.cell(row=ws.max_row, column=i)
            c.hyperlink = row["datasheet_url"]
            c.font = link_font
    for col in ws.columns:
        letter = col[0].column_letter
        width = max((len(str(c.value or "")) for c in col), default=8) + 2
        ws.column_dimensions[letter].width = min(width, 45)
    wb.save(OUT_XLSX)
    print("wrote", OUT_XLSX)


def load_curated_rows(path=CURATED):
    """Cells added by hand because no scraped source carries them yet.

    scrapers/data/curated_cells.json holds datasheet-level rows in the same
    shape as the scraped ones (source_url, chemistry, capacity, mass ...).
    They go through the same merge, dedupe, enrichment and ID steps as every
    other row, so a curated cell that later shows up in CellDB or in the web
    sources collapses into one library entry instead of duplicating.
    """
    if not path.exists():
        return []
    import json as _json
    data = _json.loads(path.read_text(encoding="utf-8"))
    out = []
    for raw in data:
        row = dict(raw)
        row["_src"] = "CURATED"
        row["source"] = "CURATED"
        row.setdefault("name", "")
        row.setdefault("country", "")
        row.setdefault("release", None)
        row.setdefault("coverage", None)
        row.setdefault("kind", "")
        flags = [f for f in str(row.get("data_flags") or "").split("; ") if f]
        row["data_flags"] = "; ".join(dict.fromkeys(["curated"] + flags))
        out.append(row)
    return out


def main():
    global FIELDS
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", action="store_true", help="write only the CSV")
    ap.add_argument("--web-rows", help="path to tools/web_cells.json (web-scraped cells)")
    args = ap.parse_args()

    cdb_rows = extract_celldb_rows()
    tum_rows = extract_tum_rows()
    print(f"parsed {len(cdb_rows)} CellDB rows, {len(tum_rows)} TUM rows")
    all_rows = cdb_rows + tum_rows

    web_rows = []
    if args.web_rows and Path(args.web_rows).exists():
        import json as _json
        web_rows = _json.loads(Path(args.web_rows).read_text(encoding="utf-8"))
        for r in web_rows:
            r.setdefault("_src", "WEB")
            r["source"] = r["_src"]            # source fallback used by dedupe
            r.setdefault("name", "")
            r.setdefault("country", "")
            r.setdefault("release", None)
            r.setdefault("coverage", None)
            r.setdefault("kind", "")
        # narrow the exact-seen dedupe so a cell that is BOTH in CellDB/TUM and
        # in the web sources is merged, not duplicated
        for r in web_rows:
            r.setdefault("data_flags", "web-data")
        all_rows = all_rows + web_rows
        print(f"added {len(web_rows)} web rows")

    curated_rows = load_curated_rows()
    if curated_rows:
        all_rows = all_rows + curated_rows
        print(f"added {len(curated_rows)} curated rows ({CURATED.name})")

    # canonicalise brand aliases (case / abbreviation / parent company) so rows
    # of the same manufacturer merge and the library shows one name per brand
    for r in all_rows:
        r["brand"] = canon_brand(r.get("brand"))

    merged = dedupe_and_merge(all_rows)
    merged = collapse_near_duplicates(merged)
    build_ids(merged)

    # enrichment guarantees the platform minimums
    filled_mass, filled_chem, filled_cap = enrich_minimums(merged)

    # drop anonymous rows that have no manufacturer (previously branded
    # "openBatteryFlux"): they are placeholders, not real cells
    n0 = len(merged)
    merged = [r for r in merged if (r.get("brand") or "").strip()]
    if len(merged) < n0:
        print(f"dropped {n0 - len(merged)} anonymous rows (no brand)")

    # recompute derived fields on the final merged records
    for r in merged:
        r["coverage"] = compute_coverage(r, KEY_FIELDS)
        r["kind"] = kind_from_crate(r.get("max_c_rate"))
        # keep the pass-2 resistance_factor, but prefer a measured-IR value
        ir_ohm = (r.get("internal_resistance_ac_mohm")
                  and r["internal_resistance_ac_mohm"] / 1000.0) or None
        if ir_ohm:
            has_base = bool(r.get("chemistry") and r.get("capacity_ah"))
            r["resistance_factor"] = (
                compute_resistance_factor(r.get("chemistry"), ir_ohm, r.get("capacity_ah"))
                if has_base else 1.0)
        elif not r.get("resistance_factor"):
            r["resistance_factor"] = 1.0
        if r.get("capacity_ah") and r.get("mass_g"):
            v = r.get("nominal_voltage_v")
            if v:
                spec = float(r["capacity_ah"]) * float(v) * 1000.0 / float(r["mass_g"])
                if not r.get("specific_energy_wh_kg_calc"):
                    r["specific_energy_wh_kg_calc"] = round(spec, 2)
                if r.get("max_c_rate"):
                    r["specific_power_w_kg"] = round(spec * float(r["max_c_rate"]), 1)
        if r.get("energy_wh") is None and r.get("capacity_ah") and r.get("nominal_voltage_v"):
            r["energy_wh"] = round(float(r["capacity_ah"]) * float(r["nominal_voltage_v"]), 3)

    merged = [round_vals(r) for r in merged]
    write_csv(merged)
    if MERGE_CONFLICTS:
        conflict_path = OUT_DIR / "merge_conflicts.csv"
        with conflict_path.open("w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=["id", "brand", "model", "field",
                                               "kept", "merged"])
            w.writeheader()
            w.writerows(MERGE_CONFLICTS)
        print(f"merge conflicts logged: {len(MERGE_CONFLICTS)} -> {conflict_path}")
    if not args.csv:
        write_xlsx(merged)

    coarse = {}
    for r in merged:
        c = r["chemistry"] or "?"
        coarse[c] = coarse.get(c, 0) + 1
    print("\nMerged rows:", len(merged))
    print("chemistry breakdown:", dict(sorted(coarse.items(), key=lambda x: -x[1])))
    for req in ("id", "chemistry", "capacity_ah", "mass_g"):
        miss = sum(1 for r in merged if not r[req])
        print(f"rows missing {req:12s}: {miss}")
    print(f"enriched: mass_g={filled_mass}, chemistry={filled_chem}, capacity_ah={filled_cap}")
    dup_ids = len(merged) - len({r["id"] for r in merged})
    print("duplicate ids remaining:", dup_ids)


if __name__ == "__main__":
    main()


