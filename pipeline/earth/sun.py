"""Vectorised solar position (NOAA / Meeus low-precision, ~0.01 deg) and refraction.

Earth sun elevations used for rehearsal windows are APPARENT (refraction applied). Refraction is
~0.57 deg at the horizon and weather dependent, so anything below 1 deg is flagged uncertain.
"""
from __future__ import annotations

import numpy as np

UNCERTAIN_BELOW_DEG = 1.0


def solar_position(t_unix: np.ndarray, lat: float, lon: float) -> tuple[np.ndarray, np.ndarray]:
    """Geometric sun elevation and azimuth (deg, azimuth clockwise from true north)."""
    jd = np.asarray(t_unix, float) / 86400.0 + 2440587.5
    T = (jd - 2451545.0) / 36525.0
    L0 = np.mod(280.46646 + T * (36000.76983 + 0.0003032 * T), 360.0)
    M = 357.52911 + T * (35999.05029 - 0.0001537 * T)
    e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T)
    Mr = np.radians(M)
    C = (np.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) + np.sin(2 * Mr) * (0.019993 - 0.000101 * T)
         + np.sin(3 * Mr) * 0.000289)
    true_long = L0 + C
    omega = 125.04 - 1934.136 * T
    lam = true_long - 0.00569 - 0.00478 * np.sin(np.radians(omega))
    eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60
    eps = eps0 + 0.00256 * np.cos(np.radians(omega))
    decl = np.degrees(np.arcsin(np.sin(np.radians(eps)) * np.sin(np.radians(lam))))
    y = np.tan(np.radians(eps / 2)) ** 2
    L0r = np.radians(L0)
    eqt = 4 * np.degrees(y * np.sin(2 * L0r) - 2 * e * np.sin(Mr) + 4 * e * y * np.sin(Mr) * np.cos(2 * L0r)
                         - 0.5 * y * y * np.sin(4 * L0r) - 1.25 * e * e * np.sin(2 * Mr))  # minutes
    minutes_utc = np.mod(np.asarray(t_unix, float), 86400.0) / 60.0
    tst = np.mod(minutes_utc + eqt + 4 * lon, 1440.0)
    ha = tst / 4.0 - 180.0
    latr, decr, har = np.radians(lat), np.radians(decl), np.radians(ha)
    cosz = np.sin(latr) * np.sin(decr) + np.cos(latr) * np.cos(decr) * np.cos(har)
    zen = np.arccos(np.clip(cosz, -1, 1))
    el = 90.0 - np.degrees(zen)
    az = np.degrees(np.arctan2(np.sin(har), np.cos(har) * np.sin(latr) - np.tan(decr) * np.cos(latr))) + 180.0
    return el, np.mod(az, 360.0)


def refraction_deg(el_geom: np.ndarray) -> np.ndarray:
    """Bennett (1982) / Saemundsson refraction for standard atmosphere (deg), for el > -1 deg."""
    h = np.maximum(np.asarray(el_geom, float), -0.9)
    return 1.02 / np.tan(np.radians(h + 10.3 / (h + 5.11))) / 60.0


def low_sun_series(lat: float, lon: float, el_max: float = 7.0, el_min: float = 0.0, year: int = 2026,
                   step_min: int = 10) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Apparent sun (el, true az) samples over a year with el_min < el_app <= el_max; also unix times."""
    t0 = np.datetime64(f"{year}-01-01T00:00").astype("datetime64[s]").astype(np.int64)
    t1 = np.datetime64(f"{year + 1}-01-01T00:00").astype("datetime64[s]").astype(np.int64)
    t = np.arange(t0, t1, step_min * 60, dtype=np.int64)
    el, az = solar_position(t, lat, lon)
    el_app = el + refraction_deg(el)
    m = (el_app > el_min) & (el_app <= el_max)
    return el_app[m], az[m], t[m]
