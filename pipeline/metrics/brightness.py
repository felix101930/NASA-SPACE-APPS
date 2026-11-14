"""Surface brightness of a 15 km window, on the Moon and on Earth, as a within-world rank.

Moon: LOLA 1064 nm normal albedo, PDS product ``LDAM_50S_1000M_FLOAT`` (LRO-L-LOLA-4-GDR-V1.0,
Lemelin et al. 2016), 1000 m/px south polar stereographic (R = 1737.4 km, lon_0 = 0), 50-90 S.
LOLA measures albedo with its own 1064 nm laser at zero phase angle, so the map covers
permanently shadowed ground too. At 1 km/px a 15 km core holds ~15 x 15 pixels.

Earth: NASA MODIS ``MCD43C3`` v061 (Terra+Aqua BRDF/Albedo, daily, 0.05 deg climate-modelling
grid, LP DAAC). We use white-sky albedo (WSA, diffuse illumination: no sun-angle dependence)
and build a pseudo-1064 nm value by linear interpolation in wavelength between band 2
(841-876 nm, centre 858.5 nm) and band 5 (1230-1250 nm, centre 1240 nm):
``a1064 = 0.4613 * WSA_b2 + 0.5387 * WSA_b5``. Two dates (mid-January and mid-July 2023) are
combined per cell, preferring snow-free retrievals (``Percent_Snow`` <= 10 %). Why the 0.05 deg
CMG and not the 500 m tiles (MCD43A3): one 180 MB global file per date serves every window centre
in memory (~0.1 ms per point), whereas 500 m tiles would need ~300 granules per date for
5-15 k windows spread over all continents. CMG cells are 5.6 km N-S, so a 15 km window overlaps
3-4 x 3-4 cells: enough for a window mean, not for within-window texture.

Comparability: Moon normal albedo (zero phase, 1064 nm, laser) and Earth white-sky NIR albedo
differ in wavelength, geometry and definition, so raw values must not be compared. Each world's
value is turned into a **percentile rank within its own reference population of 15 km window
means** (:func:`brightness_rank_feature`): Moon = all 15 km blocks south of 80 S; Earth = all
snow-free land blocks of 3 x 3 CMG cells (~15 km) between 60 S and 75 N (or, better, the screened window
population the caller passes in). A z-score in log albedo is reported too.
"""
from __future__ import annotations

import json
import logging
import math
import netrc
import time
from datetime import datetime
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import TypedDict

import numpy as np
import requests

from pipeline.common.config import RAW

log = logging.getLogger(__name__)

BRIGHT_DIR = RAW / "brightness"
Q101 = np.linspace(0.0, 100.0, 101)

# ----------------------------------------------------------------------------- Moon (LOLA LDAM)
LDAM_URL = ("https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/"
            "polar/float_img/ldam_50s_1000m_float.img")
LDAM_LBL_URL = LDAM_URL[:-4] + ".lbl"
LDAM_BYTES = 25_644_096          # verified by HTTP HEAD, 2532 x 2532 float32 LE
LDAM_N = 2532
LDAM_RES = 1000.0
LDAM_OFFSET_PX = 1265.5          # LINE/SAMPLE_PROJECTION_OFFSET; x = (col - 1265.5) * 1000 (0-based centres)
MOON_SOURCE = {
    "name": "LOLA 1064 nm normal albedo LDAM_50S_1000M_FLOAT (LRO-L-LOLA-4-GDR-V1.0)",
    "url": LDAM_URL,
    "licence": "NASA PDS, public domain (no restrictions)",
    "citation": ("Lemelin, M., Lucey, P. G., Neumann, G. A., et al. (2016), Improved calibration of reflectance "
                 "data from the LRO Lunar Orbiter Laser Altimeter (LOLA) and implications for space weathering, "
                 "Icarus 273, 315-328, doi:10.1016/j.icarus.2016.02.006"),
}

# ----------------------------------------------------------------------------- Earth (MCD43C3)
CMR_GRANULES = "https://cmr.earthdata.nasa.gov/search/granules.json"
MCD43C3_DATES: tuple[str, ...] = ("2023-01-15", "2023-07-15")
CMG_RES_DEG = 0.05
CMG_SHAPE = (3600, 7200)
B2_W, B5_W = (1240.0 - 1064.0) / (1240.0 - 858.5), (1064.0 - 858.5) / (1240.0 - 858.5)
SNOW_MAX_PCT = 10
EARTH_SOURCE = {
    "name": "MODIS MCD43C3 v061 BRDF/Albedo daily 0.05 deg CMG (white-sky, bands 2 and 5 -> pseudo-1064 nm)",
    "url": "https://doi.org/10.5067/MODIS/MCD43C3.061",
    "licence": "NASA EOSDIS data, no restrictions on use (cite the DOI)",
    "citation": ("Schaaf, C., Wang, Z. (2021). MODIS/Terra+Aqua BRDF/Albedo Albedo Daily L3 Global 0.05Deg CMG "
                 "V061. NASA EOSDIS Land Processes DAAC. doi:10.5067/MODIS/MCD43C3.061"),
}
EARTH_CACHE = BRIGHT_DIR / "earth_points_cache.json"
EARTH_REF = BRIGHT_DIR / "earth_reference_q101.json"
MOON_REF = BRIGHT_DIR / "moon_reference_q101.json"


class BrightnessStats(TypedDict, total=False):
    bright_mean: float
    bright_p10: float
    bright_p50: float
    bright_p90: float
    bright_n_px: int
    bright_snow_frac: float
    bright_sw_mean: float
    bright_quantiles_101: list[float]


# =============================================================================================
# downloads
# =============================================================================================
def _download(url: str, dest: Path, session: requests.Session | None = None, expect_bytes: int | None = None,
              attempts: int = 4) -> Path:
    """Stream ``url`` to ``dest`` (atomic rename). Skips if ``dest`` exists with the expected size."""
    if dest.exists() and (expect_bytes is None or dest.stat().st_size == expect_bytes):
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    sess = session or requests.Session()
    for i in range(attempts):
        try:
            with sess.get(url, stream=True, timeout=120) as r:
                r.raise_for_status()
                with open(tmp, "wb") as fh:
                    for chunk in r.iter_content(chunk_size=1 << 20):
                        fh.write(chunk)
            if expect_bytes is not None and tmp.stat().st_size != expect_bytes:
                raise OSError(f"size {tmp.stat().st_size} != {expect_bytes}")
            tmp.rename(dest)
            log.info("downloaded %s (%.1f MB)", dest.name, dest.stat().st_size / 1e6)
            return dest
        except (requests.RequestException, OSError) as exc:
            if i == attempts - 1:
                raise
            log.warning("download %s failed (%s), retry %d", dest.name, str(exc)[:120], i + 1)
            time.sleep(5 * (i + 1))
    raise AssertionError("unreachable")


def earthdata_session() -> requests.Session:
    """requests session that authenticates to urs.earthdata.nasa.gov from ~/.netrc.

    requests drops the Authorization header on cross-host redirects and re-applies ~/.netrc for the
    new host, so the LP DAAC -> URS -> LP DAAC redirect chain works with cookies kept in the session.
    Credentials are never logged.
    """
    try:
        if netrc.netrc().authenticators("urs.earthdata.nasa.gov") is None:
            log.warning("no urs.earthdata.nasa.gov entry in ~/.netrc; Earthdata downloads will fail")
    except (FileNotFoundError, netrc.NetrcParseError):
        log.warning("~/.netrc missing or unreadable; Earthdata downloads will fail")
    s = requests.Session()
    s.trust_env = True
    return s


# =============================================================================================
# Moon
# =============================================================================================
def ldam_path() -> Path:
    return BRIGHT_DIR / "ldam_50s_1000m_float.img"


def load_ldam() -> np.ndarray:
    """LDAM albedo grid (2532 x 2532 float32, row 0 = grid +y); downloads once (25.6 MB)."""
    p = _download(LDAM_URL, ldam_path(), expect_bytes=LDAM_BYTES)
    a = np.fromfile(p, dtype="<f4").reshape(LDAM_N, LDAM_N)
    a = a.astype(np.float32)
    a[~np.isfinite(a) | (a <= 0)] = np.nan
    return a


def ldam_index(x_m: float | np.ndarray, y_m: float | np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Fractional (row, col) of polar-stereographic (x, y) in the LDAM grid (pixel centres at ints)."""
    col = np.asarray(x_m, dtype=np.float64) / LDAM_RES + LDAM_OFFSET_PX
    row = LDAM_OFFSET_PX - np.asarray(y_m, dtype=np.float64) / LDAM_RES
    return row, col


def _stats(v: np.ndarray, extra: dict[str, float] | None = None) -> BrightnessStats:
    v = v[np.isfinite(v)]
    nanv = float("nan")
    if not v.size:
        out: BrightnessStats = {"bright_mean": nanv, "bright_p10": nanv, "bright_p50": nanv, "bright_p90": nanv,
                                "bright_n_px": 0, "bright_quantiles_101": []}
    else:
        p10, p50, p90 = np.percentile(v, [10, 50, 90])
        out = {"bright_mean": float(v.mean()), "bright_p10": float(p10), "bright_p50": float(p50),
               "bright_p90": float(p90), "bright_n_px": int(v.size),
               "bright_quantiles_101": [round(float(x), 5) for x in np.percentile(v, Q101)]}
    if extra:
        out.update(extra)  # type: ignore[typeddict-item]
    return out


def moon_brightness(x_m: float, y_m: float, window_m: float = 15000.0, ldam: np.ndarray | None = None) -> BrightnessStats:
    """LOLA normal albedo over the square window centred on (x_m, y_m) (pixels whose centres fall inside)."""
    a = load_ldam() if ldam is None else ldam
    half = window_m / 2.0
    r0, c0 = ldam_index(x_m - half, y_m + half)
    r1, c1 = ldam_index(x_m + half, y_m - half)
    # half-open [start, stop) in pixel-centre coordinates -> exactly window/res pixels per axis
    rs = slice(int(math.ceil(float(r0) - 1e-9)), int(math.ceil(float(r1) - 1e-9)))
    cs = slice(int(math.ceil(float(c0) - 1e-9)), int(math.ceil(float(c1) - 1e-9)))
    return _stats(np.asarray(a[rs, cs], dtype=np.float64).ravel())


def block_means(a: np.ndarray, block: int) -> np.ndarray:
    """Non-overlapping ``block`` x ``block`` means (NaN-aware, NaN if < half the block valid)."""
    n0, n1 = (a.shape[0] // block) * block, (a.shape[1] // block) * block
    v = np.asarray(a[:n0, :n1], dtype=np.float64).reshape(n0 // block, block, n1 // block, block)
    ok = np.isfinite(v)
    cnt = ok.sum(axis=(1, 3))
    with np.errstate(invalid="ignore", divide="ignore"):
        m = np.where(ok, v, 0.0).sum(axis=(1, 3)) / cnt
    m[cnt < 0.5 * block * block] = np.nan
    return m


def moon_reference(max_lat_deg: float = -80.0, window_m: float = 15000.0, force: bool = False) -> list[float]:
    """101 quantiles of 15 km window-mean LDAM albedo over all blocks south of ``max_lat_deg``."""
    if MOON_REF.exists() and not force:
        d = json.loads(MOON_REF.read_text())
        if d.get("max_lat_deg") == max_lat_deg and d.get("window_m") == window_m:
            return d["q101"]
    a = load_ldam()
    blk = int(round(window_m / LDAM_RES))
    m = block_means(a, blk)
    n = m.shape[0]
    cc = ((np.arange(n) + 0.5) * blk - LDAM_OFFSET_PX - 0.5) * LDAM_RES   # block centre x / -y
    xx, yy = np.meshgrid(cc, -cc)
    rho = np.hypot(xx, yy)
    r_max = 2 * 1_737_400.0 * math.tan(math.radians(90.0 + max_lat_deg) / 2.0)
    v = m[(rho <= r_max) & np.isfinite(m)]
    q = [round(float(x), 5) for x in np.percentile(v, Q101)]
    MOON_REF.write_text(json.dumps({"max_lat_deg": max_lat_deg, "window_m": window_m, "n_blocks": int(v.size),
                                    "q101": q, "source": MOON_SOURCE}))
    return q


# =============================================================================================
# Earth
# =============================================================================================
def find_mcd43c3(date: str) -> tuple[str, str]:
    """(granule id, https URL) of the MCD43C3 v061 granule for ``date`` (YYYY-MM-DD) via CMR."""
    r = requests.get(CMR_GRANULES, params={"short_name": "MCD43C3", "version": "061",
                                           "temporal": f"{date}T00:00:00Z,{date}T23:59:59Z", "page_size": 20},
                     timeout=60)
    r.raise_for_status()
    doy = datetime.strptime(date, "%Y-%m-%d").strftime("A%Y%j")
    entries = sorted(r.json()["feed"]["entry"], key=lambda e: doy not in e["title"])  # exact DOY first
    for e in entries:
        for link in e.get("links", []):
            href = link.get("href", "")
            if href.startswith("https") and href.endswith(".hdf"):
                return e["title"], href
    raise LookupError(f"no MCD43C3 v061 granule for {date}")


def _cmg_npz(date: str) -> Path:
    return BRIGHT_DIR / f"mcd43c3_{date.replace('-', '')}.npz"


def prepare_mcd43c3(date: str, keep_hdf: bool = True) -> Path:
    """Download one MCD43C3 granule and cache the needed layers as a compact npz.

    npz keys: ``a1064`` (int16, albedo x 1000, -1 = fill), ``sw`` (shortwave WSA x 1000),
    ``snow`` (uint8 %, 255 = fill), ``granule`` (id).
    """
    out = _cmg_npz(date)
    if out.exists():
        return out
    from pyhdf.SD import SD, SDC  # HDF4 reader (GDAL wheels in this env lack HDF4)

    gid, url = find_mcd43c3(date)
    hdf = _download(url, BRIGHT_DIR / f"{gid}.hdf", session=earthdata_session())
    sd = SD(str(hdf), SDC.READ)

    def _read(name: str) -> tuple[np.ndarray, np.ndarray]:
        ds = sd.select(name)
        attrs = ds.attributes()
        raw = ds.get()
        fill = attrs.get("_FillValue")
        scale = float(attrs.get("scale_factor", 1.0))
        offset = float(attrs.get("add_offset", 0.0))
        bad = raw == fill if fill is not None else np.zeros(raw.shape, dtype=bool)
        vr = attrs.get("valid_range")
        if vr is not None:
            bad |= (raw < vr[0]) | (raw > vr[1])
        return (raw.astype(np.float64) - offset) * scale, bad

    b2, bad2 = _read("Albedo_WSA_Band2")
    b5, bad5 = _read("Albedo_WSA_Band5")
    sw, badsw = _read("Albedo_WSA_shortwave")
    snow, badsn = _read("Percent_Snow")
    sd.end()
    a1064 = B2_W * b2 + B5_W * b5
    a_i = np.where(bad2 | bad5, -1, np.clip(np.rint(a1064 * 1000), 0, 32000)).astype(np.int16)
    sw_i = np.where(badsw, -1, np.clip(np.rint(sw * 1000), 0, 32000)).astype(np.int16)
    sn_i = np.where(badsn, 255, np.clip(np.rint(snow), 0, 100)).astype(np.uint8)  # Percent_Snow is 0..100
    np.savez_compressed(out, a1064=a_i, sw=sw_i, snow=sn_i, granule=gid)
    log.info("cached %s: %.1f%% cells with valid pseudo-1064 albedo", out.name, 100.0 * (a_i >= 0).mean())
    if not keep_hdf:
        hdf.unlink()
    return out


_CMG: dict[str, np.ndarray] = {}


def load_cmg(dates: Sequence[str] = MCD43C3_DATES) -> dict[str, np.ndarray]:
    """Combined per-cell Earth albedo over ``dates``: snow-free mean if any, else mean of all valid.

    Returns ``a1064`` (float32, NaN fill), ``sw`` (float32), ``snowy`` (bool: only snowy retrievals).
    """
    key = "|".join(dates)
    if _CMG.get("_key") is not None and str(_CMG["_key"]) == key:
        return _CMG
    num_cl = np.zeros(CMG_SHAPE, np.float32)
    cnt_cl = np.zeros(CMG_SHAPE, np.int8)
    num_all = np.zeros(CMG_SHAPE, np.float32)
    cnt_all = np.zeros(CMG_SHAPE, np.int8)
    sw_cl = np.zeros(CMG_SHAPE, np.float32)
    sw_all = np.zeros(CMG_SHAPE, np.float32)
    for d in dates:
        z = np.load(prepare_mcd43c3(d))
        a = z["a1064"].astype(np.float32) / 1000.0
        sw = z["sw"].astype(np.float32) / 1000.0
        ok = z["a1064"] >= 0
        clear = ok & (z["snow"] <= SNOW_MAX_PCT)
        num_all += np.where(ok, a, 0)
        cnt_all += ok
        sw_all += np.where(ok, sw, 0)
        num_cl += np.where(clear, a, 0)
        cnt_cl += clear
        sw_cl += np.where(clear, sw, 0)
    with np.errstate(invalid="ignore", divide="ignore"):
        a_out = np.where(cnt_cl > 0, num_cl / cnt_cl, np.where(cnt_all > 0, num_all / cnt_all, np.nan))
        sw_out = np.where(cnt_cl > 0, sw_cl / cnt_cl, np.where(cnt_all > 0, sw_all / cnt_all, np.nan))
    _CMG.clear()
    _CMG.update({"a1064": a_out.astype(np.float32), "sw": sw_out.astype(np.float32),
                 "snowy": (cnt_cl == 0) & (cnt_all > 0), "_key": np.array(key)})
    return _CMG


def cmg_window(lat: float, lon: float, window_km: float = 15.0) -> tuple[slice, np.ndarray]:
    """CMG (row slice, col indices) of every cell that overlaps the window (>= 1 cell).

    A 15 km window overlaps 3-4 cells per axis (0.05 deg = 5.6 km N-S). Columns wrap across the
    antimeridian; rows are clipped at the poles.
    """
    half_lat = window_km / 2.0 / 111.32
    half_lon = min(half_lat / max(math.cos(math.radians(lat)), 0.05), 180.0)
    eps = 1e-9
    r0 = int(math.floor((90.0 - (lat + half_lat)) / CMG_RES_DEG + eps))
    r1 = int(math.ceil((90.0 - (lat - half_lat)) / CMG_RES_DEG - eps)) - 1
    c0 = int(math.floor((lon - half_lon + 180.0) / CMG_RES_DEG + eps))
    c1 = int(math.ceil((lon + half_lon + 180.0) / CMG_RES_DEG - eps)) - 1
    r0, r1 = max(r0, 0), min(max(r1, r0), CMG_SHAPE[0] - 1)
    rows = slice(r0, max(r1, r0) + 1)
    cols = np.arange(c0, max(c1, c0) + 1) % CMG_SHAPE[1]
    return rows, cols


def earth_brightness(lat: float, lon: float, window_km: float = 15.0,
                     cmg: dict[str, np.ndarray] | None = None) -> BrightnessStats:
    """Pseudo-1064 nm white-sky albedo statistics over the window centred on (lat, lon).

    Keys: ``bright_mean``, ``bright_p10/p50/p90``, ``bright_n_px`` (CMG cells), ``bright_snow_frac``
    (share of cells with only snowy retrievals), ``bright_sw_mean`` (shortwave WSA),
    ``bright_quantiles_101``.
    """
    g = load_cmg() if cmg is None else cmg
    rows, cols = cmg_window(lat, lon, window_km)
    a = g["a1064"][rows][:, cols].astype(np.float64).ravel()
    sw = g["sw"][rows][:, cols].astype(np.float64).ravel()
    snowy = g["snowy"][rows][:, cols].ravel()
    ok = np.isfinite(a)
    extra = {"bright_snow_frac": float(snowy[ok].mean()) if ok.any() else float("nan"),
             "bright_sw_mean": float(np.nanmean(sw)) if np.isfinite(sw).any() else float("nan")}
    return _stats(a, extra)


def _key(lat: float, lon: float, window_km: float) -> str:
    return f"{lat:.4f},{lon:.4f},{window_km:g}"


def earth_brightness_batch(points: Iterable[tuple[float, float]], window_km: float = 15.0,
                           use_cache: bool = True, with_quantiles: bool = False) -> list[BrightnessStats]:
    """``earth_brightness`` for many (lat, lon); results cached in data/raw/brightness/.

    The first call downloads two ~180 MB MCD43C3 granules (Earthdata login from ~/.netrc) and
    caches compact npz layers (~1 min); afterwards ~0.1 ms per point. ``with_quantiles=False`` drops the
    101-quantile list (only ~9 cells per window, so it adds little).
    """
    pts = list(points)
    cache: dict[str, BrightnessStats] = {}
    if use_cache and EARTH_CACHE.exists():
        cache = json.loads(EARTH_CACHE.read_text())
    todo = [p for p in pts if _key(p[0], p[1], window_km) not in cache]
    if todo:
        g = load_cmg()
        for lat, lon in todo:
            s = earth_brightness(lat, lon, window_km, g)
            if not with_quantiles:
                s.pop("bright_quantiles_101", None)
            cache[_key(lat, lon, window_km)] = s
        if use_cache:
            BRIGHT_DIR.mkdir(parents=True, exist_ok=True)
            EARTH_CACHE.write_text(json.dumps(cache, allow_nan=True))
        log.info("earth brightness: %d new points (%d cached)", len(todo), len(pts) - len(todo))
    return [cache[_key(lat, lon, window_km)] for lat, lon in pts]


def earth_reference(window_km: float = 15.0, lat_range: tuple[float, float] = (-60.0, 75.0),
                    force: bool = False) -> list[float]:
    """101 quantiles of window-mean pseudo-1064 albedo over snow-free land blocks of ~window_km.

    Blocks are 3 x 3 CMG cells (0.15 deg; ~16.7 km N-S). Ocean / fill cells are NaN in MCD43C3.
    """
    if EARTH_REF.exists() and not force:
        d = json.loads(EARTH_REF.read_text())
        if d.get("window_km") == window_km and tuple(d.get("lat_range", ())) == tuple(lat_range):
            return d["q101"]
    g = load_cmg()
    a = np.where(g["snowy"], np.nan, g["a1064"]).astype(np.float64)
    blk = max(1, int(round(window_km / (CMG_RES_DEG * 111.32))))
    m = block_means(a, blk)
    lat_c = 90.0 - (np.arange(m.shape[0]) + 0.5) * blk * CMG_RES_DEG
    band = (lat_c >= lat_range[0]) & (lat_c <= lat_range[1])
    v = m[band][np.isfinite(m[band])]
    q = [round(float(x), 5) for x in np.percentile(v, Q101)]
    EARTH_REF.write_text(json.dumps({"window_km": window_km, "lat_range": list(lat_range), "block_cells": blk,
                                     "n_blocks": int(v.size), "q101": q, "dates": list(MCD43C3_DATES),
                                     "source": EARTH_SOURCE}))
    return q


# =============================================================================================
# rank feature
# =============================================================================================
def percentile_rank(value: float, reference: Sequence[float] | np.ndarray) -> float:
    """Percentile rank (0..1) of ``value`` in ``reference``.

    ``reference`` is either a 101-quantile vector (monotone, length 101: interpolated) or a raw
    sample of reference values (empirical CDF, mid-rank for ties). NaN if value is NaN.
    """
    if value is None or not np.isfinite(value):
        return float("nan")
    ref = np.asarray(reference, dtype=np.float64)
    ref = ref[np.isfinite(ref)]
    if ref.size == 0:
        return float("nan")
    if ref.size == 101 and np.all(np.diff(ref) >= 0):
        lo, hi = np.searchsorted(ref, value, "left"), np.searchsorted(ref, value, "right")
        if hi > lo:                     # value sits on a run of equal quantiles: take the middle
            return float((lo + hi - 1) / 2.0 / 100.0)
        return float(np.interp(value, ref, Q101 / 100.0))
    srt = np.sort(ref)
    lo, hi = np.searchsorted(srt, value, "left"), np.searchsorted(srt, value, "right")
    return float((lo + hi) / 2.0 / srt.size)


def brightness_rank_feature(value: float, reference: Sequence[float] | np.ndarray) -> dict[str, float]:
    """Within-world brightness features for one window mean.

    ``bright_rank``: percentile rank (0..1) among the world's 15 km window means (the comparable
    quantity across worlds). ``bright_z``: z-score of log(albedo) against the reference (uses
    median and IQR/1.349 of log values; robust). Compare Moon vs Earth only through these, never
    through raw albedo.
    """
    ref = np.asarray(reference, dtype=np.float64)
    ref = ref[np.isfinite(ref) & (ref > 0)]
    rank = percentile_rank(value, ref)
    if ref.size == 0 or not np.isfinite(value) or value <= 0:
        return {"bright_rank": rank, "bright_z": float("nan")}
    lr = np.log(ref)
    med = float(np.median(lr))
    sig = float((np.percentile(lr, 75) - np.percentile(lr, 25)) / 1.349)
    z = (math.log(value) - med) / sig if sig > 0 else float("nan")
    return {"bright_rank": rank, "bright_z": float(z)}


RANK_SCALE = 0.5  # IQR of a percentile rank over its own population (uniform 0..1)


def brightness_distance(rank_earth: float, rank_moon: float) -> float:
    """|rank difference| / 0.5 (the population IQR of a rank), same style as other scalar terms."""
    return abs(rank_earth - rank_moon) / RANK_SCALE


__all__ = [
    "EARTH_SOURCE", "MOON_SOURCE", "RANK_SCALE", "brightness_distance", "brightness_rank_feature",
    "earth_brightness", "earth_brightness_batch", "earth_reference", "load_cmg", "load_ldam",
    "moon_brightness", "moon_reference", "percentile_rank", "prepare_mcd43c3",
]
