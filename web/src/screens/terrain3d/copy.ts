// Plain-language text for the 3D comparison screen, always computed from the loaded data.
import { HAZARDS, distanceFit, metricInfo } from '../../content';
import type { HazardId, LightRow, Match, RehearsalWindow } from '../../types/contract';

/** Tab names and danger phrases; the mission label always comes from HAZARDS[].mission. */
export const HAZARD_TAB: Record<HazardId, { name: string; mission: string; danger: string }> = {
  shadow: { name: 'Shadow', mission: HAZARDS.shadow.mission, danger: 'shadow danger' },
  rim: { name: 'Rim jump', mission: HAZARDS.rim.mission, danger: 'rim-drop danger' },
  texture: { name: 'Texture', mission: HAZARDS.texture.mission, danger: 'camera-texture danger' },
};

/** The metric that best states each danger in one number. */
export const HEADLINE_METRIC: Record<HazardId, string> = {
  shadow: 'shadow_frac_el3',
  rim: 'jump1km_p95_m',
  texture: 'empty_cell_frac_el3',
};

const LIGHT_ORDER: Record<string, number> = { green: 0, amber: 1, red: 2 };

export function lightLabel(l: LightRow): string {
  if ('label' in l && typeof l.label === 'string' && l.label) return l.label;
  return metricInfo(l.metric).label;
}

export function lightUsedToRank(l: LightRow): boolean {
  return !('in_distance' in l) || l.in_distance !== false;
}

function gapInIqr(l: LightRow): number {
  return 'gap_in_iqr' in l && typeof l.gap_in_iqr === 'number' ? l.gap_in_iqr : Number.POSITIVE_INFINITY;
}

export function pct0(v: number): string {
  return Number.isFinite(v) ? `${Math.round(v * 100)}%` : '–';
}

/** Value formatting tuned for reading, not for precision. */
export function fmtValue(metric: string, v: number): string {
  if (!Number.isFinite(v)) return '–';
  if (metric.startsWith('shadow_frac') || metric === 'empty_cell_frac_el3') return pct0(v);
  if (metric === 'frac_track_over_500m') return `${(v * 100).toFixed(v < 0.01 ? 2 : 1)}%`;
  if (metric.startsWith('jump')) return `${Math.round(v)} m`;
  if (metric.startsWith('slope')) return `${v.toFixed(0)}°`;
  if (metric === 'fast_per_km2_el3') return `${v.toFixed(1)} /km²`;
  return metricInfo(metric).fmt(v);
}

/** The light that carries the verdict: the headline metric, unless another ranked metric fits clearly better. */
export function verdictLight(match: Match): LightRow | null {
  const ranked = match.lights.filter(lightUsedToRank);
  const pool = ranked.length ? ranked : match.lights;
  if (!pool.length) return null;
  const head = pool.find((l: LightRow): boolean => l.metric === HEADLINE_METRIC[match.hazard]);
  const bestOther = [...pool].sort(
    (a: LightRow, b: LightRow): number => (LIGHT_ORDER[a.light] ?? 3) - (LIGHT_ORDER[b.light] ?? 3) || gapInIqr(a) - gapInIqr(b),
  )[0];
  if (head && (LIGHT_ORDER[head.light] ?? 3) <= (LIGHT_ORDER[bestOther.light] ?? 3)) return head;
  return bestOther ?? head ?? null;
}

/** Short headline stat, Earth first: "57% vs 55% in shadow over a low-sun day". */
export function statClause(l: LightRow): string {
  const e = fmtValue(l.metric, l.earth);
  const m = fmtValue(l.metric, l.moon);
  const el = /^shadow_frac_el(\d+)$/.exec(l.metric);
  if (el) return `${e} vs ${m} in shadow at a ${el[1]}° sun (all directions averaged)`;
  switch (l.metric) {
    case 'shadow_frac_timeweighted':
      return `${e} vs ${m} in shadow over a low-sun day`;
    case 'jump1km_p95_m':
      return `worst 1 km drops ${e} vs ${m}`;
    case 'jump1km_p99_m':
      return `very worst 1 km drops ${e} vs ${m}`;
    case 'frac_track_over_500m':
      return `${e} vs ${m} of tracks cross a 500 m drop`;
    case 'empty_cell_frac_el3':
      return `${e} vs ${m} of 1 km squares featureless`;
    case 'fast_per_km2_el3':
      return `${e} vs ${m} camera landmarks`;
    case 'slope_p50_deg':
      return `typical slope ${e} vs ${m}`;
    default:
      return `${lightLabel(l).toLowerCase()}: ${e} vs ${m}`;
  }
}

export interface Verdict {
  lead: string;
  stat: string;
  rank: string | null;
  close: boolean;
}

export function buildVerdict(match: Match, placeLabel: string, regionName: string, nScreened: number | null): Verdict | null {
  const l = verdictLight(match);
  if (!l) return null;
  // Only an overall Close fit (same bands as the Summary grid) "matches"; Partial and Far are stand-ins.
  const close = distanceFit(match.distance) === 'green';
  const danger = HAZARD_TAB[match.hazard].danger;
  const lead = close ? `${placeLabel} matches ${regionName}’s ${danger}` : `${placeLabel}: closest stand-in for ${regionName}’s ${danger}`;
  const rank =
    nScreened && nScreened > 0 ? `#${match.rank} pick from ${nScreened.toLocaleString('en-US')} Earth squares screened` : `#${match.rank} pick`;
  return { lead, stat: statClause(l), rank, close };
}

// ------------------------------------------------------------------------------------------------
// Rehearsal windows
// ------------------------------------------------------------------------------------------------

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export function compass(az: number): string {
  return COMPASS[Math.round((((az % 360) + 360) % 360) / 45) % 8];
}

export function windowDate(w: RehearsalWindow): string {
  const d = new Date(w.start_utc);
  if (Number.isNaN(d.getTime())) return w.start_utc;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function windowTime(w: RehearsalWindow): string {
  if ('local_solar_time' in w && typeof w.local_solar_time === 'string' && w.local_solar_time) return w.local_solar_time;
  const a = new Date(w.start_utc);
  const b = new Date(w.end_utc);
  const f = (d: Date): string => d.toISOString().slice(11, 16);
  return Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) ? '' : `${f(a)}–${f(b)} UTC`;
}

export function windowMinutes(w: RehearsalWindow): number | null {
  if ('duration_min' in w && typeof w.duration_min === 'number') return w.duration_min;
  const ms = new Date(w.end_utc).getTime() - new Date(w.start_utc).getTime();
  return Number.isFinite(ms) ? ms / 60000 : null;
}

export function windowPartOfDay(w: RehearsalWindow): string | null {
  return 'part_of_day' in w && typeof w.part_of_day === 'string' && w.part_of_day ? w.part_of_day : null;
}

export function fmtMinutes(m: number): string {
  if (m < 1) return 'under a minute';
  if (m < 90) return `${Math.round(m)} min`;
  return `${(m / 60).toFixed(1)} h`;
}

/** Earth windows this low are refraction-sensitive (air bends low sunlight by ~0.3–0.6°). */
export function lowSunWindow(w: RehearsalWindow): boolean {
  const flagged = 'refraction_sensitive' in w && w.refraction_sensitive === true;
  return flagged || w.sun_el < 1;
}

/** "06:35 local solar time" (the window's start), else the full window time. */
export function windowStart(w: RehearsalWindow): string {
  const t = windowTime(w);
  const m = /^(\d{1,2}:\d{2})\s*[–-]\s*\d{1,2}:\d{2}\s*(.*)$/.exec(t);
  return m ? `${m[1]}${m[2] ? ` ${m[2]}` : ''}` : t;
}

// ------------------------------------------------------------------------------------------------
// Date fit: one rehearsal date's sun on both tiles
// ------------------------------------------------------------------------------------------------

/** Moon and Earth dark shares under one date's sun; `gap` is in whole points, from the figures as shown. */
export interface DateFit {
  moon: number;
  earth: number;
  gap: number;
}

/** A date reproduces the Moon's shadow closely when the shown figures are at most this many points apart. */
export const CLOSE_GAP_PTS = 10;

export function dateFit(moon: number | null, earth: number | null): DateFit | null {
  if (moon === null || earth === null || !Number.isFinite(moon) || !Number.isFinite(earth)) return null;
  return { moon, earth, gap: Math.abs(Math.round(earth * 100) - Math.round(moon * 100)) };
}

/** Index of the date whose sun gives the closest Moon and Earth figures (earliest on a tie); -1 until all are known. */
export function bestDateIndex(fits: (DateFit | null)[]): number {
  if (!fits.length || fits.some((f: DateFit | null): boolean => f === null)) return -1;
  let best = -1;
  let bd = Infinity;
  fits.forEach((f: DateFit | null, i: number): void => {
    if (!f) return;
    const d = Math.abs(f.earth - f.moon);
    if (d < bd - 1e-9) {
      bd = d;
      best = i;
    }
  });
  return best;
}

/** "Moon 48% · Earth 50%" */
export function fitText(f: DateFit): string {
  return `Moon ${pct0(f.moon)} · Earth ${pct0(f.earth)}`;
}
