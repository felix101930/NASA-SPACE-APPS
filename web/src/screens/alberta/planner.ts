// "Plan a Moon walk near you": reproduces calgary/equity.json's definitions in the browser, per route and per tract.
// Suitable route = starts within 400 m of an ACTIVE stop AND matches at least one of the 18 Moon presets with banded DTW
// under 1.0° (Sakoe-Chiba radius 10 on the 100-point signed slope profiles; candidates 0.6–1.6× the Moon route's
// length). The DTW below is a line-for-line port of pipeline/alberta/routes.py dtw_banded (same tie handling), so the
// counts agree with equity.json's summary (checked on load in dev).
import type { CalgaryPreset, CalgaryWalk, OverlaysGeo } from '../../types/alberta';

export const MATCH_DEG = 1;
export const STOP_NEAR_M = 400;
/** Assumed walking pace (4.8 km/h), the same as equity.json's minutes_walk. */
export const WALK_M_PER_MIN = 80;
const DTW_BAND = 10;
const LEN_LO = 0.6;
const LEN_HI = 1.6;
const ROUTES_CAP = 4;
/** Calgary Transit school-term specials (600–899): not counted, they do not run for weekend events. */
const SCHOOL_LO = 600;
const SCHOOL_HI = 899;

/** Mean |slope difference| (deg) along the optimal banded warping path; a port of routes.dtw_banded. */
export function dtwBanded(a: ArrayLike<number>, b: ArrayLike<number>, band: number): number {
  const n = a.length;
  const m = b.length;
  let prevD = new Float64Array(m + 1).fill(Infinity);
  let prevL = new Float64Array(m + 1);
  let curD = new Float64Array(m + 1);
  let curL = new Float64Array(m + 1);
  prevD[0] = 0;
  for (let i = 1; i <= n; i++) {
    curD.fill(Infinity);
    curL.fill(0);
    const j0 = Math.max(1, i - band);
    const j1 = Math.min(m, i + band);
    for (let j = j0; j <= j1; j++) {
      const c = Math.abs(a[i - 1] - b[j - 1]);
      let best = prevD[j - 1];
      let bl = prevL[j - 1];
      if (prevD[j] < best) {
        best = prevD[j];
        bl = prevL[j];
      }
      if (curD[j - 1] < best) {
        best = curD[j - 1];
        bl = curL[j - 1];
      }
      curD[j] = best + c;
      curL[j] = bl + 1;
    }
    const tD = prevD;
    prevD = curD;
    curD = tD;
    const tL = prevL;
    prevL = curL;
    curL = tL;
  }
  return prevD[m] / Math.max(prevL[m], 1);
}

export function isSchoolRoute(name: string): boolean {
  const m = /^\s*(\d+)/.exec(name);
  if (!m) return false;
  const k = Number(m[1]);
  return k >= SCHOOL_LO && k <= SCHOOL_HI;
}

/** "75 Somerset - Mahogany" -> "75". */
export function routeNumber(route: string): string {
  return /^\s*(\d+[A-Z]?)/.exec(route)?.[1] ?? route;
}

export function minutesWalk(distM: number): number {
  return Math.max(1, Math.ceil(distM / WALK_M_PER_MIN));
}

export interface TractInfo {
  ctuid: string;
  /** Title-cased named communities (residual sub-area codes dropped). */
  communities: string[];
  label: string;
  category: string | null;
  centroid: [number, number];
}

export interface PlannerIndex {
  /** Per walk (index in walks.items): best DTW over length-compatible presets (Infinity if none). */
  bestDtw: Float64Array;
  /** Per walk: index of that preset in presets.json, -1 if none. */
  bestPreset: Int16Array;
  suitable: Uint8Array;
  nSuitable: number;
  nMoonMatch: number;
  tracts: Map<string, TractInfo>;
  /** Suitable walk indices per tract (route midpoint tract), best first (transit × slope match). */
  suitableByTract: Map<string, number[]>;
  /** All suitable walk indices. */
  suitableAll: number[];
}

const SUBAREA = /^\d{2}[A-Z]$/;

export function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s/(-])\w/g, (c: string): string => c.toUpperCase());
}

export function communityList(raw: string): string[] {
  return raw
    .split(',')
    .map((s: string): string => s.trim())
    .filter((s: string): boolean => s.length > 0 && !SUBAREA.test(s))
    .map(titleCase);
}

/** Area-weighted centroid of a (Multi)Polygon's outer rings, in lon/lat (planar in a local frame, fine at city scale). */
function ringCentroid(rings: number[][][]): [number, number, number] {
  let ax = 0;
  let ay = 0;
  let aa = 0;
  for (const ring of rings) {
    for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
      const [x0, y0] = ring[k];
      const [x1, y1] = ring[i];
      const cross = x0 * y1 - x1 * y0;
      aa += cross;
      ax += (x0 + x1) * cross;
      ay += (y0 + y1) * cross;
    }
  }
  return [ax, ay, aa];
}

export function tractCentroids(o: OverlaysGeo): Map<string, TractInfo> {
  const out = new Map<string, TractInfo>();
  for (const f of o.features) {
    const g = f.geometry;
    const polys: number[][][][] = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    let ax = 0;
    let ay = 0;
    let aa = 0;
    let fx = 0;
    let fy = 0;
    let fn = 0;
    for (const p of polys) {
      const outer = p[0] ?? [];
      const [x, y, a] = ringCentroid([outer]);
      ax += x;
      ay += y;
      aa += a;
      for (const pt of outer) {
        fx += pt[0];
        fy += pt[1];
        fn++;
      }
    }
    const centroid: [number, number] = Math.abs(aa) > 1e-12 ? [ax / (3 * aa), ay / (3 * aa)] : [fx / Math.max(fn, 1), fy / Math.max(fn, 1)];
    const p = f.properties;
    const communities = communityList(p.communities ?? '');
    out.set(p.ctuid, {
      ctuid: p.ctuid,
      communities,
      label: communities.length ? communities.join(', ') : `Census tract ${p.name}`,
      category: typeof p.access_category === 'string' ? p.access_category : null,
      centroid,
    });
  }
  return out;
}

/** Straight-line distance in metres between two [lon, lat] points (equirectangular; error far below 1% at city scale). */
export function distM(a: [number, number], b: [number, number]): number {
  const R = 6371008.8;
  const rad = Math.PI / 180;
  const x = (b[0] - a[0]) * rad * Math.cos(((a[1] + b[1]) / 2) * rad);
  const y = (b[1] - a[1]) * rad;
  return Math.hypot(x, y) * R;
}

export function startLonLat(w: CalgaryWalk): [number, number] {
  const [lat, lon] = w.coords[0];
  return [lon, lat];
}

export function publicRoutes(w: CalgaryWalk): string[] {
  return (w.near_stop?.routes ?? []).filter((r: string): boolean => !isSchoolRoute(r));
}

/** equity.json's per-route event factor: transit × slope match (0–1). */
export function routeQuality(w: CalgaryWalk, dtw: number): number {
  const d = w.near_stop?.dist_m ?? Infinity;
  const transit = 0.5 * Math.max(0, 1 - d / STOP_NEAR_M) + 0.5 * (Math.min(publicRoutes(w).length, ROUTES_CAP) / ROUTES_CAP);
  return transit * Math.max(0, 1 - dtw / MATCH_DEG);
}

const yieldToBrowser = (): Promise<void> =>
  new Promise((resolve: () => void): void => {
    setTimeout(resolve, 0);
  });

/** Builds the planner index; yields between presets so the page stays responsive (≈ 100 ms of work in total). */
export async function buildPlannerIndex(
  walks: CalgaryWalk[],
  rows: Float32Array,
  pts: number,
  presets: CalgaryPreset[],
  overlays: OverlaysGeo,
): Promise<PlannerIndex> {
  const n = walks.length;
  const bestDtw = new Float64Array(n).fill(Infinity);
  const bestPreset = new Int16Array(n).fill(-1);
  for (let pi = 0; pi < presets.length; pi++) {
    const p = presets[pi];
    const a = Float64Array.from(p.slope_deg);
    for (let k = 0; k < n; k++) {
      const w = walks[k];
      if (w.length_m < LEN_LO * p.length_m || w.length_m > LEN_HI * p.length_m) continue;
      const b = rows.subarray(w.row * pts, (w.row + 1) * pts);
      const d = dtwBanded(a, b, DTW_BAND);
      if (d < bestDtw[k]) {
        bestDtw[k] = d;
        bestPreset[k] = pi;
      }
    }
    await yieldToBrowser();
  }
  const suitable = new Uint8Array(n);
  const suitableByTract = new Map<string, number[]>();
  const suitableAll: number[] = [];
  let nMoonMatch = 0;
  for (let k = 0; k < n; k++) {
    const w = walks[k];
    const match = bestDtw[k] < MATCH_DEG;
    if (match) nMoonMatch++;
    if (match && (w.near_stop?.dist_m ?? Infinity) <= STOP_NEAR_M) {
      suitable[k] = 1;
      suitableAll.push(k);
      const ct = w.tract?.ctuid;
      if (ct) {
        const list = suitableByTract.get(ct) ?? [];
        list.push(k);
        suitableByTract.set(ct, list);
      }
    }
  }
  for (const list of suitableByTract.values()) {
    list.sort(
      (x: number, y: number): number =>
        routeQuality(walks[y], bestDtw[y]) - routeQuality(walks[x], bestDtw[x]) || walks[x].id.localeCompare(walks[y].id),
    );
  }
  return {
    bestDtw,
    bestPreset,
    suitable,
    nSuitable: suitableAll.length,
    nMoonMatch,
    tracts: tractCentroids(overlays),
    suitableByTract,
    suitableAll,
  };
}

export interface PlanOption {
  walkIndex: number;
  /** Straight-line metres from the tract centre to the route start (0 when the route is in the tract). */
  distFromTractM: number;
  inTract: boolean;
}

/** equity.json's own nearest-route answer for an unreached tract (its centroid is computed in map metres). */
export interface PreferredNearest {
  walkIndex: number;
  distKm: number;
}

/**
 * Suitable routes for a tract: its own (best first), else the nearest suitable routes anywhere (up to 3).
 * For the highest-need unreached tracts, equity.json's nearest route leads, with its distance, so the two views agree.
 */
export function planFor(ix: PlannerIndex, walks: CalgaryWalk[], ctuid: string, preferred?: PreferredNearest): PlanOption[] {
  const own = ix.suitableByTract.get(ctuid) ?? [];
  const t = ix.tracts.get(ctuid);
  if (own.length) {
    return own.map((k: number): PlanOption => ({
      walkIndex: k,
      distFromTractM: t ? distM(t.centroid, startLonLat(walks[k])) : 0,
      inTract: true,
    }));
  }
  if (!t) return [];
  const near = ix.suitableAll
    .map((k: number): PlanOption => ({ walkIndex: k, distFromTractM: distM(t.centroid, startLonLat(walks[k])), inTract: false }))
    .sort((a: PlanOption, b: PlanOption): number => a.distFromTractM - b.distFromTractM)
    .slice(0, 3);
  if (!preferred) return near;
  const rest = near.filter((o: PlanOption): boolean => o.walkIndex !== preferred.walkIndex).slice(0, 2);
  return [{ walkIndex: preferred.walkIndex, distFromTractM: preferred.distKm * 1000, inTract: false }, ...rest];
}

// ------------------------------------------------------------------------------------------------ event ranking
const MIN_SEP_M = 2000;

/** Accessibility & Amenities score -> percentile among tracts with a score (0 = least need, 1 = most), average ranks for ties. */
export function needPercentiles(overlays: OverlaysGeo): Map<string, number> {
  const ts = overlays.features
    .map((f): { ctuid: string; score: number | null } => ({ ctuid: f.properties.ctuid, score: f.properties.access_domain_score }))
    .filter((t): t is { ctuid: string; score: number } => typeof t.score === 'number' && Number.isFinite(t.score));
  const out = new Map<string, number>();
  if (ts.length < 2) {
    ts.forEach((t): void => void out.set(t.ctuid, 1));
    return out;
  }
  const sorted = [...ts].sort((a, b): number => a.score - b.score);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].score === sorted[i].score) j++;
    const avgRank = (i + j) / 2 + 1; // 1-based average rank, as scipy rankdata(method="average")
    for (let k = i; k <= j; k++) out.set(sorted[k].ctuid, (avgRank - 1) / (ts.length - 1));
    i = j + 1;
  }
  return out;
}

export interface EventPick {
  rank: number;
  ctuid: string;
  walkIndex: number;
  score: number;
  need: number;
}

/**
 * equity.json's event ranking: one route per tract (its best transit × slope match), tracts ranked by score, starts at
 * least 2 km apart (greedy, in rank order); ties by tract id. weighted = need × transit × match (equity.json's
 * top_events); unweighted = transit × match only, to show what the Equity Index changes.
 */
export function rankEvents(ix: PlannerIndex, walks: CalgaryWalk[], pct: Map<string, number>, weighted: boolean, n = 5): EventPick[] {
  const best = new Map<string, { local: number; k: number }>();
  const order = ix.suitableAll.slice().sort((a: number, b: number): number => (walks[a].id < walks[b].id ? -1 : walks[a].id > walks[b].id ? 1 : 0));
  for (const k of order) {
    const ct = walks[k].tract?.ctuid;
    if (!ct || !pct.has(ct)) continue;
    const local = routeQuality(walks[k], ix.bestDtw[k]);
    const prev = best.get(ct);
    if (!prev || local > prev.local + 1e-12) best.set(ct, { local, k });
  }
  const ranked = Array.from(best.entries())
    .map(([ctuid, v]): { ctuid: string; k: number; score: number; need: number } => {
      const need = pct.get(ctuid) ?? 0;
      return { ctuid, k: v.k, need, score: weighted ? need * v.local : v.local };
    })
    .sort((a, b): number => b.score - a.score || (a.ctuid < b.ctuid ? -1 : a.ctuid > b.ctuid ? 1 : 0));
  const picked: EventPick[] = [];
  for (const r of ranked) {
    if (picked.length >= n) break;
    const s = startLonLat(walks[r.k]);
    if (picked.every((q: EventPick): boolean => distM(s, startLonLat(walks[q.walkIndex])) >= MIN_SEP_M)) {
      picked.push({ rank: picked.length + 1, ctuid: r.ctuid, walkIndex: r.k, score: r.score, need: r.need });
    }
  }
  return picked;
}
