"""CLI: python -m pipeline.impact

Reads web/public/data/{matches,earth_sites,regions}.json, writes web/public/data/impact.json.
Sourced facts live in pipeline/impact/sources.py; every computed number carries its formula.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from pipeline.common.config import WEB_DATA
from pipeline.impact import compute as C
from pipeline.impact import sources as S

log = logging.getLogger("pipeline.impact")
VERSION = "impact-0.1.0"


def _read(name: str) -> dict:
    return json.loads((WEB_DATA / name).read_text())


def _usd_m(v: float) -> str:
    return f"${v / 1e6:,.0f}M"


def build() -> dict:
    matches = _read("matches.json")["matches"]
    sites = _read("earth_sites.json")["sites"]
    regions = {r["id"]: r["name"] for r in _read("regions.json")["regions"]}

    # ---- money (sourced)
    on_side = [m for m in S.MONEY if m["outcome_class"] == "on_side" and m["nasa_clps"]]
    on_side_usd = sum(m["value_usd"] for m in on_side)

    # ---- field week (estimate)
    week = C.field_week_cost_usd()
    ratio = min(m["value_usd"] for m in on_side) / week

    # ---- CO2
    rows = C.per_region(matches, regions)
    summaries = {b: C.co2_summary(rows, b) for b in C.BASES}
    cal = summaries["calgary"]

    env = C.environment(matches, sites)

    factor_src = {"name": "UK DESNZ 2026 GHG conversion factors (flat file v1.2): Business travel - air, "
                          "International to/from non-UK, Economy class, kg CO2e per passenger-km",
                  "url": S.DESNZ_FLAT_URL}
    method_src = {"name": "DESNZ 2026 methodology paper, para 8.38 (8% great-circle uplift already applied)",
                  "url": S.DESNZ_METHOD_URL}
    oig_src = {"name": S.OIG_NAME, "url": S.OIG_URL}

    headline = [
        {
            "id": "at_stake", "kind": "sourced", "value": round(on_side_usd / 1e6), "prefix": "$", "unit": "M",
            "label": "of NASA lander contracts ended on their side",
            "how": [f"IM-1 Odysseus {_usd_m(on_side[0]['value_usd'])} + IM-2 Athena "
                    f"{_usd_m(on_side[1]['value_usd'])}: NASA CLPS task-order values as of Feb 2024.",
                    "Both touched down, then tipped. IM-2 came to rest inside a crater near Mons Mouton.",
                    "Peregrine ($108M) is left out: it never tried to land."],
            "formula": "122.0 + 50.0 = 172.0 ($ millions)",
            "sources": [oig_src, {"name": "NASA release on IM-2 (on its side, inside a crater)",
                                  "url": on_side[1]["outcome_source"]}],
        },
        {
            "id": "field_week", "kind": "estimate", "value": round(week / 1000, 1), "prefix": "~$", "unit": "k",
            "label": "for a 10-person field week on Earth",
            "how": ["Lodging and meals only, at US federal per-diem rates. No airfare, vehicles, gear or salaries.",
                    f"Even at 10× that, it is about {100 * week * 10 / on_side[1]['value_usd']:.2f}% of "
                    "the smaller of the two contracts above.",
                    S.TESTING_NOT_FOUND],
            "formula": f"{C.TEAM_SIZE} people × {C.FIELD_DAYS} days × (${S.GSA_LODGING_USD} + "
                       f"${S.GSA_MIE_USD}) = ${week:,.0f}",
            "sources": [{"name": "GSA FY2026 per diem bulletin FTR 26-01 (standard CONUS rate)", "url": S.GSA_URL}],
        },
        {
            "id": "co2_saved", "kind": "computed", "value": cal["mean_team_saving_t_vs_farthest"], "prefix": "",
            "unit": "t CO₂e",
            "label": "less per team trip by flying to the nearest top-3 match",
            "how": [f"From Calgary, 10 people, round trip. Average over all {cal['n_rehearsals']} region × "
                    "hazard rehearsals: nearest of our top 3 matches vs the farthest.",
                    f"Nearest averages {cal['mean_team_t_nearest']} t, farthest {cal['mean_team_t_farthest']} t. "
                    f"The nearest is also the #1 match in {cal['n_nearest_is_rank1']} of {cal['n_rehearsals']}; "
                    "otherwise you trade a little fit for less travel.",
                    "Straight-line distance (real routes emit more). Includes contrail warming (radiative "
                    "forcing); without it, multiply by 0.59."],
            "formula": f"saving = (km_far − km_near) × 2 × {S.FACTOR_WITH_RF} kg/pkm × 10",
            "sources": [factor_src, method_src],
        },
        {
            "id": "open_ground", "kind": "computed", "value": env["n_trees_and_wetland_le_10pct"], "prefix": "",
            "unit": f"/ {env['n_sites']}",
            "label": "matched sites are open ground, not forest or wetland",
            "how": ["Trees ≤ 10% and wetland ≤ 10% of the 15 km site (ESA WorldCover 2021). "
                    f"Median tree cover: {env['median_tree_pct']:g}%.",
                    "Our filter keeps trees out so the elevation model sees bare ground; the low footprint is a "
                    "side effect.",
                    "Protected areas are not checked. Check protectedplanet.net and local permits first."],
            "formula": "count(tree ≤ 0.10 and wetland + mangrove ≤ 0.10) over sites in any top 3",
            "sources": [{"name": "ESA WorldCover 10 m 2021 v200", "url": "https://doi.org/10.5281/zenodo.7254221"},
                        {"name": "World Database on Protected Areas", "url": "https://www.protectedplanet.net/"}],
        },
    ]

    return {
        "meta": {
            "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "pipeline_version": VERSION,
            "checked": "2026-11-14",
            "kinds": {"sourced": "copied from the cited source", "computed": "computed from our data and a "
                      "cited factor", "estimate": "order-of-magnitude estimate; formula shown"},
            "sources": [oig_src, factor_src, method_src,
                        {"name": "GSA per diem FY2026", "url": S.GSA_URL},
                        {"name": "NASA CLPS overview", "url": "https://www.nasa.gov/commercial-lunar-payload-services/"},
                        {"name": "ESA WorldCover 10 m 2021 v200", "url": "https://doi.org/10.5281/zenodo.7254221"}],
        },
        "headline": headline,
        "money": S.MONEY,
        "testing_cost": {
            "published": None, "not_found": S.TESTING_NOT_FOUND, "context": S.TESTING_CONTEXT,
            "estimate": {"value_usd": week, "kind": "estimate", "people": C.TEAM_SIZE, "days": C.FIELD_DAYS,
                         "lodging_usd": S.GSA_LODGING_USD, "mie_usd": S.GSA_MIE_USD,
                         "formula": headline[1]["formula"], "excludes": "airfare, vehicles, equipment, salaries",
                         "source": S.GSA_URL},
            "ratio_contract_to_week": round(ratio),
        },
        "co2": {
            "factor_kg_per_pkm": S.FACTOR_WITH_RF, "factor_no_rf_kg_per_pkm": S.FACTOR_WITHOUT_RF,
            "factor_source": factor_src, "method_source": method_src,
            "formula": "kg CO2e per person = great-circle km × 2 (round trip) × factor",
            "distance": "haversine, mean Earth radius 6371.0088 km; no extra uplift (8% is inside the factor)",
            "bases": C.BASES, "team_size": C.TEAM_SIZE,
            "limits": ["Straight-line distance; connecting flights and ground legs add emissions.",
                       "One average factor for all flight lengths; short flights emit more per km."],
            "per_region": rows, "summary": summaries,
            "headline": f"Picking the nearest of our top-3 matches saves on average "
                        f"{cal['mean_team_saving_t_vs_farthest']} t CO2e per 10-person team from Calgary "
                        f"(median {cal['median_team_saving_t_vs_farthest']} t, up to "
                        f"{cal['max_team_saving_t_vs_farthest']} t).",
        },
        "environment": env,
    }


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    doc = build()
    out = WEB_DATA / "impact.json"
    tmp = out.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(doc, indent=1, ensure_ascii=False, allow_nan=False))
    tmp.replace(out)
    for h in doc["headline"]:
        log.info("%-11s %s%s %s  %s (%s)", h["id"], h["prefix"], h["value"], h["unit"], h["label"], h["kind"])
    log.info("%s", doc["co2"]["headline"])
    log.info("wrote %s", out)


if __name__ == "__main__":
    main()
