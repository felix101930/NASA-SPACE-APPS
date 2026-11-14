"""Classifier two-sample test (Lopez-Paz & Oquab 2017) between a Moon tile and an Earth tile.

Both 30 m tiles are cut into 1 km sub-tiles (33 x 33 px, 15 x 15 per tile). Each sub-tile gets six
terrain features. Logistic regression and a small random forest try to tell Moon from Earth;
cross-validation is grouped by 5 km block (3 x 3 blocks per tile, stratified), so neighbouring
sub-tiles never straddle train and test. Out-of-fold ROC-AUC ~0.5 = indistinguishable on these
features (good analog); ~1.0 = trivially separable. Importance = permutation importance (drop in
AUC) on held-out folds.
"""
from __future__ import annotations

import logging
import math
import warnings

import numpy as np

log = logging.getLogger("pipeline.match.classifier")

RES_M = 30.0
SUB_PX = 33                 # ~1 km
BLOCK_SUB = 5               # 5 x 5 sub-tiles = ~5 km group
N_SPLITS = 6
FEATURES = ("slope_mean_deg", "slope_p90_deg", "relief_m", "roughness_m", "jump1km_p95_m", "curvature_std_per_km")


def subtile_features(dem: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(X [n, 6], block id [n]) for complete (NaN-free) 1 km sub-tiles of a 500 x 500 tile."""
    from scipy import ndimage

    from pipeline.metrics import slope_deg
    z = np.asarray(dem, float)
    slope = slope_deg(z, RES_M)
    lap = ndimage.laplace(np.nan_to_num(z, nan=float(np.nanmean(z)))) / RES_M ** 2 * 1000.0  # 1/km
    lag = SUB_PX
    jumps = []
    for dr, dc in ((0, lag), (lag, 0), (lag, lag), (lag, -lag)):
        j = np.full(z.shape, np.nan)
        r0, r1 = 0, z.shape[0] - dr
        if dc >= 0:
            j[r0:r1, 0:z.shape[1] - dc] = np.abs(z[dr:, dc:] - z[:r1, :z.shape[1] - dc])
        else:
            j[r0:r1, -dc:] = np.abs(z[dr:, :dc] - z[:r1, -dc:])
        jumps.append(j)
    jump = np.stack(jumps)
    n = z.shape[0] // SUB_PX
    rows, blocks = [], []
    yy, xx = np.mgrid[0:SUB_PX, 0:SUB_PX]
    A = np.c_[yy.ravel(), xx.ravel(), np.ones(SUB_PX * SUB_PX)]
    for i in range(n):
        for k in range(n):
            rs, cs = slice(i * SUB_PX, (i + 1) * SUB_PX), slice(k * SUB_PX, (k + 1) * SUB_PX)
            sub = z[rs, cs]
            if not np.isfinite(sub).all():
                continue
            coef, *_ = np.linalg.lstsq(A, sub.ravel(), rcond=None)
            resid = sub.ravel() - A @ coef
            js = jump[:, rs, cs]
            js = js[np.isfinite(js)]
            rows.append([float(np.nanmean(slope[rs, cs])), float(np.nanpercentile(slope[rs, cs], 90)),
                         float(sub.max() - sub.min()), float(resid.std()),
                         float(np.percentile(js, 95)) if js.size else float("nan"), float(lap[rs, cs].std())])
            blocks.append((i // BLOCK_SUB) * math.ceil(n / BLOCK_SUB) + k // BLOCK_SUB)
    X = np.asarray(rows, float).reshape(-1, len(FEATURES))
    return X, np.asarray(blocks, int)


def two_sample_test(moon_dem: np.ndarray, earth_dem: np.ndarray, seed: int = 0) -> dict:
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.inspection import permutation_importance
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import roc_auc_score
    from sklearn.model_selection import StratifiedGroupKFold
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    Xm, bm = subtile_features(moon_dem)
    Xe, be = subtile_features(earth_dem)
    X = np.vstack([Xm, Xe])
    y = np.r_[np.ones(len(Xm)), np.zeros(len(Xe))]
    g = np.r_[bm, 100 + be]
    ok = np.isfinite(X).all(axis=1)
    X, y, g = X[ok], y[ok], g[ok]
    if len(np.unique(g[y == 1])) < 3 or len(np.unique(g[y == 0])) < 3:
        return {"lr_auc": None, "rf_auc": None, "importance": {}, "n_moon": int((y == 1).sum()),
                "n_earth": int((y == 0).sum()), "note": "too few complete sub-tiles"}
    models = {
        "lr": lambda: make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000)),
        "rf": lambda: RandomForestClassifier(n_estimators=100, max_depth=4, random_state=seed, n_jobs=1),
    }
    cv = StratifiedGroupKFold(n_splits=N_SPLITS, shuffle=True, random_state=seed)
    oof = {k: np.full(len(y), np.nan) for k in models}
    imp = {k: [] for k in models}
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        for tr, te in cv.split(X, y, g):
            if len(np.unique(y[tr])) < 2:
                continue
            for name, mk in models.items():
                m = mk().fit(X[tr], y[tr])
                oof[name][te] = m.predict_proba(X[te])[:, 1]
                if len(np.unique(y[te])) == 2:
                    pi = permutation_importance(m, X[te], y[te], scoring="roc_auc", n_repeats=3, random_state=seed)
                    imp[name].append(pi.importances_mean)
    res = {"n_moon": int((y == 1).sum()), "n_earth": int((y == 0).sum())}
    for name in models:
        f = np.isfinite(oof[name])
        res[f"{name}_auc"] = round(float(roc_auc_score(y[f], oof[name][f])), 3) if f.sum() > 10 else None
    best = "rf" if (res.get("rf_auc") or 0) > (res.get("lr_auc") or 0) else "lr"
    vals = np.mean(imp[best], axis=0) if imp[best] else np.zeros(len(FEATURES))
    res["importance"] = {f: round(float(v), 4) for f, v in zip(FEATURES, vals)}
    res["importance_model"] = best
    res["auc"] = max(v for v in (res.get("lr_auc"), res.get("rf_auc")) if v is not None) if (
        res.get("lr_auc") is not None or res.get("rf_auc") is not None) else None
    return res
