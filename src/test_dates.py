"""Best 2027 dates and local time windows to test low-sun landing at an Earth site.

Pre-registered rule: for 2027, the date with the most minutes of sun elevation
between 1.5 deg and the matched Moon region's maximum sun elevation, with the
local time windows (astropy).

Simplifications:
- No atmospheric refraction (AltAz pressure=0): geometric sun centre elevation.
- No terrain horizon: a flat, open horizon is assumed.
- Moon region maximum sun elevation = (90 - |lat|) + 1.54 deg (lunar axial tilt
  to the ecliptic); regions span a latitude range, so REGION_LAT is the mid value.
"""
import time
from datetime import date, datetime, timedelta, timezone

import numpy as np
import astropy.units as u
from astropy.coordinates import ITRS, AltAz, EarthLocation, get_sun
from astropy.time import Time

MIN_ELEV = 1.5      # deg, lower edge of the low-sun band
STEP_MIN = 2        # minutes between samples
LUNAR_TILT = 1.54   # deg, Moon's axial tilt to the ecliptic

REGION_BOUNDS = {
    "Nobile Rim 2": (-84.40, -83.50),
    "Mons Mouton": (-85.79, -85.06),
    "Malapert Massif": (-86.33, -85.63),
    "de Gerlache Rim 2": (-88.66, -87.79),
    "Mons Mouton Plateau": (-85.76, -82.85),
    "Slater Plain": (-87.62, -86.70),
    "Peak Near Cabeus B": (-84.06, -83.21),
    "Nobile Rim 1": (-85.90, -84.97),
    "Haworth": (-87.39, -86.11),
}
REGION_LAT = {k: round((a + b) / 2, 3) for k, (a, b) in REGION_BOUNDS.items()}


def region_max_sun_elev(lat_deg):
    """Maximum sun elevation (deg) at a lunar latitude."""
    return (90 - abs(lat_deg)) + LUNAR_TILT


_SUN_CACHE = {}


def _sun_track(year):
    """UTC sample times and geocentric ITRS sun positions, computed once per year."""
    if year not in _SUN_CACHE:
        # one day of margin each side so every local date of the year is covered
        start = Time(f"{year - 1}-12-31T00:00:00", scale="utc")
        n = int((366 + 2) * 24 * 60 / STEP_MIN)
        t = start + np.arange(n) * STEP_MIN * u.min
        _SUN_CACHE[year] = (t, get_sun(t).transform_to(ITRS(obstime=t)))
    return _SUN_CACHE[year]


def _local_offsets(lat, lon, utc):
    """Per-sample UTC offset (hours) and a label for the local time used."""
    try:
        from timezonefinder import TimezoneFinder
        from zoneinfo import ZoneInfo
        name = TimezoneFinder().timezone_at(lng=lon, lat=lat)
        if name is None:
            raise LookupError
        tz = ZoneInfo(name)
        # offset per UTC hour (DST changes on the hour), mapped to each sample
        hours = utc.astype("datetime64[h]")
        uniq, inv = np.unique(hours, return_inverse=True)
        off = np.array([tz.utcoffset(h.item()).total_seconds() / 3600 for h in uniq])
        return off[inv], name
    except (ImportError, LookupError):
        return np.full(len(utc), lon / 15.0), "local solar time"


def best_test_date(lat, lon, max_elev, year=2027):
    """Best local date in `year` for low-sun tests at (lat, lon).

    Returns a dict, or None if the sun never enters [MIN_ELEV, max_elev]:
      date, minutes, tz, max_elev, monthly_best, windows: list of
      {part, utc (start, end), local (start, end), az (start, end) in deg}. 'part' is morning/evening relative to the day's highest sun.
    Refraction and terrain horizon are ignored.
    """
    t, sun = _sun_track(year)
    loc = EarthLocation(lat=lat * u.deg, lon=lon * u.deg, height=0 * u.m)
    # topocentric ITRS -> AltAz is a pure rotation in astropy, so this is fast per site
    topo = ITRS(sun.cartesian - loc.get_itrs(t).cartesian, obstime=t, location=loc)
    aa =topo.transform_to(AltAz(obstime=t, location=loc, pressure=0 * u.hPa))
    alt, az = aa.alt.deg, aa.az.deg

    utc = t.datetime64.astype("datetime64[s]")
    off, tzname = _local_offsets(lat, lon, utc)
    local = utc + (off * 3600).astype("timedelta64[s]")
    ldate = local.astype("datetime64[D]")

    keep = (ldate >= np.datetime64(f"{year}-01-01")) & (ldate <= np.datetime64(f"{year}-12-31"))
    inband = keep & (alt >= MIN_ELEV) & (alt <= max_elev)
    if not inband.any():
        return None

    days, counts = np.unique(ldate[inband], return_counts=True)
    best = days[np.argmax(counts)]
    day = ldate == best
    idx = np.flatnonzero(day)
    noon = idx[np.argmax(alt[idx])]

    # contiguous runs of in-band samples on the best day
    sel = np.flatnonzero(day & inband)
    runs = np.split(sel, np.flatnonzero(np.diff(sel) > 1) + 1)
    fmt = lambda x: str(x.astype("datetime64[m]")).replace("T", " ")
    windows = []
    for r in runs:
        step = np.timedelta64(STEP_MIN, "m")
        windows.append({
            "part": "morning" if r.mean() < noon else "evening",
            "utc": (fmt(utc[r[0]]), fmt(utc[r[-1]] + step)),
            "local": (fmt(local[r[0]]), fmt(local[r[-1]] + step)),
            # sun moves steadily in azimuth, so start->end is wrap-safe (e.g. 340 -> 15)
            "az": (round(float(az[r[0]]), 1), round(float(az[r[-1]]), 1)),
        })
    return {"date": str(best), "minutes": int(counts.max()) * STEP_MIN,
            "tz": tzname, "max_elev": round(max_elev, 2), "windows": windows,
            "monthly_best": _monthly(days, counts)}


def _monthly(days, counts):
    """Best minutes in each month (sanity check on the seasonal pattern)."""
    months = days.astype("datetime64[M]")
    return {str(m)[5:]: int(counts[months == m].max()) * STEP_MIN for m in np.unique(months)}


def _show(name, lat, lon, region):
    m = region_max_sun_elev(REGION_LAT[region])
    t0 = time.perf_counter()
    r = best_test_date(lat, lon, m)
    dt = time.perf_counter() - t0
    print(f"\n{name} ({lat}, {lon}) vs {region} (lat {REGION_LAT[region]}, "
          f"band {MIN_ELEV}-{m:.2f} deg)  [{dt:.1f} s]")
    if r is None:
        print("  sun never in band in 2027")
        return
    print(f"  best date {r['date']}: {r['minutes']} min  (local = {r['tz']})")
    for w in r["windows"]:
        print(f"  {w['part']:8s} UTC {w['utc'][0][11:]}-{w['utc'][1][11:]}  "
              f"local {w['local'][0][11:]}-{w['local'][1][11:]}  az {w['az'][0]} -> {w['az'][1]}")
    print("  best minutes by month:", r["monthly_best"])


if __name__ == "__main__":
    t0 = time.perf_counter()
    _sun_track(2027)
    print(f"sun positions for 2027 at {STEP_MIN}-min steps: {time.perf_counter() - t0:.1f} s")
    _show("Meteor Crater", 35.027, -111.022, "Haworth")
    _show("Meteor Crater", 35.027, -111.022, "Nobile Rim 2")
    _show("High-latitude test", 69.0, 27.0, "Haworth")
    _show("High-latitude test", 69.0, 27.0, "Nobile Rim 2")
