// The Moon route a Calgary walk copies, side by side with that walk: LEFT the Moon route on its region's hillshade
// (presets.json moon_xy on moon/<region>_hill.png), RIGHT the Calgary route among nearby pathways, both at the same
// scale with a 1 km bar; the slope chart sits below. Start (filled) and end (hollow) markers match the big map's.
// Direction: presets.json compares slope profiles in one direction only (Moon moon_xy[0] -> [1], Calgary coords[0] ->
// end, see calgary_walks.py match / planner.ts), so the two starts correspond.
import { useMemo, type JSX } from 'react';
import { assetUrl, type Origin } from '../../data/loader';
import { InfoTip } from '../../components/InfoTip';
import { SlopeChart } from '../../components/SlopeChart';
import { useApp } from '../../store';
import type { Region } from '../../types/contract';
import type { CalgaryPreset, CalgaryWalk } from '../../types/alberta';

export type XY = [number, number];

/** presets.json moon_xy (not in the shared CalgaryPreset type): start and end of the straight Moon route, polar-stereographic m. */
export function presetMoonXY(p: CalgaryPreset): [XY, XY] | null {
  if (!('moon_xy' in p)) return null;
  const v: unknown = p.moon_xy;
  if (!Array.isArray(v) || v.length < 2) return null;
  const pt = (q: unknown): XY | null =>
    Array.isArray(q) && typeof q[0] === 'number' && typeof q[1] === 'number' && Number.isFinite(q[0]) && Number.isFinite(q[1]) ? [q[0], q[1]] : null;
  const a = pt(v[0]);
  const b = pt(v[v.length - 1]);
  return a && b ? [a, b] : null;
}

const R_EARTH = 6371008.8;
const RAD = Math.PI / 180;
/** Rendered panel size the marker sizes are tuned for (viewbox units per pixel = side / px). */
const BOX_PX = 240;

function km(m: number): string {
  return (m / 1000).toFixed(1);
}

/** Point and unit direction at fraction t of a polyline's length. */
function along(pts: XY[], t: number): { p: XY; d: XY } {
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    seg.push(l);
    total += l;
  }
  let target = total * t;
  for (let i = 0; i < seg.length; i++) {
    if (target <= seg[i] || i === seg.length - 1) {
      const f = seg[i] > 0 ? Math.min(target / seg[i], 1) : 0;
      const a = pts[i];
      const b = pts[i + 1];
      const l = seg[i] || 1;
      return { p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], d: [(b[0] - a[0]) / l, (b[1] - a[1]) / l] };
    }
    target -= seg[i];
  }
  return { p: pts[0], d: [1, 0] };
}

/** Route, start/end markers, direction chevron and a 1 km bar, drawn in the SVG's own units (u = units per pixel). */
function RouteMarks({
  pts,
  u,
  vb,
  unitsPerKm,
  scale,
}: {
  pts: XY[];
  u: number;
  vb: [number, number, number, number];
  unitsPerKm: number;
  scale: boolean;
}): JSX.Element {
  const line = pts.map((p: XY): string => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');
  const s = pts[0];
  const e = pts[pts.length - 1];
  const { p: m, d } = along(pts, 0.55);
  const n: XY = [-d[1], d[0]];
  const a = 7 * u;
  const chevron = `M ${m[0] - d[0] * a + n[0] * a} ${m[1] - d[1] * a + n[1] * a} L ${m[0]} ${m[1]} L ${m[0] - d[0] * a - n[0] * a} ${m[1] - d[1] * a - n[1] * a}`;
  const [x0, y0, w, h] = vb;
  const bx = x0 + 10 * u;
  const by = y0 + h - 12 * u;
  return (
    <g>
      <polyline className="mt-casing" points={line} strokeWidth={7 * u} />
      <polyline className="mt-route" points={line} strokeWidth={3.5 * u} />
      <path className="mt-chevron-casing" d={chevron} strokeWidth={6 * u} />
      <path className="mt-chevron" d={chevron} strokeWidth={2.5 * u} />
      <circle className="mt-end" cx={e[0]} cy={e[1]} r={5.5 * u} strokeWidth={2.5 * u} />
      <circle className="mt-start" cx={s[0]} cy={s[1]} r={6 * u} strokeWidth={2 * u} />
      {scale && (
      <g className="mt-scale">
        <rect x={bx - 4 * u} y={by - 16 * u} width={unitsPerKm + 8 * u} height={22 * u} rx={3 * u} className="mt-scale-bg" />
        <line x1={bx} y1={by} x2={bx + unitsPerKm} y2={by} strokeWidth={2 * u} />
        <line x1={bx} y1={by - 4 * u} x2={bx} y2={by + 2 * u} strokeWidth={2 * u} />
        <line x1={bx + unitsPerKm} y1={by - 4 * u} x2={bx + unitsPerKm} y2={by + 2 * u} strokeWidth={2 * u} />
        <text x={bx + unitsPerKm / 2} y={by - 5 * u} fontSize={11 * u} textAnchor="middle">
          1 km
        </text>
      </g>
      )}
      <rect x={x0} y={y0} width={w} height={h} fill="none" />
    </g>
  );
}

function MoonPanel({ g, px, scale }: { g: TwinGeom; px: number; scale: boolean }): JSX.Element | null {
  if (!g.region || !g.xy) return null;
  const t = g.region.tile;
  const n = t.size;
  const toPx = (p: XY): XY => [(p[0] - t.origin_x) / t.res_m, (t.origin_y - p[1]) / t.res_m];
  const pts = [toPx(g.xy[0]), toPx(g.xy[1])];
  const side = Math.min(g.w / t.res_m, n);
  const clamp = (v: number): number => Math.min(Math.max(v, side / 2), n - side / 2);
  const cx = clamp((pts[0][0] + pts[1][0]) / 2);
  const cy = clamp((pts[0][1] + pts[1][1]) / 2);
  const vb: [number, number, number, number] = [cx - side / 2, cy - side / 2, side, side];
  return (
    <svg className="mt-svg" viewBox={vb.join(' ')} aria-hidden="true">
      <image href={assetUrl(g.region.hillshade, g.origin)} x={0} y={0} width={n} height={n} preserveAspectRatio="none" />
      <RouteMarks pts={pts} u={side / px} vb={vb} unitsPerKm={1000 / t.res_m} scale={scale} />
    </svg>
  );
}

function project(coords: [number, number][], lat0: number, lon0: number): XY[] {
  const k = Math.cos(lat0 * RAD) * RAD * R_EARTH;
  return coords.map(([la, lo]: [number, number]): XY => [(lo - lon0) * k, -(la - lat0) * RAD * R_EARTH]);
}

function extent(pts: XY[]): number {
  if (!pts.length) return 0;
  const xs = pts.map((p: XY): number => p[0]);
  const ys = pts.map((p: XY): number => p[1]);
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

interface TwinGeom {
  region: Region | null;
  origin: Origin;
  xy: [XY, XY] | null;
  /** Window side in metres, shared by both panels so the 1 km bars match. */
  w: number;
  route: XY[];
  context: XY[][];
}

/** Everything both panels draw: the Moon tile and route, and the Calgary route plus nearby pathways in local metres. */
export function useTwinGeom(preset: CalgaryPreset, walk: CalgaryWalk, walks: CalgaryWalk[]): TwinGeom {
  const regions = useApp((s) => s.core?.regions ?? null);
  const origin = useApp((s): Origin => s.core?.regionsOrigin ?? 'data');
  return useMemo((): TwinGeom => {
    const region = regions?.find((r: Region): boolean => r.id === preset.region) ?? null;
    const xy = presetMoonXY(preset);
    const lats = walk.coords.map((c: [number, number]): number => c[0]);
    const lons = walk.coords.map((c: [number, number]): number => c[1]);
    const lat0 = (Math.min(...lats) + Math.max(...lats)) / 2;
    const lon0 = (Math.min(...lons) + Math.max(...lons)) / 2;
    const route = project(walk.coords, lat0, lon0);
    const moonExt = xy ? Math.max(Math.abs(xy[1][0] - xy[0][0]), Math.abs(xy[1][1] - xy[0][1])) : 0;
    const w = Math.max(2000, Math.ceil((Math.max(extent(route), moonExt) * 1.35) / 250) * 250);
    const dLat = (w / 2 / (RAD * R_EARTH)) * 1.1;
    const dLon = dLat / Math.cos(lat0 * RAD);
    const context: XY[][] = [];
    for (const o of walks) {
      if (o.id === walk.id) continue;
      if (!o.coords.some(([la, lo]: [number, number]): boolean => Math.abs(la - lat0) < dLat && Math.abs(lo - lon0) < dLon)) continue;
      context.push(project(o.coords, lat0, lon0));
      if (context.length >= 400) break;
    }
    return { region, origin, xy, w, route, context };
  }, [regions, origin, preset, walk, walks]);
}

function CalgaryPanel({ g, px, scale }: { g: TwinGeom; px: number; scale: boolean }): JSX.Element {
  const half = g.w / 2;
  const vb: [number, number, number, number] = [-half, -half, g.w, g.w];
  const u = g.w / px;
  return (
    <svg className="mt-svg mt-svg-yyc" viewBox={vb.join(' ')} aria-hidden="true">
      <rect x={vb[0]} y={vb[1]} width={vb[2]} height={vb[3]} className="mt-yyc-bg" />
      <g className="mt-context" strokeWidth={1.25 * u}>
        {g.context.map((c: XY[], i: number) => (
          <polyline key={i} points={c.map((p: XY): string => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')} />
        ))}
      </g>
      <RouteMarks pts={g.route} u={u} vb={vb} unitsPerKm={1000} scale={scale} />
    </svg>
  );
}

/** Small Moon or Calgary thumbnail (no scale bar) for the three-step picture. */
export function RouteThumb({ g, world, px }: { g: TwinGeom; world: 'moon' | 'calgary'; px: number }): JSX.Element | null {
  return world === 'moon' ? <MoonPanel g={g} px={px} scale={false} /> : <CalgaryPanel g={g} px={px} scale={false} />;
}

export interface MoonTwinProps {
  preset: CalgaryPreset;
  walk: CalgaryWalk;
  walks: CalgaryWalk[];
  earth: number[] | null;
  place: string;
}

/** Moon route | Calgary route, same scale, matching markers; the slope chart below. */
export function MoonTwin({ preset, walk, walks, earth, place }: MoonTwinProps): JSX.Element {
  const g = useTwinGeom(preset, walk, walks);
  const moonLabel = `Moon · ${preset.region_name} · ${km(preset.length_m)} km · climbs ${Math.round(preset.climb_m)} m`;
  const yycLabel = `Calgary · ${place} · ${km(walk.length_m)} km · climbs ${Math.round(walk.climb_m)} m`;

  return (
    <div className="mt">
      <div className="mt-grid">
        <figure className="mt-fig">
          <figcaption className="mt-cap">
            <span className="mt-world">Moon</span>
            <span className="mt-cap-text">{preset.region_name}</span>
            <span className="mt-cap-meta">
              {km(preset.length_m)} km · climbs {Math.round(preset.climb_m)} m
            </span>
          </figcaption>
          <div className="mt-box" role="img" aria-label={`${moonLabel}. Route on the region's terrain, start filled, end hollow.`}>
            {g.region && g.xy ? <MoonPanel g={g} px={BOX_PX} scale /> : <div className="mt-wait">Moon terrain not loaded</div>}
          </div>
        </figure>
        <figure className="mt-fig">
          <figcaption className="mt-cap">
            <span className="mt-world">Calgary</span>
            <span className="mt-cap-text">{place}</span>
            <span className="mt-cap-meta">
              {km(walk.length_m)} km · climbs {Math.round(walk.climb_m)} m
            </span>
          </figcaption>
          <div className="mt-box" role="img" aria-label={`${yycLabel}. Same scale as the Moon panel, nearby pathways faint.`}>
            <CalgaryPanel g={g} px={BOX_PX} scale />
          </div>
        </figure>
      </div>
      <div className="mt-key">
        <span className="mt-key-item">
          <span className="mt-key-start" aria-hidden="true" />
          Start
        </span>
        <span className="mt-key-item">
          <span className="mt-key-end" aria-hidden="true" />
          End
        </span>
        <span className="mt-key-item">Same scale</span>
        <InfoTip label="How the two routes line up" title="How the two routes line up" align="end">
          <div className="infotip-body">
            <p>
              The starts line up: both slope profiles are compared in the <strong>same direction of travel</strong>, Moon start to end against the
              Calgary route from its start (the end nearer a bus or train stop).
            </p>
            <p>The Moon route is a straight {km(preset.length_m)} km line on NASA LOLA terrain (30 m). The match is in the ups and downs, not the shape.</p>
          </div>
        </InfoTip>
      </div>
      <SlopeChart
        title="Slope along the route"
        moon={preset.slope_deg}
        earth={earth}
        moonLabel={`Moon · ${preset.region_name}`}
        earthLabel={`Calgary · ${place}`}
      />
    </div>
  );
}
