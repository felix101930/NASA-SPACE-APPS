"""Macrostrat lithology lookups (CC-BY 4.0), cached per point.

The API's lith= filter is unreliable, so anorthosite is detected by string match on the
lith / name / descrip fields; 'plutonic' covers plutonic/intrusive igneous units.
"""
from __future__ import annotations

import hashlib
import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor

import requests

from pipeline.earth.common import RAW

log = logging.getLogger("pipeline.earth.rock")

API = "https://macrostrat.org/api/v2/geologic_units/map"
CACHE = RAW / "macrostrat"


def _cache_path(lat: float, lon: float):
    key = f"{lat:.4f}_{lon:.4f}"
    return CACHE / f"{hashlib.md5(key.encode()).hexdigest()[:16]}_{key}.json"


def fetch(lat: float, lon: float, retries: int = 3) -> dict | None:
    p = _cache_path(lat, lon)
    if p.exists():
        try:
            return json.loads(p.read_text())
        except json.JSONDecodeError:
            p.unlink()
    for attempt in range(retries):
        try:
            r = requests.get(API, params={"lat": round(lat, 4), "lng": round(lon, 4), "response": "long"}, timeout=30)
            r.raise_for_status()
            js = r.json()
            p.write_text(json.dumps(js))
            return js
        except Exception as exc:  # noqa: BLE001
            log.warning("macrostrat %.4f,%.4f attempt %d: %s", lat, lon, attempt + 1, exc)
            time.sleep(1 + attempt)
    return None


def summarise(js: dict | None) -> dict:
    """{lith, anorthosite, plutonic, source, unit, refs}"""
    if not js or "success" not in js:
        return {"lith": None, "anorthosite": False, "plutonic": False, "source": "none", "unit": None}
    data = js["success"].get("data", [])
    if not data:
        return {"lith": None, "anorthosite": False, "plutonic": False, "source": "none", "unit": None}
    # Macrostrat returns units at several map scales; prefer the most detailed one.
    order = {"large": 0, "medium": 1, "small": 2, "tiny": 3}
    data = sorted(data, key=lambda d: order.get(d.get("scale", "tiny"), 4))
    text_all = " ".join(f"{d.get('lith','')} {d.get('name','')} {d.get('descrip','')}" for d in data).lower()
    best = data[0]
    refs = js["success"].get("refs", {})
    return {
        "lith": (best.get("lith") or best.get("name") or "")[:200],
        "unit": (best.get("name") or "")[:200],
        "anorthosite": "anorthosite" in text_all,
        "plutonic": any(k in text_all for k in ("plutonic", "intrusive", "anorthosite", "gabbro", "granit")),
        "source": "macrostrat",
        "refs": [str(refs.get(str(best.get("source_id")), ""))[:300]],
    }


def lookup(lat: float, lon: float) -> dict:
    return summarise(fetch(lat, lon))


def lookup_many(points: list[tuple[float, float]], workers: int = 8) -> list[dict]:
    with ThreadPoolExecutor(workers) as ex:
        return list(ex.map(lambda p: lookup(*p), points))
