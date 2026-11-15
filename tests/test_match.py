"""Tests for pipeline.match: eligibility, distances, novelty, windows, contract keys, weight stability."""
from __future__ import annotations

import json

import numpy as np
import pytest

from pipeline.common.config import WEB_DATA
from pipeline.match import matches as MM
from pipeline.match.common import is_eligible, is_heldout_or_decoy

pytestmark = pytest.mark.filterwarnings("ignore")


# ------------------------------------------------------------------ synthetic fixtures
def _site(sid: str, role: str = "candidate", selected_by: str = "global_screen", lat: float = 0.0, lon: float = 0.0,
          shift: float = 0.0, **kw) -> dict:
    m = {"shadow_frac_el1": 0.6 + shift, "shadow_frac_el3": 0.5 + shift, "shadow_frac_el5": 0.4 + shift,
         "shadow_frac_timeweighted": 0.5 + shift, "jump1km_p95_m": 300 + 100 * shift, "jump1km_p99_m": 350 + 100 * shift,
         "frac_track_over_500m": 0.0, "fast_per_km2_el3": 10 + 10 * shift, "empty_cell_frac_el3": 0.4 + shift,
         "slope_p50_deg": 10 + 10 * shift}
    return {"id": sid, "name": sid, "role": role, "selected_by": selected_by, "lat": lat, "lon": lon,
            "dsm_safe": True, "metrics": m, **kw}


def _moon() -> dict:
    s = _site("moon")
    iqr = {k: [v - 0.05 * (abs(v) + 1), v + 0.05 * (abs(v) + 1)] for k, v in s["metrics"].items()}
    return {"values": s["metrics"], "iqr": iqr, "shape_scalars": {}, "shape_q": {}, "bright_rank": None,
            "sun": {"el_min": 2.0, "el_max": 5.0}, "az_shadow": None}


def _world(n_good: int = 6) -> tuple[dict, list[dict]]:
    """Held-out positive and decoy are PERFECT matches (shift 0); candidates are slightly off and far apart."""
    sites = [_site("HELD", role="heldout_positive", selected_by="validation", lat=10, lon=10),
             _site("DECOY", role="decoy", selected_by="validation", category="decoy", lat=20, lon=20),
             _site("DOCHOLD", role="heldout_positive", selected_by="documented", split="holdout", lat=30, lon=30)]
    sites += [_site(f"C{i}", shift=0.01 * (i + 1), lat=-40 + 5 * i, lon=100 + 5 * i) for i in range(n_good)]
    return {"r1": _moon()}, sites


# ------------------------------------------------------------------ tests
def test_eligibility_rules() -> None:
    assert is_eligible(_site("a"))
    assert is_eligible(_site("b", role="seed", selected_by="documented", split="seed"))
    assert not is_eligible(_site("c", role="heldout_positive", selected_by="documented", split="holdout"))
    assert not is_eligible(_site("d", role="heldout_positive", selected_by="validation"))
    assert not is_eligible(_site("e", role="decoy", selected_by="validation"))
    assert is_heldout_or_decoy(_site("f", category="decoy"))


def test_no_heldout_or_decoy_in_top3(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(MM, "load_catalog", lambda: [])
    moon_ref, sites = _world()
    rows, table, pool, _, searches, _ = MM.build_matches(moon_ref, sites, {})
    ids = {r["site_id"] for r in rows}
    assert ids and not ids & {"HELD", "DECOY", "DOCHOLD"}
    # they are still scored (best possible distance) for validation
    ranks = MM.validation_ranks(table, pool, sites)
    assert ranks["HELD"]["best_rank"] == 1 and ranks["DECOY"]["best_rank"] == 1


def test_distance_zero_and_symmetric() -> None:
    assert MM.scalar_distance(0.3, 0.3, 0.1) == 0.0
    assert MM.scalar_distance(0.2, 0.5, 0.1) == pytest.approx(MM.scalar_distance(0.5, 0.2, 0.1))
    q1, q2 = list(np.linspace(0, 1, 101)), list(np.linspace(0.2, 1.5, 101))
    assert MM.quantile_w1(q1, q1, 0.5) == 0.0
    assert MM.quantile_w1(q1, q2, 0.5) == pytest.approx(MM.quantile_w1(q2, q1, 0.5))
    moon = _moon()
    same = _site("x")
    terms = MM.site_terms(moon, same, None)
    for h in ("shadow", "rim", "texture"):
        assert MM.weighted_mean(terms[h], MM.TERM_WEIGHTS[h]) == pytest.approx(0.0)


def test_novelty_rule(monkeypatch: pytest.MonkeyPatch) -> None:
    moon_ref, sites = _world(0)
    # C0 best, C1 10 km from C0 (must be skipped), C2 near a catalogued site (excluded), C3/C4 far away
    sites += [_site("C0", shift=0.001, lat=0, lon=0), _site("C1", shift=0.002, lat=0.09, lon=0),
              _site("C2", shift=0.003, lat=40, lon=40), _site("C3", shift=0.02, lat=0, lon=5),
              _site("C4", shift=0.03, lat=-10, lon=-10)]
    monkeypatch.setattr(MM, "load_catalog", lambda: [{"id": "LA", "name": "cat", "lat": 40.2, "lon": 40.0}])
    rows, *_ , searches, coords = MM.build_matches(moon_ref, sites, {})
    top = [r["site_id"] for r in rows if r["region_id"] == "r1" and r["hazard"] == "rim"]
    assert top == ["C0", "C3", "C4"]
    for a in top:
        for b in top:
            if a != b:
                assert MM.haversine_km(*coords[a], *coords[b]) >= MM.NOVELTY_KM
    assert all(s["novelty_shortfall"] == 0 for s in searches)
    # shortfall is reported, never silently relaxed
    moon_ref, sites = _world(0)
    sites += [_site("D0", lat=0, lon=0), _site("D1", lat=0.1, lon=0.1)]
    rows, *_, searches, _ = MM.build_matches(moon_ref, sites, {})
    assert all(s["n_selected"] == 1 and s["novelty_shortfall"] == 2 for s in searches)


def test_weight_jaccard_one_at_zero_jitter(monkeypatch: pytest.MonkeyPatch) -> None:
    from pipeline.match.summary import weight_stability
    monkeypatch.setattr(MM, "load_catalog", lambda: [])
    moon_ref, sites = _world()
    _, table, pool, _, _, coords = MM.build_matches(moon_ref, sites, {})
    assert weight_stability(table, pool, n=5, jitter=0.0, coords=coords)["mean"] == 1.0


def test_window_finder_calgary_equinox() -> None:
    """Calgary, 2027-03-20 sunrise: our 3 deg window midpoint matches a 10 s astropy brute force within 2 min."""
    from astropy.time import Time

    from pipeline.match import windows as W
    lat, lon, elev = 51.0447, -114.0719, 1045.0
    wins = W.find_windows(lat, lon, elev, 3.0, None, start="2027-03-20T00:00:00", days=1)
    morning = [w for w in wins if w["sun_az"] < 180]
    assert len(morning) == 1
    w = morning[0]
    ts = Time("2027-03-20T12:00:00") + np.arange(0, 4 * 3600, 10) / 86400.0
    el, _ = W.sun_altaz(lat, lon, elev, ts)
    i = int(np.nonzero((el[:-1] < 3.0) & (el[1:] >= 3.0))[0][0])
    mid = w["start"] + (w["end"] - w["start"]) / 2
    assert abs((mid - ts[i]).to_value("min")) < 2.0
    assert abs(w["sun_el"] - 3.0) <= W.EL_TOL_DEG


def test_std_atmosphere() -> None:
    from pipeline.match.windows import std_atmosphere
    p0, t0 = std_atmosphere(0)
    p1, t1 = std_atmosphere(1500)
    assert p0 == pytest.approx(1013.25) and t0 == pytest.approx(15.0)
    assert 840 < p1 < 860 and t1 == pytest.approx(5.25)


def test_gap_text_plain_english() -> None:
    assert MM.gap_text("shadow_frac_el3", 0.27, 0.31) == "4% less of the ground in shadow at 3° sun"
    assert MM.gap_text("slope_p50_deg", 7.0, 10.0) == "slopes 3° gentler"


@pytest.mark.skipif(not (WEB_DATA / "matches.json").exists(), reason="run python -m pipeline.match all first")
def test_outputs_follow_contract() -> None:
    m = json.loads((WEB_DATA / "matches.json").read_text())
    s = json.loads((WEB_DATA / "summary.json").read_text())
    for doc in (m, s):
        assert {"generated_utc", "pipeline_version", "sources"} <= set(doc["meta"])
    sites = {x["id"]: x for x in json.loads((WEB_DATA / "earth_sites.json").read_text())["sites"]}
    assert m["matches"]
    for row in m["matches"]:
        assert {"region_id", "hazard", "rank", "site_id", "distance", "lights", "matches_text", "mismatches_text",
                "cannot_test", "windows"} <= set(row)
        assert row["hazard"] in ("shadow", "rim", "texture") and 1 <= row["rank"] <= 3
        if row["site_id"] in sites:  # snapshot may have been rewritten since
            assert not is_heldout_or_decoy(sites[row["site_id"]])
        for li in row["lights"]:
            assert {"metric", "moon", "moon_iqr", "earth", "gap_text", "light"} <= set(li)
            assert li["light"] in ("green", "amber", "red")
        for w in row["windows"]:
            assert {"start_utc", "end_utc", "sun_el", "sun_az", "el_kind"} <= set(w)
            assert w["start_utc"].endswith("Z")
    for r in s["ranking"]:
        assert {"region_id", "rank", "rehearsability", "per_hazard_best_distance", "reason"} <= set(r)
    v = s["validation"]
    assert {"shadow_vs_pgda", "known_vs_decoy_auc", "weight_stability_jaccard", "classifier_two_sample",
            "synthetic_tests", "where_it_fails"} <= set(v)
    assert {"pearson_r", "mae", "bias", "n_px", "note"} <= set(v["shadow_vs_pgda"])
    assert {"per_region_auc", "top_features"} <= set(v["classifier_two_sample"])
    assert "% Moon-like" not in json.dumps(m) + json.dumps(s)
