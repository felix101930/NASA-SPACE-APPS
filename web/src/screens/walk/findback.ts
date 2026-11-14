// Reading walk/findback.json (the hidden-copy test of the walk matchers) for the plain-language copy.
import { isObj } from '../../types/contract';
import type { Light } from '../../types/contract';

export interface Spread {
  median: number;
  p10: number;
  p90: number;
}

export interface Findback {
  /** Top-1 / top-5 find-back rate of the default height + slope matcher. */
  top1: number | null;
  top5: number | null;
  /** Top-1 rate of slope-only DTW (the "stretched routes" option). */
  dtwTop1: number | null;
  nRoutes: number | null;
  noiseM: number | null;
  stretch: number | null;
  /** Best-match distances found for the clean test routes: height + slope matcher and the DTW pipeline. */
  euclidSpread: Spread | null;
  dtwSpread: Spread | null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function spread(v: unknown): Spread | null {
  if (!isObj(v)) return null;
  const median = num(v.median);
  const p10 = num(v.p10);
  const p90 = num(v.p90);
  return median !== null && p10 !== null && p90 !== null ? { median, p10, p90 } : null;
}

function matcher(list: unknown, name: string): Record<string, unknown> | null {
  if (!Array.isArray(list)) return null;
  for (const m of list) if (isObj(m) && m.name === name) return m;
  return null;
}

export function isFindbackRaw(v: unknown): v is Record<string, unknown> {
  return isObj(v) && Array.isArray(v.matchers);
}

export function parseFindback(v: Record<string, unknown>): Findback {
  const winner = matcher(v.matchers, 'euclid_height_slope');
  const dtw = matcher(v.matchers, 'dtw_slope');
  const q = isObj(v.quality) ? v.quality : {};
  const wfl = isObj(q.winner_full_library) ? q.winner_full_library : {};
  const app = isObj(q.app_pipeline) ? q.app_pipeline : {};
  const nd = isObj(v.needle_distortion) ? v.needle_distortion : {};
  return {
    top1: num(winner?.top1),
    top5: num(winner?.top5),
    dtwTop1: num(dtw?.top1),
    nRoutes: num(v.n_routes),
    noiseM: num(nd.height_noise_sigma_m),
    stretch: num(nd.length_stretch),
    euclidSpread: spread(wfl.match_distance),
    dtwSpread: spread(app.match_distance),
  };
}

export interface Quality {
  fit: Light;
  /** "Close twin", "Partial twin", "Loose twin". */
  word: string;
  sentence: string;
}

/** How this match compares with the best matches found for the find-back test routes. */
export function matchQuality(dist: number, s: Spread | null, nRoutes: number | null): Quality | null {
  if (!s) return null;
  const n = nRoutes ? `${nRoutes} test routes` : 'our test routes';
  if (dist <= s.p10) return { fit: 'green', word: 'Very close twin', sentence: `closer than 9 in 10 of the best matches we found for ${n}` };
  if (dist <= s.median) return { fit: 'green', word: 'Close twin', sentence: `closer than half of the best matches we found for ${n}` };
  if (dist <= s.p90) return { fit: 'amber', word: 'Partial twin', sentence: `looser than most best matches for ${n}, but in the usual range` };
  return { fit: 'red', word: 'Loose twin', sentence: `looser than 9 in 10 best matches for ${n}: no Earth path climbs quite like this` };
}
