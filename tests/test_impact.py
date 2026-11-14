"""Tests for pipeline.impact: great-circle distance, CO2e formula, field-week estimate, per-region logic, output."""
from __future__ import annotations

import json

import pytest

from pipeline.common.config import WEB_DATA
from pipeline.impact import compute as C
from pipeline.impact import sources as S


def test_great_circle_calgary_houston() -> None:
    # Calgary (51.05, -114.07) to NASA JSC (29.56, -95.09): roughly 2,800-2,900 km (sphere gives ~2,862 km).
    km = C.great_circle_km(51.05, -114.07, 29.56, -95.09)
    assert 2750 < km < 2950
    assert km == pytest.approx(2862, abs=5)


def test_great_circle_known_values() -> None:
    assert C.great_circle_km(10.0, 20.0, 10.0, 20.0) == pytest.approx(0.0, abs=1e-9)
    # a quarter of a meridian
    assert C.great_circle_km(0, 0, 90, 0) == pytest.approx(C.EARTH_MEAN_R_KM * 3.141592653589793 / 2, rel=1e-9)
    # antipodes are half the circumference, and the function is symmetric
    assert C.great_circle_km(0, 0, 0, 180) == pytest.approx(C.EARTH_MEAN_R_KM * 3.141592653589793, rel=1e-9)
    assert C.great_circle_km(51.05, -114.07, -24.7, -69.2) == pytest.approx(
        C.great_circle_km(-24.7, -69.2, 51.05, -114.07))


def test_co2_formula() -> None:
    # 1,000 km one way, round trip, one person, with RF: 1000 * 2 * 0.10916 = 218.32 kg
    assert C.flight_co2e_kg(1000.0) == pytest.approx(218.32)
    assert C.flight_co2e_kg(1000.0, round_trip=False) == pytest.approx(109.16)
    assert C.flight_co2e_kg(1000.0, S.FACTOR_WITHOUT_RF, people=10) == pytest.approx(1289.8)
    assert C.flight_co2e_kg(0.0) == 0.0


def test_factor_values_are_desnz_2026() -> None:
    assert S.FACTOR_WITH_RF == 0.10916
    assert S.FACTOR_WITHOUT_RF == 0.06449
    assert S.FACTOR_WITHOUT_RF < S.FACTOR_WITH_RF


def test_field_week_estimate() -> None:
    assert C.field_week_cost_usd() == 10 * 7 * (110 + 68) == 12460


def _m(rid: str, hz: str, rank: int, lat: float, lon: float) -> dict:
    return {"region_id": rid, "hazard": hz, "rank": rank, "site_id": f"S{rank}", "lat": lat, "lon": lon,
            "distance": float(rank)}


def test_per_region_nearest_farthest() -> None:
    ms = [_m("r", "shadow", 1, 0.0, 0.0), _m("r", "shadow", 2, 51.0, -114.0), _m("r", "shadow", 3, -60.0, 100.0),
          _m("r", "shadow", 4, 51.05, -114.07)]  # rank 4 is ignored even though it is at the base
    rows = C.per_region(ms, {"r": "Region"})
    assert len(rows) == 1 and rows[0]["n_top"] == 3
    b = rows[0]["bases"]["calgary"]
    assert b["nearest_top3"]["rank"] == 2
    assert b["farthest_top3"]["rank"] == 3
    assert b["rank1"]["rank"] == 1
    assert not b["nearest_is_rank1"]
    expect = (b["farthest_top3"]["kg_co2e_pp"] - b["nearest_top3"]["kg_co2e_pp"]) * C.TEAM_SIZE / 1000
    assert b["team_saving_t_vs_farthest"] == pytest.approx(expect, abs=0.01)
    assert b["team_saving_t_vs_farthest"] >= b["team_saving_t_vs_rank1"] >= 0


def test_money_entries_are_sourced() -> None:
    for m in S.MONEY:
        assert m["source"].startswith("https://")
        assert m["quote"]
        assert m["value_usd"] is None or m["value_usd"] > 0


def test_output_contract() -> None:
    p = WEB_DATA / "impact.json"
    if not p.exists():
        pytest.skip("run python -m pipeline.impact first")
    d = json.loads(p.read_text())
    assert {"meta", "headline", "money", "testing_cost", "co2", "environment"} <= set(d)
    assert len(d["headline"]) == 4
    for h in d["headline"]:
        assert h["kind"] in d["meta"]["kinds"]
        assert h["sources"] and all(s["url"].startswith("https://") for s in h["sources"])
        assert h["formula"] and h["how"]
    assert len(d["co2"]["per_region"]) == 27
    assert d["headline"][0]["value"] == 172
