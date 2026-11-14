"""Jobs 2 and 4: model contest. Every model gets the same features and the same tests (METHOD.md).

Run: python src/models.py <scratch_dir>
Output: results/model_contest.csv (V1, V2, V3 per model x feature set), <scratch>/scores.pkl (all Earth scores)
"""
import os
import pickle
import sys
import warnings
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.metrics import roc_auc_score

sys.path.insert(0, str(Path(__file__).parent))
from terrain import A_COLS, B_COLS, BASE_COLS, C_COLS

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[1]
# Job 2: one combined site-profile match per Moon site (terrain + light + camera); Job 4: base criteria.
# M1 won the crater-edge contest, so edge_m2 is left out.
SETS = {"Site_profile": [c for c in A_COLS if c != "edge_m2"] + B_COLS + C_COLS, "Base": BASE_COLS}
MODELS = ["knn_baseline", "mahalanobis", "isoforest", "ocsvm", "rf", "xgboost", "lightgbm", "catboost", "tabpfn", "dinov2"]
LEARNED = MODELS[1:]


def load(scratch):
    mw = pd.read_csv(ROOT / "results" / "moon_windows.csv")
    mw["id"] = [f"moon_{i}" for i in mw.index]
    ew = pd.read_csv(ROOT / "results" / "earth_windows.csv")
    bare = ew[ew.kind == "bare"].reset_index(drop=True)
    # water gate (METHOD.md change 12): drop windows with > 5% sea level or perfectly flat water patches
    wc = pd.read_csv(ROOT / "results" / "earth_water_check.csv").set_index("id")
    dry = ((wc.loc[bare.id, "sea"] <= 0.05) & (wc.loc[bare.id, "flatpatch"] <= 0.05)).values
    bare = bare[dry].reset_index(drop=True)
    bare.attrs["dry_mask"] = dry
    known = ew[(ew.kind == "known") & (ew.body == "moon")].reset_index(drop=True)
    bare["group"] = (np.floor(bare.lat) * 1000 + np.floor(bare.lon)).astype(int)
    rng = np.random.default_rng(0)
    bare["fold"] = 0
    groups = bare.group.unique()
    gfold = dict(zip(groups, rng.permutation(len(groups)) % 5))
    bare["fold"] = bare.group.map(gfold)
    # spatial-block holdout of 20% of each region's Moon windows (blocks of 7.68 km)
    mw["test"] = False
    for reg, g in mw.groupby("region"):
        blk = (np.floor(g.x / 7680) * 1000 + np.floor(g.y / 7680)).astype(int)
        ub = rng.permutation(blk.unique())
        held, n = [], 0
        for b in ub:
            if n >= 0.2 * len(g):
                break
            held.append(b); n += (blk == b).sum()
        mw.loc[g.index[blk.isin(held)], "test"] = True
    emb = np.load(Path(scratch) / "embeddings.npz") if (Path(scratch) / "embeddings.npz").exists() else None
    return mw, bare, known, emb


def robust(X, ref):
    med = np.median(ref, 0)
    iqr = np.subtract(*np.percentile(ref, [75, 25], 0))
    return (X - med) / np.where(iqr > 0, iqr, 1)


def one_class_scores(name, Mtr, others):
    """Fit on training Moon windows only; return scores (higher = more Moon-like) for each array in others."""
    if name == "knn_baseline":
        from sklearn.neighbors import NearestNeighbors
        nn = NearestNeighbors(n_neighbors=min(5, len(Mtr))).fit(Mtr)
        return [-nn.kneighbors(o)[0].mean(1) for o in others]
    if name == "mahalanobis":
        from sklearn.covariance import MinCovDet
        mcd = MinCovDet(random_state=0).fit(Mtr)
        return [-mcd.mahalanobis(o) for o in others]
    if name == "isoforest":
        from sklearn.ensemble import IsolationForest
        m = IsolationForest(n_estimators=300, random_state=0).fit(Mtr)
        return [m.score_samples(o) for o in others]
    if name == "ocsvm":
        from sklearn.svm import OneClassSVM
        m = OneClassSVM(gamma="scale", nu=0.1).fit(Mtr)
        return [m.score_samples(o) for o in others]


def clf(name, n_pos, n_neg):
    w = n_neg / max(n_pos, 1)
    if name == "rf":
        from sklearn.ensemble import RandomForestClassifier
        return RandomForestClassifier(300, class_weight="balanced", n_jobs=1, random_state=0)
    if name == "xgboost":
        from xgboost import XGBClassifier
        return XGBClassifier(n_estimators=300, max_depth=4, learning_rate=0.05, scale_pos_weight=w, n_jobs=1, verbosity=0)
    if name == "lightgbm":
        from lightgbm import LGBMClassifier
        return LGBMClassifier(n_estimators=300, learning_rate=0.05, class_weight="balanced", n_jobs=1, verbose=-1)
    if name == "catboost":
        from catboost import CatBoostClassifier
        return CatBoostClassifier(iterations=300, auto_class_weights="Balanced", thread_count=1, verbose=0, random_seed=0)


def combo(args):
    """All non-TabPFN models for one feature set x region x scale. Returns {model: (moon_test, earth_oof, known)}."""
    cols, mw, bare, known, reg, emb = args
    g = mw[mw.region == reg]
    Mtr, Mte = g[~g.test][cols].values, g[g.test][cols].values
    E, K = bare[cols].values, known[cols].values
    ok = np.isfinite(E).all(1)
    E = np.where(np.isfinite(E), E, np.nanmedian(E, 0))
    K = np.where(np.isfinite(K), K, np.nanmedian(E, 0))
    ref = np.vstack([g[cols].values, E])
    z = lambda X: robust(X, ref)
    out = {}
    for m in MODELS[:4]:
        s = one_class_scores(m, z(Mtr), [z(Mte), z(E), z(K)])
        out[m] = tuple(s)
    for m in MODELS[4:8]:
        se, sm, sk = np.zeros(len(E)), np.zeros(len(Mte)), np.zeros(len(K))
        for f in range(5):
            tr = bare.fold.values != f
            X = np.vstack([Mtr, E[tr]]); y = np.r_[np.ones(len(Mtr)), np.zeros(tr.sum())]
            model = clf(m, len(Mtr), tr.sum()).fit(X, y)
            se[~tr] = model.predict_proba(E[~tr])[:, 1]
            sm += model.predict_proba(Mte)[:, 1] / 5
            sk += model.predict_proba(K)[:, 1] / 5
        out[m] = (sm, se, sk)
    if emb is not None:
        out["dinov2"] = emb
    return out


def tabpfn_scores(cols, mw, bare, known, reg, n_ctx=600, seed=0):
    from tabpfn import TabPFNClassifier
    g = mw[mw.region == reg]
    rng = np.random.default_rng(seed)
    Mtr = g[~g.test][cols].values
    Mtr = Mtr[rng.permutation(len(Mtr))[:400]]
    Mte, E, K = g[g.test][cols].values, bare[cols].values, known[cols].values
    E = np.where(np.isfinite(E), E, np.nanmedian(E, 0)); K = np.where(np.isfinite(K), K, np.nanmedian(E, 0))
    perm = rng.permutation(len(E))
    halves = [perm[:n_ctx], perm[n_ctx:2 * n_ctx]]
    se, sm, sk = np.full(len(E), np.nan), np.zeros(len(Mte)), np.zeros(len(K))
    for h in range(2):
        ctx = halves[h]
        m = TabPFNClassifier(device="cpu", n_estimators=4, random_state=0, ignore_pretraining_limits=True)
        m.fit(np.vstack([Mtr, E[ctx]]), np.r_[np.ones(len(Mtr)), np.zeros(len(ctx))])
        pred_idx = np.setdiff1d(np.arange(len(E)), ctx) if h == 0 else halves[0]
        se[pred_idx] = m.predict_proba(E[pred_idx])[:, 1]   # Earth rows never in this fit's context
        sm += m.predict_proba(Mte)[:, 1] / 2
        sk += m.predict_proba(K)[:, 1] / 2
    return sm, se, sk


def tabpfn_scores_gpu(cols, mw, bare, known, reg):
    """Pre-registered setup on GPU: all training Moon windows + Earth windows of 4 folds, 5 grouped folds."""
    from tabpfn import TabPFNClassifier
    g = mw[mw.region == reg]
    Mtr, Mte = g[~g.test][cols].values, g[g.test][cols].values
    E, K = bare[cols].values, known[cols].values
    E = np.where(np.isfinite(E), E, np.nanmedian(E, 0)); K = np.where(np.isfinite(K), K, np.nanmedian(E, 0))
    se, sm, sk = np.zeros(len(E)), np.zeros(len(Mte)), np.zeros(len(K))
    for f in range(5):
        tr = bare.fold.values != f
        m = TabPFNClassifier(device="cuda", n_estimators=4, random_state=0, ignore_pretraining_limits=True)
        m.fit(np.vstack([Mtr, E[tr]]), np.r_[np.ones(len(Mtr)), np.zeros(tr.sum())])
        se[~tr] = m.predict_proba(E[~tr])[:, 1]
        sm += m.predict_proba(Mte)[:, 1] / 5
        sk += m.predict_proba(K)[:, 1] / 5
    return sm, se, sk


def dino_scores(emb_all, idmap, mw, bare, known, reg, key):
    E = emb_all[key]
    g = mw[mw.region == reg]
    Mtr = E[[idmap[i] for i in g[~g.test].id]]
    def s(ids):
        X = E[[idmap[i] for i in ids]]
        sim = X @ Mtr.T
        return np.sort(sim, 1)[:, -5:].mean(1)
    return s(g[g.test].id), s(bare.id), s(known.id)


def auc_boot(pairs, n=300, seed=0):
    """Mean AUC over regions, with 90% bootstrap interval. pairs = [(pos_scores, neg_scores), ...]"""
    rng = np.random.default_rng(seed)
    est = np.mean([roc_auc_score(np.r_[np.ones(len(p)), np.zeros(len(q))], np.r_[p, q]) for p, q in pairs])
    bs = []
    for _ in range(n):
        v = []
        for p, q in pairs:
            pi, qi = rng.integers(0, len(p), len(p)), rng.integers(0, len(q), len(q))
            v.append(roc_auc_score(np.r_[np.ones(len(p)), np.zeros(len(q))], np.r_[p[pi], q[qi]]))
        bs.append(np.mean(v))
    return est, np.percentile(bs, 5), np.percentile(bs, 95)


def main(scratch, use_tabpfn=True):
    mw, bare, known, emb = load(scratch)
    regions = sorted(mw.region.unique())
    idmap = {i: k for k, i in enumerate(emb["ids"])} if emb is not None else None
    scores = {}  # (set, scale, region, model) -> (moon_test, earth, known)
    jobs, keys = [], []
    for sname, cols in SETS.items():
        for scale in ("3.84", "1.92"):
            c = cols if scale == "3.84" else [f"{x}__1.92" for x in cols]
            for reg in regions:
                e = None
                if emb is not None:
                    e = dino_scores({"3.84": emb["emb384"], "1.92": emb["emb192"]}, idmap, mw, bare, known, reg, scale)
                jobs.append((c, mw, bare, known, reg, e)); keys.append((sname, scale, reg))
    with ProcessPoolExecutor(16) as ex:
        for k, out in zip(keys, ex.map(combo, jobs)):
            for m, v in out.items():
                scores[k + (m,)] = v
    print("classical models done", flush=True)
    tp = Path(scratch) / "tabpfn.pkl"
    if use_tabpfn and tp.exists():
        # TabPFN was run on the pool before the water gate: keep its Earth scores for dry windows only
        dry = bare.attrs["dry_mask"]
        for k, (sm, se, sk) in pickle.load(open(tp, "rb")).items():
            scores[k] = (sm, se[dry] if len(se) == len(dry) else se, sk)
    pickle.dump(dict(scores=scores, bare_ids=bare.id.values, known_ids=known.id.values,
                     moon_test=mw[mw.test].id.values), open(Path(scratch) / "scores.pkl", "wb"))
    rows = []
    for sname in SETS:
        for m in MODELS:
            if (sname, "3.84", regions[0], m) not in scores:
                continue
            v2 = auc_boot([(scores[(sname, "3.84", r, m)][0], scores[(sname, "3.84", r, m)][1]) for r in regions])
            v1 = auc_boot([(scores[(sname, "3.84", r, m)][2], scores[(sname, "3.84", r, m)][1]) for r in regions])
            v3 = np.mean([spearmanr(scores[(sname, "3.84", r, m)][1], scores[(sname, "1.92", r, m)][1],
                                    nan_policy="omit")[0] for r in regions])
            rows.append(dict(set=sname, model=m, V1_auc=v1[0], V1_lo=v1[1], V1_hi=v1[2],
                             V2_auc=v2[0], V2_lo=v2[1], V2_hi=v2[2], V3_spearman=v3, score=(v1[0] + v2[0]) / 2))
    res = pd.DataFrame(rows)
    # winner rule (METHOD.md): rank by mean of V1 and V2; a learned model replaces the baseline only if its
    # V2 lower bound beats the baseline's V2 estimate
    win = []
    for sname, g in res.groupby("set"):
        base_v2 = g[g.model == "knn_baseline"].V2_auc.iloc[0]
        elig = g[(g.model == "knn_baseline") | (g.V2_lo > base_v2)]
        win.append(elig.sort_values("score", ascending=False).model.iloc[0])
        res.loc[g.index, "winner"] = res.loc[g.index, "model"] == win[-1]
    res.to_csv(ROOT / "results" / "model_contest.csv", index=False, float_format="%.3f")
    pd.set_option("display.width", 250)
    print(res.round(3).to_string(index=False))


def tabpfn_only(scratch):
    """Slow model run on its own: writes <scratch>/tabpfn.pkl, merged by main()."""
    import torch
    torch.set_num_threads(16)
    mw, bare, known, _ = load(scratch)
    out = {}
    for sname, cols in SETS.items():
        for scale in ("3.84", "1.92"):
            c = cols if scale == "3.84" else [f"{x}__1.92" for x in cols]
            for reg in sorted(mw.region.unique()):
                fn = tabpfn_scores_gpu if os.environ.get("TABPFN_GPU") else tabpfn_scores
                out[(sname, scale, reg, "tabpfn")] = fn(c, mw, bare, known, reg)
                print(sname, scale, reg, flush=True)
    pickle.dump(out, open(Path(scratch) / "tabpfn.pkl", "wb"))


if __name__ == "__main__":
    if "--tabpfn-only" in sys.argv:
        tabpfn_only(sys.argv[1])
    else:
        main(sys.argv[1], use_tabpfn="--no-tabpfn" not in sys.argv)
