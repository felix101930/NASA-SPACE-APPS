// NOAA solar position (simplified, ~0.01 deg accuracy for our purposes) and local solar time.

export interface SunPos {
  /** Geometric elevation, degrees. */
  el: number;
  /** Azimuth clockwise from north, degrees. */
  az: number;
  /** Equation of time, minutes. */
  eqTimeMin: number;
}

const rad = Math.PI / 180;

export function sunPosition(date: Date, latDeg: number, lonDeg: number): SunPos {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const jc = (jd - 2451545) / 36525;
  const l0 = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360;
  const m = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
  const c =
    Math.sin(m * rad) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) +
    Math.sin(2 * m * rad) * (0.019993 - 0.000101 * jc) +
    Math.sin(3 * m * rad) * 0.000289;
  const trueLong = l0 + c;
  const omega = 125.04 - 1934.136 * jc;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * rad);
  const meanObl = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const obl = meanObl + 0.00256 * Math.cos(omega * rad);
  const decl = Math.asin(Math.sin(obl * rad) * Math.sin(appLong * rad)) / rad;
  const y = Math.tan((obl / 2) * rad) ** 2;
  const eqTime =
    (4 / rad) *
    (y * Math.sin(2 * l0 * rad) -
      2 * e * Math.sin(m * rad) +
      4 * e * y * Math.sin(m * rad) * Math.cos(2 * l0 * rad) -
      0.5 * y * y * Math.sin(4 * l0 * rad) -
      1.25 * e * e * Math.sin(2 * m * rad));
  const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  let tst = (utcMin + eqTime + 4 * lonDeg) % 1440;
  if (tst < 0) tst += 1440;
  let ha = tst / 4 - 180;
  if (ha < -180) ha += 360;
  const cosZen =
    Math.sin(latDeg * rad) * Math.sin(decl * rad) + Math.cos(latDeg * rad) * Math.cos(decl * rad) * Math.cos(ha * rad);
  const zen = Math.acos(Math.min(1, Math.max(-1, cosZen))) / rad;
  const el = 90 - zen;
  const azDen = Math.cos(latDeg * rad) * Math.sin(zen * rad);
  let az: number;
  if (Math.abs(azDen) > 1e-6) {
    const azRad = (Math.sin(latDeg * rad) * Math.cos(zen * rad) - Math.sin(decl * rad)) / azDen;
    const a = Math.acos(Math.min(1, Math.max(-1, azRad))) / rad;
    az = ha > 0 ? (a + 180) % 360 : (540 - a) % 360;
  } else {
    az = latDeg > 0 ? 180 : 0;
  }
  return { el, az, eqTimeMin: eqTime };
}

/** Atmospheric refraction (Saemundsson-style, degrees) to add to geometric elevation near the horizon. */
export function refractionDeg(elDeg: number): number {
  if (elDeg < -1) return 0;
  return 1.02 / Math.tan((elDeg + 10.3 / (elDeg + 5.11)) * rad) / 60;
}

/** Apparent local solar time at a longitude, formatted HH:MM. */
export function localSolarTime(date: Date, lonDeg: number): string {
  const { eqTimeMin } = sunPosition(date, 0, lonDeg);
  const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  let t = (utcMin + 4 * lonDeg + eqTimeMin) % 1440;
  if (t < 0) t += 1440;
  const h = Math.floor(t / 60);
  const mm = Math.floor(t % 60);
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
