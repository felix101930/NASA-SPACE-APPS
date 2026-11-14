// One place for number formatting with units. Every number on screen carries a unit; thousands separators
// are always on; decimals are chosen per unit. Missing or non-finite values render as an em dash.

const DASH = '—';

function ok(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Plain number with thousands separators, e.g. 12013 -> "12,013". */
export function fmtNum(v: number | null | undefined, digits: number = 0): string {
  return ok(v) ? v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : DASH;
}

/** Metres: whole metres from 10 m up, one decimal below. */
export function fmtM(v: number | null | undefined, digits?: number): string {
  if (!ok(v)) return DASH;
  return `${fmtNum(v, digits ?? (Math.abs(v) >= 10 ? 0 : 1))} m`;
}

export function fmtKm(v: number | null | undefined, digits?: number): string {
  if (!ok(v)) return DASH;
  return `${fmtNum(v, digits ?? (Math.abs(v) >= 10 ? 0 : 1))} km`;
}

export function fmtKm2(v: number | null | undefined, digits: number = 0): string {
  return ok(v) ? `${fmtNum(v, digits)} km²` : DASH;
}

/** Degrees, one decimal by default. */
export function fmtDeg(v: number | null | undefined, digits: number = 1): string {
  return ok(v) ? `${fmtNum(v, digits)}°` : DASH;
}

/** A 0–1 fraction as a percentage, e.g. 0.532 -> "53%". */
export function fmtPct(frac: number | null | undefined, digits: number = 0): string {
  return ok(frac) ? `${fmtNum(frac * 100, digits)}%` : DASH;
}

/** A 0–1 difference as percentage points, e.g. -0.025 -> "−2.5 points". */
export function fmtPts(frac: number | null | undefined, digits: number = 1, signed: boolean = false): string {
  if (!ok(frac)) return DASH;
  const n = frac * 100;
  const sign = signed && n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}${fmtNum(Math.abs(n), digits)} points`;
}

export function fmtPerKm2(v: number | null | undefined, digits: number = 0): string {
  return ok(v) ? `${fmtNum(v, digits)} /km²` : DASH;
}

export function fmtMin(v: number | null | undefined): string {
  return ok(v) ? `${fmtNum(v, 0)} min` : DASH;
}

/** Distance in multiples of the Moon region's typical spread, e.g. 0.43 -> "0.43×". */
export function fmtSpread(v: number | null | undefined, digits: number = 2): string {
  return ok(v) ? `${fmtNum(v, digits)}×` : DASH;
}

/** A unitless statistic (r, AUC, Jaccard), two decimals. */
export function fmtStat(v: number | null | undefined, digits: number = 2): string {
  return ok(v) ? fmtNum(v, digits) : DASH;
}

/** "± 0.4 m" style uncertainty suffix. */
export function fmtPm(v: number | null | undefined, unit: string, digits: number = 1): string {
  return ok(v) ? `±${fmtNum(v, digits)}${unit === '°' ? '°' : ` ${unit}`}` : '';
}
