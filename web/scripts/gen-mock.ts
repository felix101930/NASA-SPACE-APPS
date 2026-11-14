// Generates MOCK data in web/public/mock/ that conforms to docs/data-contract.md.
// Run: `npm run mock` (Node 24 strips the TypeScript types natively).
// Every value here is synthetic. The app shows a "MOCK DATA" badge whenever it falls back to these files.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';
import { computeShadowMask, hillshade, pixelToMap, sampleBilinear, sampleProfile, type Grid } from '../src/lib/terrain.ts';
import { dtwBanded } from '../src/lib/dtw.ts';
import { refractionDeg, sunPosition } from '../src/lib/solar.ts';
import type {
  EarthSite,
  HazardId,
  LightRow,
  Match,
  Meta,
  PresetRoute,
  RankingRow,
  Region,
  RehearsalWindow,
  TransectItem,
} from '../src/types/contract.ts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'mock');
const SIZE = 250; // mock tiles are smaller than the real 500 px, still covering 15 km
const RES = 60;

// ------------------------------------------------------------------------------------------------
// Utilities
// ------------------------------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function write(rel: string, data: string | Uint8Array): void {
  const p = join(OUT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/** Minimal PNG encoder: channels 1 = gray, 2 = gray+alpha. */
function encodePng(pixels: Uint8Array | Uint8ClampedArray, w: number, h: number, channels: 1 | 2): Uint8Array {
  const raw = Buffer.alloc((w * channels + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * channels + 1)] = 0;
    for (let x = 0; x < w * channels; x++) raw[y * (w * channels + 1) + 1 + x] = pixels[y * w * channels + x];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 1 ? 0 : 4;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

function makeNoise(seed: number, cells: number): (x: number, y: number) => number {
  const rnd = mulberry32(seed);
  const g = new Float32Array((cells + 1) * (cells + 1)).map((): number => rnd() * 2 - 1);
  const s = (t: number): number => t * t * (3 - 2 * t);
  return (x: number, y: number): number => {
    const xi = Math.floor(x) % cells;
    const yi = Math.floor(y) % cells;
    const fx = s(x - Math.floor(x));
    const fy = s(y - Math.floor(y));
    const a = g[yi * (cells + 1) + xi];
    const b = g[yi * (cells + 1) + xi + 1];
    const c = g[(yi + 1) * (cells + 1) + xi];
    const d = g[(yi + 1) * (cells + 1) + xi + 1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}

function round(v: number, d: number = 3): number {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

// ------------------------------------------------------------------------------------------------
// Synthetic terrain
// ------------------------------------------------------------------------------------------------

interface TerrainParams {
  seed: number;
  roughAmp: number; // m, fBm amplitude
  craters: number;
  craterMaxR: number; // m
  massif?: number; // m, Gaussian massif amplitude
  wall?: { depth: number; R: number }; // a big crater whose rim crosses the tile
  dunes?: number; // m, smooth ripple amplitude
  base: number; // m, absolute base height
}

function craterProfile(d: number, R: number): number {
  const depth = 0.38 * R;
  const rimH = 0.07 * R;
  if (d < R) return -depth * (1 - (d / R) ** 2) + rimH;
  return rimH * (R / d) ** 3;
}

function synthTerrain(p: TerrainParams): Float32Array {
  const rnd = mulberry32(p.seed);
  const n1 = makeNoise(p.seed + 1, 64);
  const n2 = makeNoise(p.seed + 2, 64);
  const data = new Float32Array(SIZE * SIZE);
  const ext = SIZE * RES;
  const craters: { x: number; y: number; R: number }[] = [];
  for (let i = 0; i < p.craters; i++) {
    // power-law size distribution: many small, few large
    const R = Math.max(RES * 1.2, p.craterMaxR * rnd() ** 3);
    craters.push({ x: rnd() * ext, y: rnd() * ext, R });
  }
  const mx = ext * (0.3 + rnd() * 0.4);
  const my = ext * (0.3 + rnd() * 0.4);
  const wallAng = rnd() * Math.PI * 2;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const x = c * RES;
      const y = r * RES;
      let h = p.base;
      // fBm
      let amp = p.roughAmp;
      let f = 1 / 3000;
      for (let o = 0; o < 5; o++) {
        h += amp * n1((x * f) % 64, (y * f) % 64);
        amp *= 0.5;
        f *= 2;
      }
      if (p.massif) {
        const d2 = ((x - mx) ** 2 + (y - my) ** 2) / (4500 * 4500);
        h += p.massif * Math.exp(-d2) * (1 + 0.15 * n2((x / 1500) % 64, (y / 1500) % 64));
      }
      if (p.wall) {
        const cx = ext / 2 + Math.cos(wallAng) * (p.wall.R * 0.85);
        const cy = ext / 2 + Math.sin(wallAng) * (p.wall.R * 0.85);
        const d = Math.hypot(x - cx, y - cy);
        const t = (d - p.wall.R) / (p.wall.R * 0.12);
        h += -p.wall.depth / (1 + Math.exp(t)) + p.wall.depth * 0.15 * Math.exp(-(t * t));
      }
      if (p.dunes) {
        h += p.dunes * Math.sin(x / 420 + 0.6 * Math.sin(y / 900)) * (0.7 + 0.3 * n2((x / 2000) % 64, (y / 2000) % 64));
      }
      for (const k of craters) {
        const d = Math.hypot(x - k.x, y - k.y);
        if (d < k.R * 4) h += craterProfile(d, k.R);
      }
      data[r * SIZE + c] = h;
    }
  }
  return data;
}

// ------------------------------------------------------------------------------------------------
// Metrics (simplified versions of the pipeline's definitions, on the mock grid)
// ------------------------------------------------------------------------------------------------

type Metrics = Record<string, number>;

function shadowFrac(g: Grid, el: number): number {
  let tot = 0;
  for (const az of [45, 135, 225, 315]) {
    const m = computeShadowMask(g, el, az, 160);
    let s = 0;
    for (let i = 0; i < m.length; i++) s += m[i];
    tot += s / m.length;
  }
  return tot / 4;
}

function jumpMetrics(g: Grid): { p95: number; p99: number; over500: number } {
  const k = Math.round(1000 / g.res);
  const vals: number[] = [];
  const n = g.size;
  for (let r = 0; r < n; r += 3) {
    for (let c = 0; c + k < n; c += 2) {
      vals.push(Math.abs(g.data[r * n + c + k] - g.data[r * n + c]));
      vals.push(Math.abs(g.data[(c + k) * n + r] - g.data[c * n + r]));
    }
  }
  vals.sort((a: number, b: number): number => a - b);
  const over = vals.filter((v: number): boolean => v > 500).length / vals.length;
  return { p95: percentile(vals, 0.95), p99: percentile(vals, 0.99), over500: over };
}

function slopeAndRough(g: Grid): { p50: number; p90: number; rms: Record<string, number> } {
  const n = g.size;
  const slopes: number[] = [];
  for (let r = 1; r < n - 1; r += 2) {
    for (let c = 1; c < n - 1; c += 2) {
      const dx = (g.data[r * n + c + 1] - g.data[r * n + c - 1]) / (2 * g.res);
      const dy = (g.data[(r + 1) * n + c] - g.data[(r - 1) * n + c]) / (2 * g.res);
      slopes.push((Math.atan(Math.hypot(dx, dy)) * 180) / Math.PI);
    }
  }
  slopes.sort((a: number, b: number): number => a - b);
  const rms: Record<string, number> = {};
  for (const L of [60, 120, 240, 480, 960]) {
    const k = Math.max(1, Math.round(L / g.res));
    let s = 0;
    let cnt = 0;
    for (let r = 0; r < n; r += 2) {
      for (let c = 0; c + k < n; c += 2) {
        s += (g.data[r * n + c + k] - g.data[r * n + c]) ** 2;
        cnt++;
      }
    }
    rms[String(L)] = round(Math.sqrt(s / cnt), 1);
  }
  return { p50: percentile(slopes, 0.5), p90: percentile(slopes, 0.9), rms };
}

/** FAST-like keypoint proxy on a shadowed hillshade at 3° sun: local maxima of shade-gradient magnitude. */
function textureMetrics(g: Grid): { perKm2: number; emptyFrac: number } {
  const n = g.size;
  const hs = hillshade(g, 135, 3, 1);
  const sh = computeShadowMask(g, 3, 135, 160);
  const img = new Float32Array(n * n);
  for (let i = 0; i < img.length; i++) img[i] = sh[i] ? 0 : hs[i];
  const grad = new Float32Array(n * n);
  for (let r = 1; r < n - 1; r++)
    for (let c = 1; c < n - 1; c++)
      grad[r * n + c] = Math.hypot(img[r * n + c + 1] - img[r * n + c - 1], img[(r + 1) * n + c] - img[(r - 1) * n + c]);
  const cell = Math.round(1000 / g.res);
  const cellsPer = Math.floor(n / cell);
  const counts = new Int32Array(cellsPer * cellsPer);
  let kp = 0;
  for (let r = 2; r < n - 2; r++) {
    for (let c = 2; c < n - 2; c++) {
      const v = grad[r * n + c];
      if (v < 40) continue;
      let isMax = true;
      for (let dr = -1; dr <= 1 && isMax; dr++)
        for (let dc = -1; dc <= 1; dc++) if ((dr || dc) && grad[(r + dr) * n + c + dc] > v) isMax = false;
      if (!isMax) continue;
      kp++;
      const cr = Math.floor(r / cell);
      const cc = Math.floor(c / cell);
      if (cr < cellsPer && cc < cellsPer) counts[cr * cellsPer + cc]++;
    }
  }
  const areaKm2 = ((n * g.res) / 1000) ** 2;
  let empty = 0;
  for (let i = 0; i < counts.length; i++) if (counts[i] === 0) empty++;
  return { perKm2: kp / areaKm2, emptyFrac: empty / counts.length };
}

function allMetrics(g: Grid, sunMin: number, sunMax: number): Metrics {
  const s1 = shadowFrac(g, 1);
  const s3 = shadowFrac(g, 3);
  const s5 = shadowFrac(g, 5);
  // time-weighted: approximate the share of time spent at each elevation inside the sun range
  const w = (el: number): number => (el >= sunMin - 0.5 && el <= sunMax + 0.5 ? 1 : 0.2);
  const tw = (s1 * w(1) + s3 * w(3) + s5 * w(5)) / (w(1) + w(3) + w(5));
  const j = jumpMetrics(g);
  const t = textureMetrics(g);
  const sr = slopeAndRough(g);
  return {
    shadow_frac_el1: round(s1),
    shadow_frac_el3: round(s3),
    shadow_frac_el5: round(s5),
    shadow_frac_timeweighted: round(tw),
    jump1km_p95_m: round(j.p95, 1),
    jump1km_p99_m: round(j.p99, 1),
    frac_track_over_500m: round(j.over500),
    fast_per_km2_el3: round(t.perKm2, 2),
    empty_cell_frac_el3: round(t.emptyFrac),
    slope_p50_deg: round(sr.p50, 2),
    slope_p90_deg: round(sr.p90, 2),
    ...Object.fromEntries(Object.entries(sr.rms).map(([k, v]: [string, number]): [string, number] => [`rms_dev_m_${k}`, v])),
  };
}

const HAZARD_METRICS: Record<HazardId, string[]> = {
  shadow: ['shadow_frac_el1', 'shadow_frac_el3', 'shadow_frac_el5', 'shadow_frac_timeweighted'],
  rim: ['jump1km_p95_m', 'jump1km_p99_m', 'frac_track_over_500m'],
  texture: ['fast_per_km2_el3', 'empty_cell_frac_el3'],
};

// ------------------------------------------------------------------------------------------------
// Inputs
// ------------------------------------------------------------------------------------------------

const R_MOON = 1737400;

function stereo(lat: number, lon: number): { x: number; y: number } {
  const rho = 2 * R_MOON * Math.tan(((90 + lat) * Math.PI) / 360);
  const l = (lon * Math.PI) / 180;
  return { x: rho * Math.sin(l), y: rho * Math.cos(l) };
}

interface RegionDef {
  id: string;
  name: string;
  lat: number;
  lon: number;
  q: 'pgda_site_tile' | 'traced_approx';
  t: Omit<TerrainParams, 'seed' | 'base'>;
}

const REGIONS: RegionDef[] = [
  { id: 'cabeus_b_peak', name: 'Peak near Cabeus B', lat: -84.6, lon: -42, q: 'traced_approx', t: { roughAmp: 60, craters: 70, craterMaxR: 1800, massif: 1400 } },
  { id: 'haworth', name: 'Haworth', lat: -87.2, lon: -10, q: 'pgda_site_tile', t: { roughAmp: 50, craters: 60, craterMaxR: 1500, wall: { depth: 3200, R: 18000 } } },
  { id: 'malapert_massif', name: 'Malapert Massif', lat: -86.0, lon: 2, q: 'pgda_site_tile', t: { roughAmp: 55, craters: 50, craterMaxR: 1400, massif: 2600 } },
  { id: 'mons_mouton_plateau', name: 'Mons Mouton Plateau', lat: -85.3, lon: 36, q: 'traced_approx', t: { roughAmp: 25, craters: 110, craterMaxR: 900 } },
  { id: 'mons_mouton', name: 'Mons Mouton', lat: -84.6, lon: 31, q: 'pgda_site_tile', t: { roughAmp: 45, craters: 70, craterMaxR: 1300, massif: 2100 } },
  { id: 'nobile_rim_1', name: 'Nobile Rim 1', lat: -84.4, lon: 62, q: 'pgda_site_tile', t: { roughAmp: 50, craters: 60, craterMaxR: 1500, wall: { depth: 2500, R: 30000 } } },
  { id: 'nobile_rim_2', name: 'Nobile Rim 2', lat: -85.7, lon: 41, q: 'pgda_site_tile', t: { roughAmp: 40, craters: 60, craterMaxR: 1300, wall: { depth: 1900, R: 30000 } } },
  { id: 'de_gerlache_rim_2', name: 'de Gerlache Rim 2', lat: -88.7, lon: -68, q: 'pgda_site_tile', t: { roughAmp: 45, craters: 60, craterMaxR: 1400, wall: { depth: 2300, R: 16000 } } },
  { id: 'slater_plain', name: 'Slater Plain', lat: -87.9, lon: 118, q: 'traced_approx', t: { roughAmp: 9, craters: 25, craterMaxR: 500 } },
];

interface SiteDef {
  name: string;
  country: string;
  lat: number;
  lon: number;
  category: string;
  role: 'candidate' | 'heldout_positive' | 'decoy';
  bare: number;
  lith: string;
  anor?: boolean;
  t: Omit<TerrainParams, 'seed' | 'base'>;
  base: number;
}

const SITES: SiteDef[] = [
  { name: 'Barringer (Meteor) Crater', country: 'USA', lat: 35.027, lon: -111.022, category: 'impact_crater', role: 'candidate', bare: 0.82, lith: 'sandstone, limestone', base: 1700, t: { roughAmp: 8, craters: 6, craterMaxR: 600 } },
  { name: 'Haughton Crater', country: 'Canada', lat: 75.383, lon: -89.667, category: 'known_analog', role: 'heldout_positive', bare: 0.91, lith: 'dolomite, impact breccia', base: 150, t: { roughAmp: 40, craters: 10, craterMaxR: 2500 } },
  { name: 'Ries Crater rim', country: 'Germany', lat: 48.883, lon: 10.617, category: 'impact_crater', role: 'candidate', bare: 0.18, lith: 'suevite, limestone', base: 450, t: { roughAmp: 35, craters: 2, craterMaxR: 3000 } },
  { name: 'Gosses Bluff', country: 'Australia', lat: -23.817, lon: 132.307, category: 'impact_crater', role: 'candidate', bare: 0.74, lith: 'sandstone', base: 700, t: { roughAmp: 30, craters: 3, craterMaxR: 2400, massif: 180 } },
  { name: 'Roter Kamm', country: 'Namibia', lat: -27.766, lon: 16.29, category: 'impact_crater', role: 'candidate', bare: 0.95, lith: 'gneiss, aeolian sand', base: 600, t: { roughAmp: 12, craters: 4, craterMaxR: 1300, dunes: 4 } },
  { name: 'Tenoumer Crater', country: 'Mauritania', lat: 22.917, lon: -10.4, category: 'impact_crater', role: 'candidate', bare: 0.97, lith: 'granite, gneiss', base: 300, t: { roughAmp: 10, craters: 3, craterMaxR: 1000 } },
  { name: 'Black Point Lava Flow', country: 'USA', lat: 35.68, lon: -111.47, category: 'known_analog', role: 'heldout_positive', bare: 0.88, lith: 'basalt', base: 1500, t: { roughAmp: 25, craters: 12, craterMaxR: 400 } },
  { name: 'Cinder Lake Crater Field', country: 'USA', lat: 35.3, lon: -111.5, category: 'known_analog', role: 'heldout_positive', bare: 0.7, lith: 'basaltic cinder', base: 2100, t: { roughAmp: 15, craters: 140, craterMaxR: 350 } },
  { name: 'Mauna Kea upper slopes', country: 'USA', lat: 19.82, lon: -155.47, category: 'known_analog', role: 'heldout_positive', bare: 0.93, lith: 'basalt, tephra', base: 3800, t: { roughAmp: 80, craters: 30, craterMaxR: 700, massif: 450 } },
  { name: 'Timanfaya lava field', country: 'Spain', lat: 29.0, lon: -13.75, category: 'known_analog', role: 'heldout_positive', bare: 0.9, lith: 'basalt', base: 300, t: { roughAmp: 45, craters: 40, craterMaxR: 600 } },
  { name: 'Salar de Atacama margin', country: 'Chile', lat: -23.5, lon: -68.25, category: 'desert', role: 'candidate', bare: 0.99, lith: 'evaporite, alluvium', base: 2300, t: { roughAmp: 4, craters: 0, craterMaxR: 100 } },
  { name: 'Death Valley, Badwater fan', country: 'USA', lat: 36.23, lon: -116.77, category: 'known_analog', role: 'heldout_positive', bare: 0.97, lith: 'alluvium, carbonate', base: 0, t: { roughAmp: 260, craters: 0, craterMaxR: 100, massif: 1500 } },
  { name: 'Mistastin Lake crater', country: 'Canada', lat: 55.883, lon: -63.317, category: 'anorthosite', role: 'candidate', bare: 0.45, lith: 'anorthosite, impact melt', anor: true, base: 330, t: { roughAmp: 70, craters: 2, craterMaxR: 4000 } },
  { name: 'Bockfjord volcanic complex', country: 'Norway', lat: 79.4, lon: 13.3, category: 'high_arctic', role: 'candidate', bare: 0.86, lith: 'basalt, gneiss', base: 200, t: { roughAmp: 280, craters: 5, craterMaxR: 800, wall: { depth: 900, R: 14000 } } },
  { name: 'Wolfe Creek Crater', country: 'Australia', lat: -19.172, lon: 127.795, category: 'impact_crater', role: 'candidate', bare: 0.8, lith: 'sandstone', base: 300, t: { roughAmp: 6, craters: 2, craterMaxR: 450, dunes: 3 } },
  { name: 'Kamil Crater', country: 'Egypt', lat: 22.018, lon: 26.088, category: 'impact_crater', role: 'candidate', bare: 0.99, lith: 'sandstone', base: 600, t: { roughAmp: 5, craters: 3, craterMaxR: 200 } },
  { name: 'Aorounga crater field', country: 'Chad', lat: 19.1, lon: 19.25, category: 'impact_crater', role: 'candidate', bare: 0.98, lith: 'sandstone', base: 500, t: { roughAmp: 18, craters: 5, craterMaxR: 3000, dunes: 6 } },
  { name: 'Erg Chebbi dunes', country: 'Morocco', lat: 31.1, lon: -4.0, category: 'decoy', role: 'decoy', bare: 0.99, lith: 'aeolian sand', base: 750, t: { roughAmp: 8, craters: 0, craterMaxR: 100, dunes: 35 } },
  { name: 'Central Iowa farmland', country: 'USA', lat: 42.0, lon: -93.5, category: 'decoy', role: 'decoy', bare: 0.04, lith: 'glacial till', base: 300, t: { roughAmp: 6, craters: 0, craterMaxR: 100 } },
  { name: 'Amazon lowland forest', country: 'Brazil', lat: -3.4, lon: -62.2, category: 'decoy', role: 'decoy', bare: 0.01, lith: 'alluvium', base: 60, t: { roughAmp: 18, craters: 0, craterMaxR: 100 } },
  { name: 'Lonar Crater', country: 'India', lat: 19.976, lon: 76.508, category: 'impact_crater', role: 'decoy', bare: 0.12, lith: 'basalt', base: 560, t: { roughAmp: 10, craters: 1, craterMaxR: 900 } },
  { name: 'Sudbury anorthosite outcrops', country: 'Canada', lat: 46.6, lon: -81.0, category: 'anorthosite', role: 'candidate', bare: 0.35, lith: 'norite, anorthosite', anor: true, base: 300, t: { roughAmp: 55, craters: 0, craterMaxR: 100 } },
];

const META = (extra: string): Meta => ({
  generated_utc: '2026-11-14T19:00:00Z',
  pipeline_version: `mock-0.1 (${extra})`,
  sources: [
    { name: 'MOCK DATA - synthetic terrain, not real measurements', url: '', licence: 'n/a', citation: 'Generated by web/scripts/gen-mock.ts' },
    { name: 'LOLA 20 m/px south-pole DEM (PGDA product 90)', url: 'https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/', licence: 'NASA open data; cite the data paper', citation: 'Barker et al. 2023, PSJ, doi:10.3847/PSJ/acf3e1' },
    { name: 'Copernicus DEM GLO-30', url: 'https://copernicus-dem-30m.s3.amazonaws.com/', licence: 'ESA, attribution required', citation: 'Copernicus DEM, ESA (2021)' },
  ],
});

// ------------------------------------------------------------------------------------------------
// Build
// ------------------------------------------------------------------------------------------------

function main(): void {
  mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();

  // ---- Moon regions ----
  const moonGrids = new Map<string, Grid>();
  const regionMetrics = new Map<string, Metrics>();
  const regions: Region[] = [];
  REGIONS.forEach((d: RegionDef, idx: number): void => {
    const { x, y } = stereo(d.lat, d.lon);
    const data = synthTerrain({ ...d.t, seed: 1000 + idx * 17, base: -1500 + idx * 300 });
    const g: Grid = { data, size: SIZE, res: RES };
    moonGrids.set(d.id, g);
    write(`moon/${d.id}.bin`, new Uint8Array(data.buffer));
    write(`moon/${d.id}_hill.png`, encodePng(hillshade(g, 315, 25, 1), SIZE, SIZE, 1));
    const colat = 90 + d.lat;
    const sun = { el_min: round(colat - 1.54, 2), el_max: round(colat + 1.54, 2), note: 'geometric, from latitude ± 1.54° declination' };
    const masks: { el: number; az: number; path: string }[] = [];
    for (const el of [1, 3, 5]) {
      for (const az of [0, 90, 180, 270]) {
        const m = computeShadowMask(g, el, az, 200);
        const px = new Uint8Array(SIZE * SIZE);
        for (let i = 0; i < m.length; i++) px[i] = m[i] ? 255 : 0; // contract: 255 = shadow, 0 = lit, 128 = no data
        const path = `moon/${d.id}_sh_el${el}_az${String(az).padStart(3, '0')}.png`;
        write(path, encodePng(px, SIZE, SIZE, 1));
        masks.push({ el, az, path });
      }
    }
    const m = allMetrics(g, sun.el_min, sun.el_max);
    regionMetrics.set(d.id, m);
    regions.push({
      id: d.id,
      name: d.name,
      lat: d.lat,
      lon: d.lon,
      x_m: round(x, 0),
      y_m: round(y, 0),
      coord_quality: d.q,
      coord_source:
        d.q === 'pgda_site_tile'
          ? 'PGDA product 78 ROI shapefile (mock centroid)'
          : 'Approximate, traced from NASA map in the 28 Oct 2024 Artemis III region release (mock)',
      sun,
      tile: {
        path: `moon/${d.id}.bin`,
        size: SIZE,
        res_m: RES,
        crs: '+proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +R=1737400 +units=m',
        origin_x: round(x - (SIZE * RES) / 2, 0),
        origin_y: round(y + (SIZE * RES) / 2, 0),
      },
      hillshade: `moon/${d.id}_hill.png`,
      shadow_masks: masks,
      shadow_mask_note: 'PNG 255 = cast shadow, 0 = lit, 128 = no data; az clockwise from grid +y (tile up)',
      hazards: {
        shadow: { score: 0, level: 'low', metrics: Object.fromEntries(HAZARD_METRICS.shadow.map((k: string): [string, number] => [k, m[k]])) },
        rim: { score: 0, level: 'low', metrics: Object.fromEntries(HAZARD_METRICS.rim.map((k: string): [string, number] => [k, m[k]])) },
        texture: { score: 0, level: 'low', metrics: Object.fromEntries(HAZARD_METRICS.texture.map((k: string): [string, number] => [k, m[k]])) },
        slope: {
          metrics: {
            slope_p50_deg: m.slope_p50_deg,
            slope_p90_deg: m.slope_p90_deg,
            rms_dev_m: { '60': m.rms_dev_m_60, '120': m.rms_dev_m_120, '240': m.rms_dev_m_240, '480': m.rms_dev_m_480, '960': m.rms_dev_m_960 },
          },
        },
      },
      uncertainty: { dem_err_p50_m: round(1.5 + idx * 0.3, 1), notes: 'Mock value. Real value comes from the LOLA _ERR companion raster.' },
    });
    console.log(`moon ${d.id} done (${Date.now() - t0} ms)`);
  });

  // Hazard scores: min-max across regions of the mean normalised metric (texture: fewer keypoints = harder).
  for (const hz of ['shadow', 'rim', 'texture'] as HazardId[]) {
    const raw = regions.map((r: Region): number => {
      const ms = regionMetrics.get(r.id) as Metrics;
      if (hz === 'texture') return ms.empty_cell_frac_el3 - ms.fast_per_km2_el3 / 50;
      return HAZARD_METRICS[hz].reduce((a: number, k: string): number => a + ms[k], 0);
    });
    const lo = Math.min(...raw);
    const hi = Math.max(...raw);
    regions.forEach((r: Region, i: number): void => {
      const s = hi > lo ? (raw[i] - lo) / (hi - lo) : 0.5;
      r.hazards[hz].score = round(s);
      r.hazards[hz].level = s > 0.66 ? 'high' : s > 0.33 ? 'med' : 'low';
    });
  }
  write('regions.json', JSON.stringify({ meta: META('regions'), regions }, null, 1));

  // ---- Overview hillshade (synthetic south-pole backdrop) ----
  {
    const OV = 600;
    const ext = 360000; // ±180 km around the pole
    const n1 = makeNoise(77, 64);
    const rnd = mulberry32(78);
    const big: { x: number; y: number; R: number }[] = [];
    for (let i = 0; i < 160; i++) big.push({ x: (rnd() - 0.5) * ext, y: (rnd() - 0.5) * ext, R: 2000 + 30000 * rnd() ** 3 });
    const ov = new Float32Array(OV * OV);
    for (let r = 0; r < OV; r++) {
      for (let c = 0; c < OV; c++) {
        const x = (c / OV - 0.5) * ext;
        const y = (0.5 - r / OV) * ext;
        let h = 600 * n1(((x + ext) / 30000) % 64, ((y + ext) / 30000) % 64) + 250 * n1(((x + ext) / 9000) % 64, ((y + ext) / 9000) % 64);
        for (const k of big) {
          const d = Math.hypot(x - k.x, y - k.y);
          if (d < k.R * 4) h += craterProfile(d, k.R) * 0.6;
        }
        ov[r * OV + c] = h;
      }
    }
    const g: Grid = { data: ov, size: OV, res: ext / OV };
    write('moon/overview_hill.png', encodePng(hillshade(g, 315, 20, 3), OV, OV, 1));
    write(
      'overview.json',
      JSON.stringify({ hillshade: 'moon/overview_hill.png', extent_m: [-ext / 2, ext / 2, -ext / 2, ext / 2], note: 'MOCK synthetic backdrop' }),
    );
  }

  // ---- Earth sites ----
  const siteGrids = new Map<string, Grid>();
  const siteMetrics = new Map<string, Metrics>();
  const sites: EarthSite[] = [];
  SITES.forEach((d: SiteDef, idx: number): void => {
    const id = `EP${String(idx + 1).padStart(3, '0')}`;
    const data = synthTerrain({ ...d.t, seed: 5000 + idx * 31, base: d.base });
    const g: Grid = { data, size: SIZE, res: RES };
    siteGrids.set(id, g);
    write(`earth/${id}.bin`, new Uint8Array(data.buffer));
    write(`earth/${id}_hill.png`, encodePng(hillshade(g, 315, 25, 1), SIZE, SIZE, 1));
    const m = allMetrics(g, 0, 8);
    siteMetrics.set(id, m);
    const zone = Math.floor((d.lon + 180) / 6) + 1;
    sites.push({
      id,
      name: d.name,
      country: d.country,
      lat: d.lat,
      lon: d.lon,
      category: d.category,
      known_analog: d.role === 'heldout_positive',
      role: d.role,
      bare_frac: d.bare,
      worldcover_note: d.bare > 0.6 ? 'Mostly class 60 (bare / sparse vegetation)' : 'Significant tree or crop cover in the surface model',
      rock: { lith: d.lith, anorthosite: d.anor === true, source: 'macrostrat' },
      tile: {
        path: `earth/${id}.bin`,
        size: SIZE,
        res_m: RES,
        crs: `EPSG:32${d.lat >= 0 ? '6' : '7'}${String(zone).padStart(2, '0')}`,
        origin_x: 492500,
        origin_y: round(Math.abs(d.lat) * 110946 + (d.lat < 0 ? 10000000 - 2 * Math.abs(d.lat) * 110946 : 0) + 7500, 0),
      },
      hillshade: `earth/${id}_hill.png`,
      metrics: m,
      image_tile_url: null,
      citations: [{ claim: 'MOCK: the pipeline supplies verified citations for this site', url: '' }],
    });
  });
  write('earth_sites.json', JSON.stringify({ meta: META('earth_sites'), sites }, null, 1));
  console.log(`earth done (${Date.now() - t0} ms)`);

  // ---- Matches ----
  const LABEL: Record<string, string> = {
    shadow_frac_el1: 'Shadow at 1° sun',
    shadow_frac_el3: 'Shadow at 3° sun',
    shadow_frac_el5: 'Shadow at 5° sun',
    shadow_frac_timeweighted: 'Shadow, time-weighted',
    jump1km_p95_m: 'Height jump over 1 km (P95)',
    jump1km_p99_m: 'Height jump over 1 km (P99)',
    frac_track_over_500m: 'Track with >500 m jumps',
    fast_per_km2_el3: 'Camera keypoints per km²',
    empty_cell_frac_el3: 'Featureless 1 km cells',
  };
  const gapText = (k: string, moon: number, earth: number): string => {
    const diff = earth - moon;
    const more = diff >= 0 ? 'more' : 'less';
    if (k.startsWith('shadow_frac')) return `${Math.abs(diff * 100).toFixed(0)} pts ${more} shadow`;
    if (k === 'frac_track_over_500m') return `${Math.abs(diff * 100).toFixed(1)} pts ${more} track over 500 m`;
    if (k.startsWith('jump1km')) return `${Math.abs(diff).toFixed(0)} m ${diff >= 0 ? 'bigger' : 'smaller'} jumps`;
    if (k === 'fast_per_km2_el3') return `${Math.abs(diff).toFixed(1)} ${diff >= 0 ? 'more' : 'fewer'} keypoints/km²`;
    if (k === 'empty_cell_frac_el3') return `${Math.abs(diff * 100).toFixed(0)} pts ${more} featureless cells`;
    return `${diff.toFixed(2)}`;
  };
  const CANNOT_BASE = ['1/6 g gravity', 'hard vacuum', '−200 °C night', 'Earth skylight fills shadows'];
  const CANNOT_EXTRA: Record<HazardId, string[]> = {
    shadow: ['low sun lasts minutes on Earth, days on the Moon'],
    rim: ['vegetation in the surface model can hide small cliffs'],
    texture: ['boulders smaller than 30 m are invisible at this resolution'],
  };

  const windowsCache = new Map<string, RehearsalWindow[]>();
  const findWindows = (site: EarthSite, target: number): RehearsalWindow[] => {
    const key = `${site.id}:${target}`;
    const cached = windowsCache.get(key);
    if (cached) return cached;
    const out: RehearsalWindow[] = [];
    const start = Date.UTC(2026, 10, 15, 0, 0, 0);
    const step = 4 * 60000;
    let open: { s: number; els: number[]; azs: number[] } | null = null;
    let lastDay = -1;
    for (let t = start; t < start + 150 * 86400000 && out.length < 3; t += step) {
      const p = sunPosition(new Date(t), site.lat, site.lon);
      const app = p.el + refractionDeg(p.el);
      const inside = Math.abs(app - target) <= 0.5;
      if (inside && !open) open = { s: t, els: [app], azs: [p.az] };
      else if (inside && open) {
        open.els.push(app);
        open.azs.push(p.az);
      } else if (!inside && open) {
        const day = Math.floor(open.s / 86400000);
        // keep at most one window per 5 days so the list spans different dates
        if (day - lastDay >= 5 && open.els.length >= 2) {
          const mid = Math.floor(open.els.length / 2);
          out.push({
            start_utc: new Date(open.s).toISOString().replace('.000Z', 'Z'),
            end_utc: new Date(t).toISOString().replace('.000Z', 'Z'),
            sun_el: round(open.els[mid], 2),
            sun_az: round(open.azs[mid], 1),
            el_kind: 'apparent (refraction applied)',
          });
          lastDay = day;
        }
        open = null;
      }
    }
    windowsCache.set(key, out);
    return out;
  };

  const eligible = sites.filter((s: EarthSite): boolean => s.bare_frac >= 0.3);
  const matches: Match[] = [];
  const bestDist = new Map<string, Record<HazardId, number>>();
  for (const r of regions) {
    const mm = regionMetrics.get(r.id) as Metrics;
    const best: Record<HazardId, number> = { shadow: 0, rim: 0, texture: 0 };
    for (const hz of ['shadow', 'rim', 'texture'] as HazardId[]) {
      const keys = HAZARD_METRICS[hz];
      const scored = eligible.map((s: EarthSite): { s: EarthSite; d: number; per: number[] } => {
        const em = siteMetrics.get(s.id) as Metrics;
        const per = keys.map((k: string): number => {
          const iqr = Math.max(Math.abs(mm[k]) * 0.4, k.startsWith('shadow') || k.includes('frac') ? 0.04 : k.startsWith('jump') ? 30 : 1);
          return Math.abs(em[k] - mm[k]) / iqr;
        });
        return { s, d: per.reduce((a: number, b: number): number => a + b, 0) / per.length, per };
      });
      scored.sort((a: { d: number }, b: { d: number }): number => a.d - b.d);
      best[hz] = round(scored[0].d);
      scored.slice(0, 3).forEach((sc: { s: EarthSite; d: number; per: number[] }, rank: number): void => {
        const em = siteMetrics.get(sc.s.id) as Metrics;
        const lights: LightRow[] = keys.map((k: string, i: number): LightRow => {
          const half = Math.max(Math.abs(mm[k]) * 0.2, 0.01);
          return {
            metric: k,
            moon: mm[k],
            moon_iqr: [round(mm[k] - half), round(mm[k] + half)],
            earth: em[k],
            gap_text: gapText(k, mm[k], em[k]),
            light: sc.per[i] < 0.5 ? 'green' : sc.per[i] < 1.5 ? 'amber' : 'red',
          };
        });
        const target = Math.min(6, Math.max(1, Math.round((r.sun.el_min + r.sun.el_max) / 2)));
        matches.push({
          region_id: r.id,
          hazard: hz,
          rank: rank + 1,
          site_id: sc.s.id,
          distance: round(sc.d),
          lights,
          matches_text: lights.filter((l: LightRow): boolean => l.light === 'green').map((l: LightRow): string => `${LABEL[l.metric]} is close to the Moon region (${l.gap_text})`),
          mismatches_text: lights.filter((l: LightRow): boolean => l.light !== 'green').map((l: LightRow): string => `${LABEL[l.metric]}: ${l.gap_text} than the Moon region`),
          cannot_test: [...CANNOT_BASE, ...CANNOT_EXTRA[hz]],
          windows: findWindows(sc.s, target),
        });
      });
    }
    bestDist.set(r.id, best);
  }
  write('matches.json', JSON.stringify({ meta: META('matches'), matches }, null, 1));
  console.log(`matches done: ${matches.length} (${Date.now() - t0} ms)`);

  // ---- Summary ----
  const rows: RankingRow[] = regions.map((r: Region): RankingRow => {
    const b = bestDist.get(r.id) as Record<HazardId, number>;
    const mean = (b.shadow + b.rim + b.texture) / 3;
    const worst = (Object.entries(b) as [HazardId, number][]).sort((x: [HazardId, number], y: [HazardId, number]): number => y[1] - x[1])[0];
    const nice: Record<HazardId, string> = { shadow: 'low-sun shadows', rim: 'crater-rim height jumps', texture: 'featureless terrain for cameras' };
    return {
      region_id: r.id,
      rank: 0,
      rehearsability: round(1 / (1 + mean)),
      per_hazard_best_distance: b,
      reason:
        worst[1] < 0.6
          ? `All three hazards have a close Earth match; ${nice[worst[0]]} is the weakest.`
          : `Hardest part to reproduce on Earth: ${nice[worst[0]]} (best match is ${worst[1].toFixed(1)} IQRs away).`,
    };
  });
  rows.sort((a: RankingRow, b: RankingRow): number => b.rehearsability - a.rehearsability);
  rows.forEach((r: RankingRow, i: number): void => {
    r.rank = i + 1;
  });
  write(
    'summary.json',
    JSON.stringify(
      {
        meta: META('summary'),
        ranking: rows,
        validation: {
          shadow_vs_pgda: { pearson_r: 0.87, mae: 0.061, bias: -0.018, n_px: 412000, note: 'MOCK. Real value compares our 1-3° shadow fraction against PGDA AVGVISIB (product 69).' },
          known_vs_decoy_auc: 0.86,
          weight_stability_jaccard: 0.78,
          classifier_two_sample: {
            per_region_auc: Object.fromEntries(regions.map((r: Region, i: number): [string, number] => [r.id, round(0.71 + ((i * 37) % 23) / 100, 2)])),
            top_features: ['rms_dev_m_960', 'shadow_frac_el1', 'fast_per_km2_el3', 'slope_p90_deg'],
          },
          synthetic_tests: [
            { name: 'flat_plane_zero_shadow', passed: true },
            { name: 'tilted_plane_flip_elevation', passed: true },
            { name: 'cylindrical_pit_analytic_area', passed: true },
            { name: 'dtw_identity_zero_cost', passed: true },
          ],
          where_it_fails: [
            'Boulders smaller than one 30 m pixel are invisible to every metric.',
            'Earth skylight fills shadows; lunar shadows are black.',
            'Copernicus GLO-30 is a surface model: trees and buildings add false texture.',
            'Low sun lasts minutes on Earth versus days on the Moon.',
            'Camera-navigation metric is a proxy for high-altitude terrain-relative navigation, not final descent.',
          ],
        },
      },
      null,
      1,
    ),
  );

  // ---- Walk transects ----
  const items: TransectItem[] = [];
  const profiles: number[][] = [];
  const rnd = mulberry32(4242);
  for (const s of sites) {
    const g = siteGrids.get(s.id) as Grid;
    for (let k = 0; k < 95; k++) {
      const lengths = [1000, 2000, 5000];
      const L = lengths[k % 3];
      const ang = (Math.floor(rnd() * 12) * Math.PI) / 6;
      const Lpx = L / RES;
      const dc = Math.cos(ang) * Lpx;
      const dr = Math.sin(ang) * Lpx;
      const margin = 2;
      const c0 = margin + rnd() * (SIZE - 2 * margin - Math.abs(dc)) + (dc < 0 ? -dc : 0);
      const r0 = margin + rnd() * (SIZE - 2 * margin - Math.abs(dr)) + (dr < 0 ? -dr : 0);
      const c1 = c0 + dc;
      const r1 = r0 + dr;
      const [x0, y0] = pixelToMap(c0, r0, s.tile.origin_x, s.tile.origin_y, RES);
      const [x1, y1] = pixelToMap(c1, r1, s.tile.origin_x, s.tile.origin_y, RES);
      const prof = sampleProfile(g, s.tile.origin_x, s.tile.origin_y, [[x0, y0], [x1, y1]], 100);
      if (!prof) continue;
      const mPerLon = 111320 * Math.cos((s.lat * Math.PI) / 180);
      const toLL = (c: number, r: number): [number, number] => [
        round(s.lat + ((SIZE / 2 - r) * RES) / 110540, 5),
        round(s.lon + ((c - SIZE / 2) * RES) / mPerLon, 5),
      ];
      const [lat0, lon0] = toLL(c0, r0);
      const [lat1, lon1] = toLL(c1, r1);
      items.push({
        i: items.length,
        site_id: s.id,
        x0: round(x0, 1),
        y0: round(y0, 1),
        x1: round(x1, 1),
        y1: round(y1, 1),
        lat0,
        lon0,
        lat1,
        lon1,
        length_m: L,
        climb_m: round(prof.climb_m, 1),
        max_slope_deg: round(prof.max_slope_deg, 2),
      });
      profiles.push(prof.slopes);
    }
  }
  const bin = new Float32Array(items.length * 100);
  profiles.forEach((p: number[], i: number): void => bin.set(p, i * 100));
  write('walk/transects.bin', new Uint8Array(bin.buffer));
  write('walk/transects.json', JSON.stringify({ meta: META('transects'), n: items.length, points: 100, items }));
  console.log(`transects: ${items.length} (${Date.now() - t0} ms)`);

  // ---- Presets ----
  const presets: PresetRoute[] = [];
  const prnd = mulberry32(99);
  for (const r of regions) {
    const g = moonGrids.get(r.id) as Grid;
    for (const name of ['Rim traverse', 'Plateau stroll']) {
      const pts: [number, number][] = [];
      let c = 40 + prnd() * (SIZE - 80);
      let rr = 40 + prnd() * (SIZE - 80);
      let ang = prnd() * Math.PI * 2;
      pts.push([c, rr]);
      for (let k = 0; k < 3; k++) {
        ang += (prnd() - 0.5) * 1.4;
        const seg = (name === 'Rim traverse' ? 900 : 600) / RES + prnd() * 8;
        c = Math.min(SIZE - 5, Math.max(5, c + Math.cos(ang) * seg));
        rr = Math.min(SIZE - 5, Math.max(5, rr + Math.sin(ang) * seg));
        pts.push([c, rr]);
      }
      const moonXY = pts.map(([pc, pr]: [number, number]): [number, number] => {
        const [mx, my] = pixelToMap(pc, pr, r.tile.origin_x, r.tile.origin_y, RES);
        return [round(mx, 1), round(my, 1)];
      });
      const prof = sampleProfile(g, r.tile.origin_x, r.tile.origin_y, moonXY, 100);
      if (!prof) continue;
      const scored = profiles.map((p: number[], i: number): PresetBest => ({ i, dtw: dtwBanded(prof.slopes, p, 0.1) }));
      scored.sort((a: PresetBest, b: PresetBest): number => a.dtw - b.dtw);
      presets.push({
        region_id: r.id,
        name,
        moon_xy: moonXY,
        best: scored.slice(0, 5).map((b: PresetBest): PresetBest => ({ i: b.i, dtw: round(b.dtw) })),
      });
    }
  }
  write('walk/presets.json', JSON.stringify(presets, null, 1));
  // sanity: the route sampler must agree with the stored tile
  const check = sampleBilinear(moonGrids.get('haworth') as Grid, 10.5, 10.5);
  console.log(`presets: ${presets.length}; sample check ${check.toFixed(1)}; total ${Date.now() - t0} ms`);
}

interface PresetBest {
  i: number;
  dtw: number;
}

main();
