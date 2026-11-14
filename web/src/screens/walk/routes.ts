// Ready-made Moon routes, found on the loaded elevation tile and named by what they do.
import type { LoadedTile } from '../../data/tiles';
import { sampleProfile, type WalkProfile } from '../../lib/terrain';
import type { PresetBest, PresetRoute } from '../../types/contract';

export interface ReadyRoute {
  id: string;
  name: string;
  /** One plain sentence on what walking it is like. */
  blurb: string;
  moon_xy: [number, number][];
  /** Precomputed matches shipped with a preset file (fallback when the search worker fails). */
  best: PresetBest[];
}

type XY = [number, number];

interface Candidate {
  route: XY[];
  prof: WalkProfile;
}

/** Straight lines of `len` metres centred on a grid of points inside the tile, in 16 directions. */
function candidates(tile: LoadedTile, len: number, grid: number): Candidate[] {
  const ref = tile.ref;
  const span = ref.size * ref.res_m;
  const margin = len / 2 + 4 * ref.res_m;
  const out: Candidate[] = [];
  if (span - 2 * margin <= 0) return out;
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const cx = ref.origin_x + margin + ((span - 2 * margin) * (gx + 0.5)) / grid;
      const cy = ref.origin_y - margin - ((span - 2 * margin) * (gy + 0.5)) / grid;
      for (let k = 0; k < 16; k++) {
        const a = (k * 22.5 * Math.PI) / 180;
        const dx = (Math.sin(a) * len) / 2;
        const dy = (Math.cos(a) * len) / 2;
        const route: XY[] = [
          [cx - dx, cy - dy],
          [cx + dx, cy + dy],
        ];
        const prof = sampleProfile(tile.raw, ref.origin_x, ref.origin_y, route, 100);
        if (prof && !prof.hasNaN) out.push({ route, prof });
      }
    }
  }
  return out;
}

function bestBy(list: Candidate[], score: (c: Candidate) => number): Candidate | null {
  let best: Candidate | null = null;
  let bs = -Infinity;
  for (const c of list) {
    const s = score(c);
    if (Number.isFinite(s) && s > bs) {
      bs = s;
      best = c;
    }
  }
  return best;
}

function netRise(p: WalkProfile): number {
  return p.heights[p.heights.length - 1] - p.heights[0];
}

/** Climb to a high point in the middle half, then down the far side: the smaller of the two legs. */
function upAndOver(p: WalkProfile): number {
  const h = p.heights;
  const n = h.length;
  let k = Math.floor(n * 0.25);
  for (let i = Math.floor(n * 0.25); i <= Math.floor(n * 0.75); i++) if (h[i] > h[k]) k = i;
  return Math.min(h[k] - h[0], h[k] - h[n - 1]);
}

/** Routes generated from the tile. Lengths match the Earth library's 1, 2 and 5 km classes. */
export function buildReadyRoutes(tile: LoadedTile, regionId: string): ReadyRoute[] {
  const two = candidates(tile, 2000, 9);
  const five = candidates(tile, 5000, 7);
  const one = candidates(tile, 1000, 9);
  const out: ReadyRoute[] = [];
  const steep = bestBy(two, (c: Candidate): number => netRise(c.prof));
  if (steep)
    out.push({
      id: `${regionId}:steepest`,
      name: 'Steepest climb · 2 km',
      blurb: 'Straight up the biggest 2 km climb in this region.',
      moon_xy: steep.route,
      best: [],
    });
  const over = bestBy(two, (c: Candidate): number => upAndOver(c.prof));
  if (over && upAndOver(over.prof) > 5)
    out.push({
      id: `${regionId}:over`,
      name: 'Up and over a rise · 2 km',
      blurb: 'Climbs onto a high point, then drops down the far side.',
      moon_xy: over.route,
      best: [],
    });
  const scramble = bestBy(one, (c: Candidate): number => c.prof.max_slope_deg);
  if (scramble)
    out.push({
      id: `${regionId}:scramble`,
      name: 'Steep scramble · 1 km',
      blurb: 'The single steepest kilometre we could find.',
      moon_xy: scramble.route,
      best: [],
    });
  // Flattest long walk: lowest steepest-slope, ties broken by the least total climbing.
  const gentle = bestBy(five, (c: Candidate): number => -(c.prof.max_slope_deg + c.prof.climb_m / 200));
  if (gentle)
    out.push({
      id: `${regionId}:gentle`,
      name: 'Gentle traverse · 5 km',
      blurb: 'The flattest long walk in this region.',
      moon_xy: gentle.route,
      best: [],
    });
  return out;
}

/** Routes from a preset file (same data source as the tile), in the ReadyRoute shape. */
export function fromPresets(presets: PresetRoute[]): ReadyRoute[] {
  return presets.map(
    (p: PresetRoute): ReadyRoute => ({
      id: `${p.region_id}:${p.name}`,
      name: p.name,
      blurb: 'A route prepared with the dataset.',
      moon_xy: p.moon_xy,
      best: p.best,
    }),
  );
}

export function routeLength(route: XY[]): number {
  let s = 0;
  for (let i = 1; i < route.length; i++) s += Math.hypot(route[i][0] - route[i - 1][0], route[i][1] - route[i - 1][1]);
  return s;
}

/** Plain summary: "climbs 98 m, steepest 8°, 2.0 km". */
export function summarise(p: WalkProfile): string {
  return `climbs ${Math.round(p.climb_m)} m, steepest ${Math.round(p.max_slope_deg)}°, ${(p.length_m / 1000).toFixed(1)} km`;
}
