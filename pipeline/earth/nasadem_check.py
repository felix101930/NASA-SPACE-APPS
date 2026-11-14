"""NASADEM cross-check of the stage-2 30 m metrics (NASA JPL NASADEM_HGT v001, 1 arc-sec).

For each stage-2 site inside NASADEM coverage (56S-60N), the 30 m near field (same UTM grid,
same bilinear resampling, same 15 km buffer) is rebuilt from NASADEM; the far field stays the
same GLO-90 grid. Horizon + compute_all are rerun and compared with the Copernicus GLO-30
metrics. Credentials come from ~/.netrc (urs.earthdata.nasa.gov) and are never logged.
NASADEM heights are EGM96 (Copernicus: EGM2008); the few-metre geoid offset does not affect
slope, jump, roughness or horizon metrics, which depend on relative heights only.
"""
from __future__ import annotations

import json
import logging
import math
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import rasterio
import requests
from rasterio.enums import Resampling
from rasterio.merge import merge
from rasterio.warp import reproject

from pipeline.common.config import EARTH_R_EFF_M
from pipeline.earth import windows as W
from pipeline.earth.common import RAW
from pipeline.earth.dem import Geom, fill_nan, geo_bounds, read_dem

log = logging.getLogger("pipeline.earth.nasadem")

URL = ("https://data.lpdaac.earthdatacloud.nasa.gov/lp-prod-protected/NASADEM_HGT.001/"
       "NASADEM_HGT_{tag}/NASADEM_HGT_{tag}.zip")
LAT_MIN, LAT_MAX = -56.0, 60.0
CACHE = RAW / "nasadem"
CACHE.mkdir(parents=True, exist_ok=True)
SOURCE = {
    "name": "NASADEM Merged DEM Global 1 arc second V001 (NASADEM_HGT)",
    "url": "https://doi.org/10.5067/MEaSUREs/NASADEM/NASADEM_HGT.001",
    "licence": "NASA open data (no restrictions)",
    "citation": "NASA JPL (2020). NASADEM Merged DEM Global 1 arc second V001. NASA EOSDIS Land Processes DAAC. "
                "doi:10.5067/MEaSUREs/NASADEM/NASADEM_HGT.001",
}


class _URSSession(requests.Session):
    """Keep netrc auth across the redirect to urs.earthdata.nasa.gov (standard Earthdata pattern)."""
    AUTH_HOST = "urs.earthdata.nasa.gov"

    def rebuild_auth(self, prepared_request, response):
        headers = prepared_request.headers
        url = prepared_request.url
        if "Authorization" in headers:
            orig = requests.utils.urlparse(response.request.url).hostname
            redir = requests.utils.urlparse(url).hostname
            if orig != redir and redir != self.AUTH_HOST and orig != self.AUTH_HOST:
                del headers["Authorization"]
        if requests.utils.urlparse(url).hostname == self.AUTH_HOST:
            auth = requests.utils.get_netrc_auth(url)
            if auth:
                prepared_request.prepare_auth(auth)


_sess = None


def _session() -> requests.Session:
    global _sess
    if _sess is None:
        _sess = _URSSession()
    return _sess


def tag(lat_i: int, lon_i: int) -> str:
    return f"{'n' if lat_i >= 0 else 's'}{abs(lat_i):02d}{'e' if lon_i >= 0 else 'w'}{abs(lon_i):03d}"


def fetch_tile(lat_i: int, lon_i: int) -> Path | None:
    """Download (once) the NASADEM zip for a 1-deg tile. Returns None when the tile does not exist (ocean)."""
    t = tag(lat_i, lon_i)
    p = CACHE / f"NASADEM_HGT_{t}.zip"
    miss = CACHE / f"NASADEM_HGT_{t}.missing"
    if p.exists() and p.stat().st_size > 0:
        return p
    if miss.exists():
        return None
    for attempt in range(3):
        try:
            r = _session().get(URL.format(tag=t), timeout=180, stream=True)
            if r.status_code == 404:
                miss.write_text("404")
                return None
            r.raise_for_status()
            if "zip" not in r.headers.get("Content-Type", "") and "octet" not in r.headers.get("Content-Type", ""):
                raise RuntimeError(f"unexpected content type {r.headers.get('Content-Type')} (auth?)")
            tmp = p.with_suffix(".part")
            with open(tmp, "wb") as fh:
                for chunk in r.iter_content(1 << 20):
                    fh.write(chunk)
            zipfile.ZipFile(tmp).testzip()
            tmp.replace(p)
            return p
        except Exception as exc:  # noqa: BLE001
            log.warning("NASADEM %s attempt %d failed: %s", t, attempt + 1, type(exc).__name__)
            time.sleep(2 + attempt)
    return None


def _hgt_path(z: Path) -> str:
    with zipfile.ZipFile(z) as zf:
        name = next(n for n in zf.namelist() if n.endswith(".hgt"))
    return f"/vsizip/{z}/{name}"


def read_nasadem(g: Geom) -> np.ndarray:
    w, s, e, n = geo_bounds(g)
    paths = []
    for la in range(int(math.floor(s)), int(math.floor(n - 1e-9)) + 1):
        for lo in range(int(math.floor(w)), int(math.floor(e - 1e-9)) + 1):
            z = fetch_tile(la, lo)
            if z is not None:
                paths.append(_hgt_path(z))
    out = np.full((g.n, g.n), np.nan, np.float32)
    if not paths:
        return out
    srcs = [rasterio.open(p) for p in paths]
    try:
        mos, mtr = merge(srcs, bounds=(w, s, e, n), nodata=-32768, dtype="float32", resampling=Resampling.bilinear)
    finally:
        for sr in srcs:
            sr.close()
    a = mos[0]
    a[a <= -1000] = np.nan
    reproject(a, out, src_transform=mtr, src_crs="EPSG:4326", src_nodata=np.nan, dst_transform=g.transform,
              dst_crs=g.crs, dst_nodata=np.nan, resampling=Resampling.bilinear)
    return out


def result_path(site_id: str) -> Path:
    return W.SITE_DIR / f"{site_id}_nasadem.json"


def check_site(site_id: str, force: bool = False) -> dict:
    """NASADEM metrics for one processed site (not thread-safe: numba parallel horizon)."""
    from pipeline.earth.compute import FAR_RES_M, search_radius_m, true_north_grid_az
    from pipeline.earth.sun import low_sun_series
    from pipeline.metrics import compute_all, horizon_map
    rp = result_path(site_id)
    if rp.exists() and not force:
        return json.loads(rp.read_text())
    info = json.loads(W.info_path(site_id).read_text())
    if not (LAT_MIN <= info["lat"] < LAT_MAX):
        out = {"available": False, "reason": "outside NASADEM coverage (56S-60N)"}
        rp.write_text(json.dumps(out))
        return out
    _, g = W.load_near(site_id)
    near = _NEAR_CACHE.pop(site_id, None)
    if near is None:
        near = read_nasadem(g)
    if np.isnan(near[W.CORE_SLICE]).mean() > 0.2:
        out = {"available": False, "reason": "NASADEM missing/void over core"}
        rp.write_text(json.dumps(out))
        return out
    fg = g.with_res(FAR_RES_M, int(2 * W.FAR_RADIUS_M / FAR_RES_M) + 2)
    far = read_dem(fg, source=90, resampling=Resampling.average)
    far[np.isnan(far)] = 0.0
    near_f = fill_nan(near)
    radius = search_radius_m(float(np.nanmax(far)) - float(np.nanmin(near[W.CORE_SLICE])))
    H = horizon_map(near_f, W.RES, W.CORE_SLICE, dem_far=far, res_far=FAR_RES_M, near_origin_xy=g.origin,
                    far_origin_xy=fg.origin, n_az=72, max_radius_m=radius, planet_radius_m=EARTH_R_EFF_M)
    north = true_north_grid_az(info["lat"], info["lon"], g.epsg)
    el_s, az_s, _ = low_sun_series(info["lat"], info["lon"])
    m = compute_all(near_f[W.CORE_SLICE], H, W.RES, el_series=el_s, az_series=np.mod(az_s + north, 360.0))
    out = {"available": True, "metrics": m, "core_void_frac": float(np.isnan(near[W.CORE_SLICE]).mean())}
    rp.write_text(json.dumps(out, default=float))
    return out


_NEAR_CACHE: dict[str, np.ndarray] = {}


def run(site_ids: list[str], io_workers: int = 6) -> dict[str, dict]:
    """I/O (downloads + reprojection) in threads, metrics serially."""
    t0 = time.time()
    infos = {sid: json.loads(W.info_path(sid).read_text()) for sid in site_ids if W.info_path(sid).exists()}

    def io(sid):
        if result_path(sid).exists():
            return sid
        info = infos[sid]
        if LAT_MIN <= info["lat"] < LAT_MAX:
            try:
                _, g = W.load_near(sid)
                _NEAR_CACHE[sid] = read_nasadem(g)
            except Exception as exc:  # noqa: BLE001
                log.warning("NASADEM read failed %s: %s", sid, type(exc).__name__)
        return sid

    res = {}
    with ThreadPoolExecutor(io_workers) as ex:
        for i, sid in enumerate(ex.map(io, list(infos))):
            try:
                res[sid] = check_site(sid)
            except Exception as exc:  # noqa: BLE001
                log.warning("NASADEM check failed %s: %s", sid, exc)
                res[sid] = {"available": False, "reason": f"error: {type(exc).__name__}"}
            if (i + 1) % 10 == 0:
                log.info("NASADEM: %d/%d sites (%.0f s)", i + 1, len(infos), time.time() - t0)
    return res


def agreement(site_metrics: dict[str, dict], nasadem: dict[str, dict]) -> dict:
    """Per-metric Pearson r and median |diff| between Copernicus and NASADEM metrics."""
    keys = ["shadow_frac_el1", "shadow_frac_el3", "shadow_frac_el5", "shadow_frac_timeweighted", "jump1km_p95_m",
            "jump1km_p99_m", "frac_track_over_500m", "fast_per_km2_el3", "empty_cell_frac_el3", "slope_p50_deg",
            "slope_p90_deg"]
    out = {}
    ids = [i for i in site_metrics if nasadem.get(i, {}).get("available")]
    for k in keys:
        a = np.array([site_metrics[i].get(k, np.nan) for i in ids], float)
        b = np.array([nasadem[i]["metrics"].get(k, np.nan) for i in ids], float)
        ok = np.isfinite(a) & np.isfinite(b)
        if ok.sum() >= 3 and np.std(a[ok]) > 0 and np.std(b[ok]) > 0:
            out[k] = {"r": round(float(np.corrcoef(a[ok], b[ok])[0, 1]), 4),
                      "median_abs_diff": round(float(np.median(np.abs(a[ok] - b[ok]))), 4), "n": int(ok.sum())}
    return {"n_sites": len(ids), "per_metric": out}
