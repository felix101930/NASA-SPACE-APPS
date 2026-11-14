"""Rehearsal windows: when the Sun's apparent elevation at an Earth site matches the Moon target.

Sun position: astropy ``get_sun`` -> ``AltAz`` with refraction (pressure/temperature from a standard
atmosphere at the site elevation, 50 % humidity, 0.55 um). Search: 20-minute coarse grid over one
year, then 2-minute refinement only around coarse steps near the target elevation.
"""
from __future__ import annotations

import logging
import math
import warnings
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

log = logging.getLogger("pipeline.match.windows")

START_UTC = "2026-11-15T00:00:00"
SEARCH_DAYS = 365
COARSE_MIN = 20
FINE_MIN = 2
EL_TOL_DEG = 0.25
AZ_TOL_DEG = 10.0
MAX_WINDOWS = 6
REFRACTION_SENSITIVE_DEG = 1.0
TARGET_EL = {"texture": 3.0, "rim": 5.0}          # shadow: per region, see shadow_target_el
SHADOW_EL_CLAMP = (1.0, 5.0)
EL_KIND = "apparent (refraction applied)"
MIN_DIRECTIONALITY = 0.25    # (max - min) / mean of Moon shadow fraction over azimuth
MIN_ASPECT_R = 0.10          # below this a tile has no dominant slope direction


def _astropy():
    import astropy.units as u
    from astropy.coordinates import AltAz, EarthLocation, get_sun
    from astropy.time import Time
    from astropy.utils import iers
    iers.conf.auto_download = False
    iers.conf.iers_degraded_accuracy = "warn"
    return u, AltAz, EarthLocation, get_sun, Time


def std_atmosphere(elev_m: float) -> tuple[float, float]:
    """(pressure hPa, temperature degC) of the ICAO standard atmosphere at ``elev_m``."""
    h = max(-400.0, min(float(elev_m or 0.0), 8000.0))
    p = 1013.25 * (1.0 - 2.25577e-5 * h) ** 5.25588
    t = 15.0 - 0.0065 * h
    return p, t


def sun_altaz(lat: float, lon: float, elev_m: float, times) -> tuple[np.ndarray, np.ndarray]:
    """Apparent (refracted) sun elevation and azimuth (deg, az clockwise from north) at ``times``."""
    u, AltAz, EarthLocation, get_sun, _ = _astropy()
    p, t = std_atmosphere(elev_m)
    loc = EarthLocation(lat=lat * u.deg, lon=lon * u.deg, height=float(elev_m or 0.0) * u.m)
    frame = AltAz(obstime=times, location=loc, pressure=p * u.hPa, temperature=t * u.deg_C,
                  relative_humidity=0.5, obswl=0.55 * u.um)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        aa = get_sun(times).transform_to(frame)
    return np.asarray(aa.alt.deg), np.asarray(aa.az.deg)


@lru_cache(maxsize=4)
def _coarse_sun(start: str, days: int) -> dict[str, np.ndarray]:
    """Site-independent sun ephemeris on the coarse grid: offsets (min), RA/Dec (deg), GAST (deg, unwrapped)."""
    u, _, _, get_sun, Time = _astropy()
    off = np.arange(0, days * 1440 + COARSE_MIN, COARSE_MIN, dtype=float)
    t = Time(start, scale="utc") + off / 1440.0 * u.day
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        s = get_sun(t)
        gast = t.sidereal_time("apparent", "greenwich").deg
    return {"off": off, "ra": np.unwrap(np.radians(s.ra.deg)), "dec": np.radians(s.dec.deg),
            "gast": np.unwrap(np.radians(gast))}


def approx_el(lat: float, lon: float, elev_m: float, off_min: np.ndarray, start: str = START_UTC,
              days: int = SEARCH_DAYS) -> np.ndarray:
    """Fast approximate apparent elevation (deg): interpolated ephemeris + Bennett refraction scaled by P/T.
    Used only to decide where to run the exact astropy computation (accuracy ~0.1 deg)."""
    c = _coarse_sun(start, days)
    ra = np.interp(off_min, c["off"], c["ra"])
    dec = np.interp(off_min, c["off"], c["dec"])
    gast = np.interp(off_min, c["off"], c["gast"])
    ha = gast + math.radians(lon) - ra
    phi = math.radians(lat)
    h = np.degrees(np.arcsin(np.clip(math.sin(phi) * np.sin(dec) + math.cos(phi) * np.cos(dec) * np.cos(ha), -1, 1)))
    p, t = std_atmosphere(elev_m)
    hh = np.maximum(h, -1.0)
    r_arcmin = 1.0 / np.tan(np.radians(hh + 7.31 / (hh + 4.4))) * (p / 1010.0) * (283.0 / (273.0 + t))
    return h + np.where(h > -1.0, r_arcmin / 60.0, 0.0)


def az_diff(a: np.ndarray | float, b: float) -> np.ndarray:
    return np.abs((np.asarray(a) - b + 180.0) % 360.0 - 180.0)


def local_solar_hours(times, lon: float) -> np.ndarray:
    """Local apparent solar time (hours) = 12 h + hour angle of the Sun."""
    u, _, _, get_sun, _ = _astropy()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        last = times.sidereal_time("apparent", longitude=lon * u.deg).hour
        ra = get_sun(times).ra.hour
    return (last - ra + 12.0) % 24.0


def _part_of_day(h0: float, h1: float) -> str:
    mid = (h0 + ((h1 - h0) % 24.0) / 2.0) % 24.0
    if 10.0 <= mid <= 14.0:
        return "around solar noon"
    if mid >= 22.0 or mid <= 2.0:
        return "around solar midnight"
    return "morning" if mid < 12.0 else "evening"


def _hhmm(h: float) -> str:
    m = int(round(h * 60)) % 1440
    return f"{m // 60:02d}:{m % 60:02d}"


@dataclass
class _Run:
    i0: int
    i1: int


def find_windows(lat: float, lon: float, elev_m: float, target_el: float, target_az: float | None = None,
                 start: str = START_UTC, days: int = SEARCH_DAYS, el_tol: float = EL_TOL_DEG,
                 az_tol: float = AZ_TOL_DEG) -> list[dict]:
    """All windows in [start, start + days) with |apparent el - target| <= el_tol (and az within az_tol)."""
    u, _, _, _, Time = _astropy()
    c = _coarse_sun(start, days)
    d = approx_el(lat, lon, elev_m, c["off"], start, days) - target_el
    near = (np.abs(d[:-1]) < 1.5) | (np.abs(d[1:]) < 1.5) | (np.sign(d[:-1]) != np.sign(d[1:]))
    idx = np.nonzero(near)[0]
    if idx.size == 0:
        return []
    steps = COARSE_MIN // FINE_MIN
    offs = np.unique((idx[:, None] * steps + np.arange(steps + 1)[None, :]).ravel())  # in FINE_MIN units
    offs = offs[offs < days * 1440 // FINE_MIN]
    ea = approx_el(lat, lon, elev_m, offs * float(FINE_MIN), start, days)
    keep = np.abs(ea - target_el) <= el_tol + 0.5
    keep = keep | np.roll(keep, 1) | np.roll(keep, -1)          # neighbours, for band-edge interpolation
    offs = offs[keep]
    if offs.size == 0:
        return []
    tf = Time(start, scale="utc") + offs * FINE_MIN / 1440.0 * u.day
    el, az = sun_altaz(lat, lon, elev_m, tf)
    ok_el = np.abs(el - target_el) <= el_tol
    ok = ok_el & (az_diff(az, target_az) <= az_tol if target_az is not None else True)
    runs: list[_Run] = []
    i = 0
    n = len(offs)
    while i < n:
        if not ok[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and ok[j + 1] and offs[j + 1] == offs[j] + 1:
            j += 1
        runs.append(_Run(i, j))
        i = j + 1
    out = []
    t0 = Time(start, scale="utc")
    for r in runs:
        s_off, e_off = float(offs[r.i0]), float(offs[r.i1])
        # interpolate the band edge on each side when the neighbour is the adjacent sample and failed on el
        k = r.i0 - 1
        if k >= 0 and offs[k] == offs[r.i0] - 1 and not ok_el[k]:
            edge = target_el + el_tol if el[k] > target_el + el_tol else target_el - el_tol
            s_off -= 1.0 - (edge - el[k]) / (el[r.i0] - el[k]) if el[r.i0] != el[k] else 0.0
        k = r.i1 + 1
        if k < n and offs[k] == offs[r.i1] + 1 and not ok_el[k]:
            edge = target_el + el_tol if el[k] > target_el + el_tol else target_el - el_tol
            e_off += (edge - el[r.i1]) / (el[k] - el[r.i1]) if el[k] != el[r.i1] else 0.0
        mid = (r.i0 + r.i1) // 2
        out.append({"s_off": s_off, "e_off": e_off, "mid_off": float(offs[mid]), "sun_el": float(el[mid]),
                    "sun_az": float(az[mid]), "el_min": float(el[r.i0:r.i1 + 1].min())})
    for w in out:
        w["start"] = t0 + w["s_off"] * FINE_MIN / 1440.0 * u.day
        w["end"] = t0 + w["e_off"] * FINE_MIN / 1440.0 * u.day
        w["duration_min"] = (w["e_off"] - w["s_off"]) * FINE_MIN
    return out


def pick_spread(wins: list[dict], n: int = MAX_WINDOWS, days: int = SEARCH_DAYS) -> list[dict]:
    """Up to ``n`` windows spread across the year: one per equal time bin (longest, preferring >= 1 deg sun)."""
    if not wins:
        return []
    total = days * 1440 / FINE_MIN
    bins: dict[int, list[dict]] = {}
    for w in wins:
        bins.setdefault(min(int(w["mid_off"] / total * n), n - 1), []).append(w)
    chosen = [max(ws, key=lambda w: (w["el_min"] >= REFRACTION_SENSITIVE_DEG, w["duration_min"], -w["mid_off"]))
              for _, ws in sorted(bins.items())]
    return sorted(chosen, key=lambda w: w["mid_off"])


def format_windows(chosen: list[dict], lon: float) -> list[dict]:
    if not chosen:
        return []
    _, _, _, _, Time = _astropy()
    ts = Time([w["start"] for w in chosen] + [w["end"] for w in chosen])
    lst = local_solar_hours(ts, lon)
    k = len(chosen)
    out = []
    for i, w in enumerate(chosen):
        sens = w["el_min"] < REFRACTION_SENSITIVE_DEG
        out.append({
            "start_utc": w["start"].utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "end_utc": w["end"].utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "sun_el": round(w["sun_el"], 2), "sun_az": round(w["sun_az"], 1), "el_kind": EL_KIND,
            "local_solar_time": f"{_hhmm(lst[i])}–{_hhmm(lst[k + i])} local solar time",
            "part_of_day": _part_of_day(lst[i], lst[k + i]),
            "duration_min": round(float(w["duration_min"]), 1),
            "refraction_sensitive": bool(sens),
            "flags": ["refraction-sensitive"] if sens else [],
        })
    return out


# ------------------------------------------------------------------ targets
def shadow_target_el(sun: dict | None) -> float:
    """The region's lowest typical sun (sun-range minimum), clamped to [1, 5] deg."""
    lo, hi = SHADOW_EL_CLAMP
    v = float((sun or {}).get("el_min", 2.0))
    return round(min(max(v, lo), hi), 2)


def target_el_for(hazard: str, sun: dict | None) -> float:
    return shadow_target_el(sun) if hazard == "shadow" else TARGET_EL[hazard]


def shadow_target_az(moon: dict, feat: dict | None, site: dict, target_el: float) -> tuple[float | None, str]:
    """Earth sun azimuth that reproduces the Moon's worst-shadow direction RELATIVE to the dominant slope
    direction (aspect). None + reason when the shadow pattern is not direction-dependent or a tile has
    no dominant slope direction."""
    prof = moon.get("az_shadow") or {}
    if not prof:
        return None, "Moon shadow-vs-azimuth profile unavailable; azimuth unconstrained"
    key = min(prof, key=lambda k: abs(float(k) - target_el))
    f = np.asarray(prof[key], float)
    direc = float((f.max() - f.min()) / max(f.mean(), 1e-6))
    if direc < MIN_DIRECTIONALITY:
        return None, (f"on the Moon the shadow share at {key}° sun barely changes with sun direction "
                      f"(spread {100 * direc:.0f}% of mean); azimuth unconstrained")
    sm = moon.get("shape_scalars") or {}
    se = ((feat or {}).get("shape30") or {}).get("scalars") or {}
    rm, re_ = sm.get("shape_aspect_R"), se.get("shape_aspect_R")
    if rm is None or re_ is None or rm < MIN_ASPECT_R or re_ < MIN_ASPECT_R:
        return None, ("shadow pattern depends on sun direction, but "
                      f"{'the Moon tile' if (rm or 0) < MIN_ASPECT_R else 'the Earth tile'} has no dominant slope "
                      "direction to align with; azimuth unconstrained")
    az_worst_m = float(np.argmax(f)) * 360.0 / f.size          # grid az of the worst shadow on the Moon
    delta = az_worst_m - float(sm["shape_aspect_mean_dir_deg"])
    conv = float(site.get("tile", {}).get("true_north_grid_az_deg") or 0.0)
    az_true = (float(se["shape_aspect_mean_dir_deg"]) + delta - conv) % 360.0
    return round(az_true, 1), (f"sun from {az_true:.0f}° (true) puts the sun in the same place relative to the main "
                               f"slope direction as the Moon's worst-shadow sun ({delta % 360:.0f}° from the downslope "
                               "direction)")


def windows_for_match(lat: float, lon: float, elev_m: float, target_el: float,
                      target_az: float | None) -> tuple[list[dict], str]:
    """(formatted windows, note). Falls back to no azimuth constraint if the azimuth is never reached."""
    notes = []
    wins: list[dict] = []
    if target_az is not None:
        wins = find_windows(lat, lon, elev_m, target_el, target_az)
        if not wins:
            notes.append(f"the sun never reaches {target_el:g}° at azimuth {target_az:.0f}°±{AZ_TOL_DEG:g}° here "
                         "within the year; azimuth constraint dropped")
    if not wins:
        wins = find_windows(lat, lon, elev_m, target_el, None)
    if not wins:
        notes.append(f"the sun never sits at {target_el:g}° here in the next 12 months")
    return format_windows(pick_spread(wins), lon), "; ".join(notes)
