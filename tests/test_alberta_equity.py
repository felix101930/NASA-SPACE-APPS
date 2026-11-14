"""Tests for the Calgary Equity Index analysis (pipeline.alberta.equity_analysis)."""
from __future__ import annotations

import json

import numpy as np
import pytest

from pipeline.alberta import equity_analysis as EA
from pipeline.alberta import routes as R
from pipeline.common.config import WEB_DATA

EQ = WEB_DATA / "calgary" / "equity.json"


def _tract(ct: str, cat: str, score: float, pop: int = 1000, x: float = 0.0, y: float = 0.0) -> EA.TractRec:
    return EA.TractRec(ctuid=ct, name=ct, communities=f"COMM {ct}", category=cat, score=score, population=pop,
                       x=x, y=y, total_category=cat, total_score=score)


def _route(rid: str, ct: str | None, dist: float, dtw: float, n_routes: int = 1, x: float = 0.0,
           y: float = 0.0, park: str | None = None) -> EA.RouteRec:
    return EA.RouteRec(id=rid, ctuid=ct, park=park, length_m=1500.0, stop_name=f"Stop {rid}", stop_dist_m=dist,
                       stop_routes=[f"r{i}" for i in range(n_routes)], best_dtw=dtw, preset=0, x=x, y=y)


PRESETS = [{"region": "slater_plain", "region_name": "Slater Plain", "kind": "gentle", "length_m": 1500.0,
            "slope_deg": [0.0] * 100}]


def _toy() -> tuple[list[EA.TractRec], list[EA.RouteRec]]:
    tracts = [_tract("A", "Highest", 90, 2000, 0, 0), _tract("B", "Highest", 85, 1000, 5000, 0),
              _tract("C", "High", 70, 1500, 10000, 0), _tract("D", "Low", 40, 1200, 15000, 0),
              _tract("E", "Lowest", 30, 800, 20000, 0)]
    routes = [_route("R1", "A", 100, 0.5, 3, 0, 0),        # suitable
              _route("R2", "A", 50, 0.9, 1, 100, 0),       # suitable (second in A)
              _route("R3", "B", 600, 0.4, 2, 5000, 0),     # too far from a stop
              _route("R4", "C", 200, 1.2, 2, 10000, 0),    # no slope match
              _route("R5", "D", 10, 0.3, 4, 15000, 0),     # suitable
              _route("R6", None, 10, 0.3, 4, 0, 9000)]     # outside every tract
    return tracts, routes


def test_dtw_batch_matches_reference():
    rng = np.random.default_rng(1)
    a = rng.normal(0, 2, 100)
    B = rng.normal(0, 2, (7, 100))
    B[0] = a
    B[1] = np.roll(a, 4)
    got = EA.dtw_banded_batch(a, B, 10)
    ref = [R.dtw_banded(a, b, 10) for b in B]
    assert got == pytest.approx(ref, abs=1e-12)
    assert got[0] == pytest.approx(0.0)


def test_route_flags():
    r = _route("X", "A", 400.0, 0.999)
    assert r.near_stop and r.moon_match and r.suitable
    assert not _route("X", "A", 400.1, 0.5).suitable
    assert not _route("X", "A", 10, 1.0).suitable          # threshold is strict (< 1 deg), as in the UI


def test_coverage_counts_consistent():
    tracts, routes = _toy()
    rows = EA.coverage_by(tracts, routes)
    assert [r["category"] for r in rows] == EA.CATEGORIES
    by = {r["category"]: r for r in rows}
    assert (by["Highest"]["n_tracts"], by["Highest"]["n_covered"], by["Highest"]["n_with_any_route"]) == (2, 1, 2)
    assert by["Highest"]["population_covered"] == 2000 and by["Highest"]["pct_population_covered"] == pytest.approx(66.7)
    assert by["High"]["n_covered"] == 0 and by["Low"]["n_covered"] == 1 and by["Lowest"]["n_covered"] == 0
    assert by["Moderate"]["n_tracts"] == 0 and by["Moderate"]["pct_covered"] is None
    assert sum(r["n_tracts"] for r in rows) == len(tracts)
    assert by["Highest"]["n_suitable_routes"] == 2
    gap = EA.equity_gap(rows)
    assert gap["high_need"]["n_covered"] == 1 and gap["high_need"]["n_tracts"] == 3
    assert gap["low_need"]["n_covered"] == 1 and gap["low_need"]["n_tracts"] == 2
    assert gap["direction"] == "lower" and gap["gap_pct_points"] == pytest.approx(100 / 3 - 50, abs=0.1)
    assert "1 of 3 higher-need" in gap["statement"]


def test_ranking_deterministic_and_one_per_tract():
    tracts, routes = _toy()
    a = EA.rank_events(tracts, routes, PRESETS, n=5)
    b = EA.rank_events(tracts, list(reversed(routes)), PRESETS, n=5)
    assert a == b
    assert [e["ctuid"] for e in a] == ["A", "D"]           # only covered tracts; one per tract
    assert a[0]["route_id"] == "R1"                       # R1 beats R2 on transit x quality inside tract A
    f = a[0]["factors"]
    assert a[0]["score"] == pytest.approx(f["need"] * f["transit"] * f["quality"], abs=1e-3)
    assert [e["rank"] for e in a] == [1, 2]
    assert a[0]["near_stop"]["minutes_walk"] == 2         # ceil(100 m / 80 m per min)


def test_ranking_separation():
    tracts = [_tract("A", "Highest", 90, x=0), _tract("B", "Highest", 89, x=500), _tract("C", "High", 70, x=9000)]
    routes = [_route("R1", "A", 50, 0.5, 4, 0, 0), _route("R2", "B", 50, 0.5, 4, 500, 0),
              _route("R3", "C", 50, 0.5, 4, 9000, 0)]
    ids = [e["ctuid"] for e in EA.rank_events(tracts, routes, PRESETS, n=5, min_sep_km=2.0)]
    assert ids == ["A", "C"]
    assert [e["ctuid"] for e in EA.rank_events(tracts, routes, PRESETS, n=5, min_sep_km=0.0)] == ["A", "B", "C"]


def test_uncaptured_reasons_and_nearest():
    tracts, routes = _toy()
    tracts.append(_tract("F", "Highest", 95, 500, 0, 3000))
    u = EA.uncaptured(tracts, routes, "Highest")
    assert [t["ctuid"] for t in u] == ["F", "B"]          # highest score first
    assert u[0]["reason"] == "no_route" and u[1]["reason"] == "far_from_stop"
    assert u[0]["nearest_suitable"]["route_id"] in {"R1", "R2"}
    assert u[0]["nearest_suitable"]["dist_km"] == pytest.approx(3.0 / EA.K, abs=0.1)


def test_labels():
    assert EA.nice("CANYON MEADOWS, 03W") == "Canyon Meadows"
    assert EA.nice("03W") == ""
    assert EA.park_label("Mckenzie-fish Creek Park Buffer; Depot") == "Mckenzie-Fish Creek Park Buffer"


@pytest.mark.skipif(not EQ.exists(), reason="equity.json not built")
def test_equity_json_contract_and_consistency():
    d = json.loads(EQ.read_text())
    assert set(d) >= {"meta", "headline", "summary", "coverage", "coverage_total_equity", "gap", "top_events",
                      "uncaptured_highest"}
    assert any("Open Government Licence" in s["licence"] for s in d["meta"]["sources"])
    rows = d["coverage"]
    assert [r["category"] for r in rows] == EA.CATEGORIES
    assert sum(r["n_tracts"] for r in rows) == d["summary"]["n_tracts"] == 288
    assert sum(r["n_covered"] for r in rows) == d["summary"]["n_tracts_covered"]
    for r in rows:
        assert 0 <= r["n_covered"] <= r["n_with_any_route"] <= r["n_tracts"]
        assert r["population_covered"] <= r["population"]
    hi = rows[0]
    assert d["headline"].startswith(f"{hi['n_covered']} of {hi['n_tracts']} highest-need")
    assert d["uncaptured_highest"]["n"] == hi["n_tracts"] - hi["n_covered"]
    assert d["gap"]["high_need"]["n_covered"] == rows[0]["n_covered"] + rows[1]["n_covered"]
    ev = d["top_events"]
    assert len(ev) == 5 and len({e["ctuid"] for e in ev}) == 5
    assert [e["score"] for e in ev] == sorted((e["score"] for e in ev), reverse=True)
    for e in ev:
        assert e["near_stop"]["dist_m"] <= 400 and e["moon_match"]["dtw_deg"] < 1.0
    assert d["summary"]["n_suitable_matching_a_steeper_moon_route"] == 0


@pytest.mark.skipif(not EQ.exists(), reason="equity.json not built")
def test_matcher_reproduces_presets():
    """The vectorised matcher gives the same best DTW as presets.json's strict_best for every Moon route."""
    p = json.loads((WEB_DATA / "calgary" / "presets.json").read_text())["presets"]
    w = json.loads((WEB_DATA / "calgary" / "walks.json").read_text())["items"]
    prof = np.fromfile(WEB_DATA / "calgary" / "walks.bin", dtype="<f4").reshape(len(w), 100)
    lens = np.array([i["length_m"] for i in w])
    for pr in p[:4]:
        ok = np.where((lens >= 0.6 * pr["length_m"]) & (lens <= 1.6 * pr["length_m"]))[0]
        d = EA.dtw_banded_batch(np.asarray(pr["slope_deg"]), prof[ok], EA.DTW_BAND)
        assert float(d.min()) == pytest.approx(pr["match"]["strict_best"]["dtw_deg"], abs=1e-3)
        assert w[int(ok[int(np.argmin(d))])]["id"] == pr["match"]["strict_best"]["id"]


def test_school_routes_not_counted():
    assert EA.is_school_route("794 F.E. Osborne/ Silver Springs") and EA.is_school_route("697 14 St NW/ Various Schools")
    assert not EA.is_school_route("134 Rockland Park") and not EA.is_school_route("503 Symons Valley Express")
    r = EA.RouteRec(id="X", ctuid="A", park=None, length_m=1500.0, stop_name="S", stop_dist_m=10.0,
                    stop_routes=["1 Bowness", "720 Beaverbrook/ Prestwick"], best_dtw=0.5, preset=0, x=0.0, y=0.0)
    assert r.public_routes == ["1 Bowness"]
