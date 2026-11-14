"""Impact numbers: sourced dollars at stake, a labelled field-week cost estimate, travel CO2e by site choice,
and land-cover facts for the matched sites. Pure functions; inputs are matches.json + earth_sites.json."""
from __future__ import annotations

import math
import statistics
from collections.abc import Iterable

from pipeline.impact import sources as S

EARTH_MEAN_R_KM = 6371.0088  # IUGG mean Earth radius

BASES: dict[str, dict] = {
    "calgary": {"name": "Calgary", "lat": 51.05, "lon": -114.07},
    "houston_jsc": {"name": "Houston (NASA JSC)", "lat": 29.56, "lon": -95.09},
}
TEAM_SIZE = 10
FIELD_DAYS = 7


def great_circle_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Haversine great-circle distance on a sphere of the IUGG mean Earth radius."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_MEAN_R_KM * math.asin(min(1.0, math.sqrt(a)))


def flight_co2e_kg(gc_km: float, factor_kg_per_pkm: float = S.FACTOR_WITH_RF, people: int = 1,
                   round_trip: bool = True) -> float:
    """kg CO2e = great-circle km x (2 if round trip) x factor x people.

    DESNZ factors already include the 8% uplift for indirect routing, so no extra distance uplift is applied.
    """
    return gc_km * (2 if round_trip else 1) * factor_kg_per_pkm * people


def field_week_cost_usd(people: int = TEAM_SIZE, days: int = FIELD_DAYS,
                        lodging: float = S.GSA_LODGING_USD, mie: float = S.GSA_MIE_USD) -> float:
    """ESTIMATE: people x days x (lodging + meals & incidentals). Excludes airfare, vehicles, gear, salaries."""
    return people * days * (lodging + mie)


def _site_trip(m: dict, base: dict) -> dict:
    km = great_circle_km(base["lat"], base["lon"], m["lat"], m["lon"])
    return {
        "rank": m["rank"], "site_id": m["site_id"], "site_name": m.get("site_name"), "country": m.get("country"),
        "match_distance": m.get("distance"), "gc_km": round(km, 1),
        "kg_co2e_pp": round(flight_co2e_kg(km), 1),
        "kg_co2e_pp_no_rf": round(flight_co2e_kg(km, S.FACTOR_WITHOUT_RF), 1),
    }


def per_region(matches: Iterable[dict], region_names: dict[str, str]) -> list[dict]:
    """One row per region x hazard: #1 match vs nearest vs farthest of the top 3, for each base."""
    groups: dict[tuple[str, str], list[dict]] = {}
    for m in matches:
        if m.get("rank", 99) <= 3:
            groups.setdefault((m["region_id"], m["hazard"]), []).append(m)
    rows: list[dict] = []
    for (rid, hz), ms in sorted(groups.items()):
        ms = sorted(ms, key=lambda x: x["rank"])
        row: dict = {"region_id": rid, "region_name": region_names.get(rid, rid), "hazard": hz, "n_top": len(ms),
                     "bases": {}}
        for bid, base in BASES.items():
            trips = [_site_trip(m, base) for m in ms]
            near = min(trips, key=lambda t: t["gc_km"])
            far = max(trips, key=lambda t: t["gc_km"])
            first = trips[0]
            row["bases"][bid] = {
                "rank1": first, "nearest_top3": near, "farthest_top3": far,
                "nearest_is_rank1": near["rank"] == 1,
                "team_saving_t_vs_farthest": round((far["kg_co2e_pp"] - near["kg_co2e_pp"]) * TEAM_SIZE / 1000, 2),
                "team_saving_t_vs_rank1": round((first["kg_co2e_pp"] - near["kg_co2e_pp"]) * TEAM_SIZE / 1000, 2),
            }
        rows.append(row)
    return rows


def co2_summary(rows: list[dict], base_id: str) -> dict:
    vs_far = [r["bases"][base_id]["team_saving_t_vs_farthest"] for r in rows]
    vs_first = [r["bases"][base_id]["team_saving_t_vs_rank1"] for r in rows]
    near_t = [r["bases"][base_id]["nearest_top3"]["kg_co2e_pp"] * TEAM_SIZE / 1000 for r in rows]
    far_t = [r["bases"][base_id]["farthest_top3"]["kg_co2e_pp"] * TEAM_SIZE / 1000 for r in rows]
    return {
        "base": BASES[base_id]["name"], "n_rehearsals": len(rows), "team_size": TEAM_SIZE,
        "mean_team_t_nearest": round(statistics.fmean(near_t), 1),
        "mean_team_t_farthest": round(statistics.fmean(far_t), 1),
        "mean_team_saving_t_vs_farthest": round(statistics.fmean(vs_far), 1),
        "median_team_saving_t_vs_farthest": round(statistics.median(vs_far), 1),
        "max_team_saving_t_vs_farthest": round(max(vs_far), 1),
        "mean_team_saving_t_vs_rank1": round(statistics.fmean(vs_first), 1),
        "n_nearest_is_rank1": sum(r["bases"][base_id]["nearest_is_rank1"] for r in rows),
        "total_saving_t_all_rehearsals_vs_farthest": round(sum(vs_far), 1),
    }


def environment(matches: list[dict], sites: list[dict]) -> dict:
    """Land-cover shares (ESA WorldCover 2021, 15 km core) of every site that appears in a top 3."""
    by_id = {s["id"]: s for s in sites}
    ids = sorted({m["site_id"] for m in matches if m.get("rank", 99) <= 3})
    rows = []
    for sid in ids:
        s = by_id.get(sid)
        if not s or not s.get("worldcover"):
            continue
        wc = s["worldcover"]
        rows.append({
            "site_id": sid, "tree": wc.get("tree", 0.0), "wet": wc.get("wetland", 0.0) + wc.get("mangrove", 0.0),
            "crop": wc.get("crop", 0.0), "built": wc.get("built", 0.0), "bare": wc.get("bare", 0.0),
            "dsm_safe": bool(s.get("dsm_safe")),
        })
    n = len(rows)
    low_veg = [r for r in rows if r["tree"] <= 0.10 and r["wet"] <= 0.10]
    return {
        "n_sites": n,
        "n_sites_missing_landcover": len(ids) - n,
        "n_trees_and_wetland_le_10pct": len(low_veg),
        "n_dsm_safe": sum(r["dsm_safe"] for r in rows),
        "median_tree_pct": round(100 * statistics.median(r["tree"] for r in rows), 2) if rows else None,
        "max_tree_pct": round(100 * max(r["tree"] for r in rows), 1) if rows else None,
        "max_wetland_pct": round(100 * max(r["wet"] for r in rows), 1) if rows else None,
        "median_bare_pct": round(100 * statistics.median(r["bare"] for r in rows), 1) if rows else None,
        "n_built_le_5pct": sum(r["built"] <= 0.05 for r in rows),
        "filter_rule": "DSM-safe screen (pipeline/earth/screen.py, windows.py): tree <= 10%, built <= 5%, "
                       "crop <= 20%, water <= 20%, wetland + mangrove <= 10%, snow < 30% of the 15 km core.",
        "filter_purpose": "The rule exists so the 30 m surface model measures ground, not canopy. Steering field "
                          "teams away from forests and wetlands is a side effect, not its design goal.",
        "protected_areas": "Not checked. earth_sites.json has no protected-area flag; check the World Database on "
                           "Protected Areas (https://www.protectedplanet.net/) and local permits before any visit.",
        "source": "ESA WorldCover 10 m 2021 v200, doi:10.5281/zenodo.7254221",
    }
