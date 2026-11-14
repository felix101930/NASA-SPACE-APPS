"""Validation set: the 126-row hand-curated candidate CSV.

role = heldout_positive (known analog), decoy (category=decoy), listed_candidate otherwise.
Validation rows are never eligible as stage-1 "discoveries".
The original CSV is left unchanged; a cleaned copy goes to data/earth_sites_clean.csv.
"""
from __future__ import annotations

import csv
import logging
from dataclasses import dataclass, field

from pipeline.earth.common import CANDIDATES_CSV, CLEAN_CSV

log = logging.getLogger("pipeline.earth.pool")


@dataclass
class Site:
    id: str
    name: str
    lat: float
    lon: float
    country: str = ""
    category: str = ""
    role: str = "candidate"
    known_analog: bool = False
    selected_by: str = "validation"
    stage1_rank: int | None = None
    extra: dict = field(default_factory=dict)


def _role(row: dict) -> str:
    if row.get("category", "").strip() == "decoy":
        return "decoy"
    if row.get("known_analog", "").strip().lower().startswith("yes"):
        return "heldout_positive"
    return "listed_candidate"


def load_validation(write_clean: bool = True) -> tuple[list[Site], list[dict]]:
    """Return (sites with coordinates, dropped rows)."""
    with open(CANDIDATES_CSV, newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    sites, dropped, clean_rows = [], [], []
    for r in rows:
        try:
            lat, lon = float(r["lat"]), float(r["lon"])
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                raise ValueError("out of range")
        except (ValueError, KeyError, TypeError):
            dropped.append({"id": r.get("id"), "name": r.get("name"), "reason": "no coordinates"})
            continue
        role = _role(r)
        s = Site(id=r["id"].strip(), name=r["name"].strip(), lat=lat, lon=lon, country=r.get("country", "").strip(),
                 category=r.get("category", "").strip(), role=role, known_analog=role == "heldout_positive",
                 selected_by="validation", extra=r)
        sites.append(s)
        clean_rows.append({**r, "role": role})
    if write_clean and clean_rows:
        with open(CLEAN_CSV, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=list(clean_rows[0].keys()))
            w.writeheader()
            w.writerows(clean_rows)
    log.info("validation set: %d with coordinates, %d dropped: %s", len(sites), len(dropped),
             ", ".join(f"{d['id']} {d['name']}" for d in dropped))
    return sites, dropped


# ----------------------------------------------------------------------------- documented analogs
LIT_CSV = CANDIDATES_CSV.parent / "literature_analogs.csv"
LIT_HOLDOUT = ("LA001", "LA003", "LA004", "LA006", "LA007", "LA008", "LA010", "LA016", "LA020", "LA021", "LA024",
               "LA025", "LA027", "LA028", "LA030", "LA033", "LA034", "LA035", "LA040", "LA043")
LIT_SEED = ("LA011", "LA012", "LA013", "LA014", "LA015", "LA017", "LA018", "LA019", "LA022", "LA023", "LA026",
            "LA029", "LA036", "LA037", "LA038", "LA039", "LA042", "LA044")
DEDUP_KM = 20.0


def load_documented() -> list[Site]:
    """Agency-documented analogs with coordinates (docs/literature-analogs.md split). Seeds are never validation."""
    import math as _m
    if not LIT_CSV.exists():
        return []
    with open(LIT_CSV, newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    val, _ = load_validation(write_clean=False)
    ep_pos = [s for s in val if s.role == "heldout_positive"]
    out = []
    for r in rows:
        lid = r["lit_id"].strip()
        split = "holdout" if lid in LIT_HOLDOUT else ("seed" if lid in LIT_SEED else None)
        if split is None:
            continue
        try:
            lat, lon = float(r["lat"]), float(r["lon"])
        except (TypeError, ValueError):
            continue
        dup = None
        for e in ep_pos:
            dy = (lat - e.lat) * 111.32
            dx = (lon - e.lon) * 111.32 * _m.cos(_m.radians(lat))
            if _m.hypot(dx, dy) < DEDUP_KM:
                dup = e.id
                break
        role = "heldout_positive" if split == "holdout" else "seed"
        s = Site(id=lid, name=r["name"].strip(), lat=lat, lon=lon, country=r.get("country", "").strip(),
                 category="documented_analog", role=role, known_analog=split == "holdout", selected_by="documented",
                 extra={**r, "split": split, "dup_of": dup})
        out.append(s)
    log.info("documented analogs: %d with coordinates (%d holdout, %d seed; %d holdout duplicate EP positives)",
             len(out), sum(1 for s in out if s.extra["split"] == "holdout"),
             sum(1 for s in out if s.extra["split"] == "seed"),
             sum(1 for s in out if s.extra["split"] == "holdout" and s.extra["dup_of"]))
    return out
