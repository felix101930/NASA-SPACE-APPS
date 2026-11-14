"""Shared helpers for the match stage: paths, IO, meta block, tiles, site eligibility."""
from __future__ import annotations

import hashlib
import json
import logging
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from pipeline.common.config import CORE_SIZE_PX, HAZARDS, INTERIM as INTERIM_ROOT, REGION_IDS, ROOT, WEB_DATA

log = logging.getLogger("pipeline.match")

PIPELINE_VERSION = "match-0.1.0"

INTERIM = INTERIM_ROOT / "match"
INTERIM.mkdir(parents=True, exist_ok=True)

REGIONS_JSON = WEB_DATA / "regions.json"
EARTH_SITES_JSON = WEB_DATA / "earth_sites.json"
METHOD_JSON = WEB_DATA / "method.json"
MATCHES_JSON = WEB_DATA / "matches.json"
SUMMARY_JSON = WEB_DATA / "summary.json"
MOON_INTERIM = INTERIM_ROOT / "moon"
EARTH_INTERIM = INTERIM_ROOT / "earth"
TESTS_DIR = ROOT / "tests"

__all__ = [
    "CORE_SIZE_PX", "HAZARDS", "REGION_IDS", "PIPELINE_VERSION", "INTERIM", "REGIONS_JSON", "EARTH_SITES_JSON",
    "METHOD_JSON", "MATCHES_JSON", "SUMMARY_JSON", "MOON_INTERIM", "EARTH_INTERIM", "TESTS_DIR",
    "setup_logging", "read_json", "write_json", "file_sig", "make_meta", "merge_sources", "read_tile",
    "is_heldout_or_decoy", "is_eligible", "finite", "now_utc",
]


def setup_logging(level: int = logging.INFO) -> None:
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(name)s: %(message)s", datefmt="%H:%M:%S")


def now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_json(path: Path) -> dict:
    return json.loads(Path(path).read_text())


def _clean(o: object) -> object:
    """NaN/inf -> None, numpy scalars -> Python, recursively (strict JSON for the web app)."""
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, (np.floating, float)):
        f = float(o)
        return f if math.isfinite(f) else None
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    return o


def write_json(path: Path, doc: dict, indent: int | None = 1) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(_clean(doc), indent=indent, ensure_ascii=False, allow_nan=False))
    tmp.replace(path)
    log.info("wrote %s (%.0f kB)", path.relative_to(ROOT), path.stat().st_size / 1024)


def file_sig(*paths: Path) -> str:
    """Cheap content signature (size + mtime) of input files, for cache invalidation."""
    h = hashlib.sha1()
    for p in paths:
        p = Path(p)
        if p.exists():
            st = p.stat()
            h.update(f"{p.name}:{st.st_size}:{int(st.st_mtime)}".encode())
        else:
            h.update(f"{p.name}:missing".encode())
    return h.hexdigest()[:16]


def merge_sources(*source_lists: list[dict]) -> list[dict]:
    seen, out = set(), []
    for lst in source_lists:
        for s in lst or []:
            key = (s.get("name"), s.get("url"))
            if key in seen:
                continue
            seen.add(key)
            out.append({k: s.get(k) for k in ("name", "url", "licence", "citation")})
    return out


def make_meta(sources: list[dict], **extra: object) -> dict:
    return {"generated_utc": now_utc(), "pipeline_version": PIPELINE_VERSION, "sources": sources, **extra}


def read_tile(rel_path: str, size: int = CORE_SIZE_PX) -> np.ndarray | None:
    """Float32 500x500 tile from web/public/data/<rel_path> (row 0 = north); None if missing/bad."""
    p = WEB_DATA / rel_path
    if not p.exists():
        return None
    a = np.fromfile(p, dtype="<f4")
    if a.size != size * size:
        log.warning("tile %s has %d values, expected %d", rel_path, a.size, size * size)
        return None
    return a.reshape(size, size).astype(np.float64)


def finite(x: object) -> bool:
    return isinstance(x, (int, float, np.floating)) and math.isfinite(float(x))


# ---------------------------------------------------------------- eligibility
# Which Earth sites may win a top-3 slot. Validation positives (held out) and decoys are scored
# for validation only and can never be shown as a match.
ELIGIBLE_SELECTED_BY = ("global_screen", "refine", "documented", "validation")
ELIGIBLE_ROLES_BY_SOURCE = {
    "global_screen": None,                    # any role except held-out / decoy
    "refine": None,
    "documented": ("seed",),                  # documented analogs: seed split only (holdout split is validation)
    "validation": ("listed_candidate",),      # hand-listed impact craters etc.; never the 13 known analogs
}


def is_heldout_or_decoy(site: dict) -> bool:
    role = str(site.get("role") or "")
    return (role in ("heldout_positive", "heldout_positive_ext", "decoy")
            or str(site.get("split") or "") == "holdout"
            or str(site.get("category") or "") == "decoy")


def is_eligible(site: dict) -> bool:
    if is_heldout_or_decoy(site):
        return False
    src = str(site.get("selected_by") or "")
    if src not in ELIGIBLE_SELECTED_BY:
        return False
    roles = ELIGIBLE_ROLES_BY_SOURCE.get(src)
    if src == "documented":
        return str(site.get("split") or site.get("role") or "") == "seed" or str(site.get("role")) == "seed"
    return roles is None or str(site.get("role") or "") in roles
