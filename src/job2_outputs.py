"""Jobs 2 and 4 outputs: top 3 Earth spots per region x danger (A, B, C) and per region for a base,
scored by each set's contest winner. Spots are >= 50 km apart and >= 50 km from every catalogued analog.
Danger spots get 2027 low-sun test dates (src/test_dates.py).

Run: python src/job2_outputs.py <scratch_dir>
Output: results/job2_test_sites.csv, results/job4_base_sites.csv
"""
import pickle
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from catalogs import load as load_catalog
from ground_check import passes
from models import SETS
from test_dates import REGION_LAT, best_test_date, region_max_sun_elev

ROOT = Path(__file__).resolve().parents[1]


def km(lat1, lon1, lat2, lon2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(np.radians(lon2 - lon1) / 2) ** 2
    return 6371 * 2 * np.arcsin(np.sqrt(a))


def main(scratch):
    S = pickle.load(open(Path(scratch) / "scores.pkl", "rb"))
    contest = pd.read_csv(ROOT / "results" / "model_contest.csv")
    winners = contest[contest.winner].set_index("set").model.to_dict()
    ew = pd.read_csv(ROOT / "results" / "earth_windows.csv")
    bare = ew.set_index("id").loc[S["bare_ids"]].reset_index()
    cat = pd.DataFrame(load_catalog())
    exc = pd.read_csv(ROOT / "results" / "excluded_spots.csv")   # dropped by novelty / ice checks
    excluded = np.array([km(r.lat, r.lon, exc.lat.values, exc.lon.values).min() < 5 for r in bare.itertuples()])
    near_known = np.array([km(r.lat, r.lon, cat.lat.values, cat.lon.values).min() for r in bare.itertuples()])
    mw = pd.read_csv(ROOT / "results" / "moon_windows.csv")
    rows = {"danger": [], "base": []}
    for sname, cols in SETS.items():
        model = winners[sname]
        for reg in sorted(mw.region.unique()):
            s = S["scores"][(sname, "3.84", reg, model)][1]
            order = np.argsort(-s)
            pct = pd.Series(s).rank(pct=True).values
            picked = []
            for i in order:
                if near_known[i] < 50 or excluded[i]:
                    continue
                if any(km(bare.lat[i], bare.lon[i], bare.lat[j], bare.lon[j]) < 50 for j in picked):
                    continue
                if not passes(bare.lat[i], bare.lon[i]):     # ice >= 30%, water > 5% or vegetation > 20%
                    continue
                picked.append(i)
                if len(picked) == 3:
                    break
            moon_med = mw[mw.region == reg][cols].median()
            for rank, i in enumerate(picked, 1):
                r = dict(region=reg, set=sname, model=model, rank=rank, lat=round(bare.lat[i], 4),
                         lon=round(bare.lon[i], 4), window=bare.id[i], score_percentile=round(pct[i], 4),
                         km_to_nearest_catalogued=round(near_known[i], 1))
                for c in cols:
                    r[f"earth_{c}"] = round(bare[c][i], 3)
                    r[f"moon_{c}"] = round(moon_med[c], 3)
                if sname != "Base":
                    t = best_test_date(bare.lat[i], bare.lon[i], region_max_sun_elev(REGION_LAT[reg]))
                    if t:
                        r["test_date"] = t["date"]; r["minutes_in_band"] = t["minutes"]; r["tz"] = t["tz"]
                        r["windows_local"] = "; ".join(f"{w['part']} {w['local'][0]}-{w['local'][1]} az {w['az'][0]:.0f}-{w['az'][1]:.0f}"
                                                       for w in t["windows"])
                rows["base" if sname == "Base" else "danger"].append(r)
    pd.DataFrame(rows["danger"]).to_csv(ROOT / "results" / "job2_test_sites.csv", index=False)
    pd.DataFrame(rows["base"]).to_csv(ROOT / "results" / "job4_base_sites.csv", index=False)
    d = pd.DataFrame(rows["danger"] + rows["base"])
    print(d[["region", "set", "model", "rank", "lat", "lon", "score_percentile", "km_to_nearest_catalogued"]].to_string(index=False))


if __name__ == "__main__":
    main(sys.argv[1])
