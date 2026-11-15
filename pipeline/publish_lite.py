"""Publish a small "lite" copy of the Earth tiles for static hosting (Vercel).

The full Earth tiles (web/public/data/earth/<id>.bin, Float32 500 x 500 at 30 m, ~350 MB in total) are
git-ignored, so a deploy built from the repo has none. This step writes, for every Earth site the web app can
open in 3D, a 250 x 250 (60 m) area-averaged copy quantised to Int16:

    web/public/data/earth_lite/<id>.i16z     Int16 grid, row 0 = north, corner origin, losslessly packed (below)
    web/public/data/earth_lite/index.json    {meta, tiles: {id: {size, res_m, origin_x, origin_y, crs,
                                               h_offset, h_scale, nodata_value, encoding}}}

Height in metres = v * h_scale + h_offset; v == nodata_value means no data.
Packing ("delta2d-planes-gzip"): d = 2D first difference of v (along columns, then along rows, prepend 0, wrapping
mod 2^16), stored as Int16 low-byte plane then high-byte plane, gzipped. Undo with a wrapping 2D prefix sum. Smooth
terrain makes d tiny, so a tile is ~43 KB instead of 125 KB raw; this keeps the whole static deploy well under
Vercel Hobby's ~100 MB upload cap. The web loader prefers the full
tile when present (local runs) and falls back to these (deploys). Earth hillshade PNGs are not used by the UI,
so none are published.

Usage: python -m pipeline.publish_lite [--force] [--size 250]
"""
from __future__ import annotations

import argparse
import gzip
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from pipeline.common.config import WEB_DATA

EARTH_DIR = WEB_DATA / "earth"
LITE_DIR = WEB_DATA / "earth_lite"
MAX_TOTAL_MB = 90.0
TARGET_STEP_M = 0.25  # quantisation step; widened per tile only if its relief would not fit in Int16
NODATA = -32768
VMAX = 32767
ENCODING = "delta2d-planes-gzip"
EXT = ".i16z"


def _pack(v: np.ndarray) -> bytes:
    a = v.astype(np.int32)
    d = np.diff(np.diff(a, axis=1, prepend=0), axis=0, prepend=0).astype("<i2")  # astype wraps mod 2^16
    b = d.reshape(-1).view(np.uint8).reshape(-1, 2)
    return gzip.compress(b[:, 0].tobytes() + b[:, 1].tobytes(), compresslevel=9, mtime=0)


def _unpack(blob: bytes, n: int) -> np.ndarray:
    raw = np.frombuffer(gzip.decompress(blob), dtype=np.uint8)
    lo, hi = raw[: n * n].astype(np.uint16), raw[n * n :].astype(np.uint16)
    d = (lo | (hi << 8)).view(np.int16).reshape(n, n).astype(np.int64)
    return (np.cumsum(np.cumsum(d, axis=0), axis=1) & 0xFFFF).astype(np.uint16).view(np.int16)


def _site_ids() -> dict[str, dict]:
    """Every Earth site the app can show in 3D, mapped to its tile reference (from earth_sites.json)."""
    sites = json.loads((WEB_DATA / "earth_sites.json").read_text())["sites"]
    by_id = {s["id"]: s for s in sites}
    wanted: set[str] = set(by_id)
    sources = {"earth_sites.json": len(by_id)}

    matches_path = WEB_DATA / "matches.json"
    if matches_path.exists():
        ids = {m["site_id"] for m in json.loads(matches_path.read_text()).get("matches", [])}
        sources["matches.json"] = len(ids)
        wanted |= ids

    walk_path = WEB_DATA / "walk" / "transects.json"
    if walk_path.exists():
        walk = json.loads(walk_path.read_text())
        ids = set(walk.get("sites", {})) | {it["site_id"] for it in walk.get("items", [])}
        sources["walk/transects.json"] = len(ids)
        wanted |= ids

    # Alberta uses its own committed tiles (alberta/<id>.bin), not earth/, so it adds nothing here.
    unknown = sorted(wanted - set(by_id))
    if unknown:
        print(f"warning: {len(unknown)} ids have no earth_sites.json entry (no tile ref), skipped: {unknown[:8]}")
    print("site sources: " + ", ".join(f"{k} {v}" for k, v in sources.items()))
    return {i: by_id[i] for i in sorted(wanted) if i in by_id}


def _block_nanmean(a: np.ndarray, f: int) -> np.ndarray:
    """Area average over f x f blocks, ignoring NaN; a block with no valid pixel stays NaN."""
    n = a.shape[0] // f
    blocks = a[: n * f, : n * f].reshape(n, f, n, f)
    valid = np.isfinite(blocks)
    total = np.where(valid, blocks, 0.0).sum(axis=(1, 3), dtype=np.float64)
    count = valid.sum(axis=(1, 3))
    out = np.full((n, n), np.nan, dtype=np.float64)
    np.divide(total, count, out=out, where=count > 0)
    return out


def _quantise(h: np.ndarray) -> tuple[np.ndarray, float, float]:
    finite = np.isfinite(h)
    if not finite.any():
        return np.full(h.shape, NODATA, dtype="<i2"), 0.0, TARGET_STEP_M
    lo, hi = float(np.nanmin(h)), float(np.nanmax(h))
    offset = round((lo + hi) / 2.0, 2)
    scale = TARGET_STEP_M
    while max(hi - offset, offset - lo) / scale > VMAX:
        scale *= 2.0
    v = np.zeros(h.shape, dtype=np.int32)
    v[finite] = np.clip(np.rint((h[finite] - offset) / scale), -VMAX, VMAX)
    v[~finite] = NODATA
    return v.astype("<i2"), offset, scale


def publish(force: bool, size: int) -> int:
    sites = _site_ids()
    print(f"earth sites to publish: {len(sites)}")
    LITE_DIR.mkdir(parents=True, exist_ok=True)
    index_path = LITE_DIR / "index.json"
    old: dict = json.loads(index_path.read_text())["tiles"] if index_path.exists() and not force else {}

    tiles: dict[str, dict] = {}
    written = reused = 0
    missing: list[str] = []
    for sid, site in sites.items():
        ref = site["tile"]
        src = WEB_DATA / ref["path"]
        dst = LITE_DIR / f"{sid}{EXT}"
        full_n = int(ref["size"])
        if full_n % size:
            raise SystemExit(f"{sid}: full size {full_n} is not a multiple of lite size {size}")
        f = full_n // size
        entry = {
            "size": size,
            "res_m": float(ref["res_m"]) * f,
            "origin_x": ref["origin_x"],
            "origin_y": ref["origin_y"],
            "crs": ref["crs"],
            "full_size": full_n,
            "full_res_m": float(ref["res_m"]),
        }
        if not src.exists():
            # Keep a previously published lite tile (e.g. regenerating on a machine without the full tiles).
            if sid in old and dst.exists() and old[sid].get("size") == size:
                tiles[sid] = old[sid]
                reused += 1
                continue
            missing.append(sid)
            continue
        fresh = sid in old and dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime
        same = old.get(sid, {})
        if fresh and same.get("size") == size and same.get("origin_x") == ref["origin_x"] and same.get("encoding") == ENCODING:
            tiles[sid] = old[sid]
            reused += 1
            continue
        raw = np.fromfile(src, dtype="<f4")
        if raw.size != full_n * full_n:
            raise SystemExit(f"{sid}: {src} has {raw.size} values, expected {full_n * full_n}")
        lite = _block_nanmean(raw.reshape(full_n, full_n).astype(np.float64), f)
        q, offset, scale = _quantise(lite)
        blob = _pack(q)
        if not np.array_equal(_unpack(blob, size), q):
            raise SystemExit(f"{sid}: packing round trip failed")
        dst.write_bytes(blob)
        entry.update({"h_offset": offset, "h_scale": scale, "nodata_value": NODATA, "encoding": ENCODING})
        tiles[sid] = entry
        written += 1

    # Drop lite tiles for sites no longer listed.
    removed = 0
    for p in LITE_DIR.iterdir():
        if p.name != "index.json" and (p.suffix != EXT or p.stem not in tiles):
            p.unlink()
            removed += 1

    index = {
        "meta": {
            "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "generator": "pipeline.publish_lite",
            "format": f"<id>{EXT}: Int16 grid v, row 0 = north, origin = top-left corner of pixel (0,0); "
            "height_m = v * h_scale + h_offset; v == nodata_value -> no data",
            "encoding": f"{ENCODING}: gzip of [low bytes, high bytes] of d = 2D first difference of v "
            "(axis 1 then axis 0, prepend 0, wrapping mod 2^16); decode with a wrapping 2D prefix sum",
            "method": "NaN-aware area mean over (full_size / size)^2 blocks of the full tile, then Int16",
            "count": len(tiles),
        },
        "tiles": tiles,
    }
    index_path.write_text(json.dumps(index, separators=(",", ":")))

    total = sum(p.stat().st_size for p in LITE_DIR.iterdir() if p.is_file())
    mb = total / 1e6
    print(f"written {written}, reused {reused}, removed {removed}, missing full tile {len(missing)}")
    if missing:
        print(f"  no full tile and no previous lite tile for: {missing[:10]}{' ...' if len(missing) > 10 else ''}")
    print(f"earth_lite: {len(tiles)} tiles, total {mb:.1f} MB in {LITE_DIR}")
    if mb > MAX_TOTAL_MB:
        print(
            f"ERROR: earth_lite is {mb:.1f} MB > {MAX_TOTAL_MB:.0f} MB (Vercel Hobby static cap is ~100 MB). "
            f"Re-run with a smaller size that divides the full tile, e.g. --size 100 (150 m) or --size 125 (120 m).",
            file=sys.stderr,
        )
        return 1
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--force", action="store_true", help="rewrite every lite tile even if up to date")
    ap.add_argument("--size", type=int, default=250, help="lite tile size in pixels (must divide 500); default 250")
    args = ap.parse_args()
    raise SystemExit(publish(args.force, args.size))


if __name__ == "__main__":
    main()
