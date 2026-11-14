// Generates MOCK web/public/mock/method.json per docs/data-contract.md ("How we find analogs" explainer).
// Run: `node scripts/gen-mock-method.ts` (also part of `npm run mock`). Every value here is synthetic.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MethodFile, MethodFunnelRow, MethodPoint, MethodValSite } from '../src/types/contract.ts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'mock', 'method.json');

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

const rand = mulberry32(20261114);

/** [latMin, latMax, lonMin, lonMax, relative weight, probability a square is bare enough to keep] */
type Box = [number, number, number, number, number, number];

const BOXES: Box[] = [
  // mostly bare: deserts, high plateaus, polar desert, lava fields
  [15, 32, -15, 32, 9, 0.85],
  [15, 30, 38, 56, 4, 0.85],
  [27, 37, 52, 68, 3, 0.75],
  [38, 47, 58, 110, 5, 0.6],
  [29, 36, 78, 95, 3, 0.7],
  [37, 41, 77, 88, 1.5, 0.85],
  [-28, -18, -71, -67, 1, 0.9],
  [-50, -40, -71, -66, 1.2, 0.5],
  [-30, -20, 120, 142, 4, 0.75],
  [-28, -17, 13, 22, 1.5, 0.7],
  [31, 40, -118, -106, 2, 0.65],
  [26, 31, -114, -108, 0.8, 0.7],
  [63.5, 66, -22, -14, 0.5, 0.6],
  [68, 78, -110, -75, 2, 0.5],
  [-23, -15, -69, -66, 0.8, 0.8],
  [5, 14, 40, 50, 1, 0.55],
  // mostly not: forest, farmland, cities, ice
  [-10, 2, -70, -50, 3, 0.04],
  [-5, 5, 12, 28, 2, 0.04],
  [43, 55, -2, 25, 3, 0.1],
  [33, 45, -90, -75, 2, 0.05],
  [15, 28, 72, 86, 2, 0.1],
  [22, 35, 105, 120, 2, 0.05],
  [55, 65, 60, 120, 3, 0.06],
  [65, 80, -50, -25, 1.5, 0.02],
  [50, 60, -120, -70, 2.5, 0.06],
  [-38, -30, -64, -58, 1, 0.1],
  [7, 13, -10, 10, 1.5, 0.2],
  [45, 55, 40, 80, 2.5, 0.3],
];

const N = 4773;
const totalW = BOXES.reduce((a: number, b: Box): number => a + b[4], 0);
const r2 = (v: number): number => Math.round(v * 100) / 100;

const points: MethodPoint[] = [];
for (let i = 0; i < N; i++) {
  let pick = rand() * totalW;
  let box = BOXES[0];
  for (const b of BOXES) {
    pick -= b[4];
    if (pick <= 0) {
      box = b;
      break;
    }
  }
  const lat = box[0] + rand() * (box[1] - box[0]);
  const lon = box[2] + rand() * (box[3] - box[2]);
  const pass = rand() < box[5];
  points.push({ lat: r2(lat), lon: r2(lon), pass, stage: 'screened', best_dist: Math.round((0.2 + rand() * 3.5) * 1000) / 1000 });
}
// Shortlist and final picks come from the kept squares with the smallest distances.
const kept = points
  .filter((p: MethodPoint): boolean => p.pass)
  .sort((a: MethodPoint, b: MethodPoint): number => (a.best_dist ?? 9) - (b.best_dist ?? 9));
kept.slice(0, 600).forEach((p: MethodPoint): void => {
  p.stage = 'shortlist';
});
kept.slice(0, 81).forEach((p: MethodPoint): void => {
  p.stage = 'final';
});

const known: MethodValSite[] = [
  ['EP001', 'Haughton crater, Devon Island', 0.4, true],
  ['EP002', 'Meteor Crater, Arizona', 1.1, true],
  ['EP003', 'Black Point lava flow, Arizona', 2.6, true],
  ['EP004', 'Craters of the Moon, Idaho', 3.9, true],
  ['EP005', 'Lanzarote, Canary Islands', 4.4, true],
  ['EP006', 'Krafla, Iceland', 5.0, true],
  ['EP007', 'Kilbourne Hole, New Mexico', 6.8, true],
  ['EP008', 'Atacama, Chile', 8.9, true],
  ['EP009', 'Mistastin Lake, Labrador', 14.5, true],
  ['EP010', 'Mauna Kea saddle, Hawaii', 21.0, true],
  ['EP011', 'Ries crater, Germany', 47.0, false],
  ['EP012', 'Sudbury basin, Ontario', 63.0, false],
].map(([id, name, pct, safe]): MethodValSite => ({
  id: String(id),
  name: String(name),
  best_rank_pct: Number(pct),
  dsm_safe: Boolean(safe),
}));

const decoys: MethodValSite[] = [
  ['EP115', 'Iowa farmland', 71],
  ['EP116', 'Amazon forest', 88],
  ['EP117', 'Paris suburbs', 93],
  ['EP118', 'Sahara dune sea', 34],
  ['EP119', 'Bavarian forest', 66],
  ['EP120', 'Ganges plain', 81],
  ['EP121', 'Pampas farmland', 55],
  ['EP122', 'Boreal forest, Quebec', 59],
  ['EP123', 'Rice terraces, Yunnan', 42],
  ['EP124', 'Netherlands polders', 97],
].map(([id, name, pct]): MethodValSite => ({ id: String(id), name: String(name), best_rank_pct: Number(pct) }));

function median(v: number[]): number {
  const s = [...v].sort((a: number, b: number): number => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** AUC: probability a known analog ranks better (lower percentile) than a decoy. */
function auc(k: number[], d: number[]): number {
  let wins = 0;
  for (const a of k) for (const b of d) wins += a < b ? 1 : a === b ? 0.5 : 0;
  return wins / (k.length * d.length);
}

const kp = known.map((k: MethodValSite): number => k.best_rank_pct);
const dp = decoys.map((d: MethodValSite): number => d.best_rank_pct);

const funnel: MethodFunnelRow[] = [
  { stage: 'sampled', n: N, known_pass: known.length, decoy_pass: decoys.length },
  { stage: 'dsm_safe', n: kept.length, known_pass: 10, decoy_pass: 4 },
  { stage: 'stage1_top', n: 600, known_pass: 9, decoy_pass: 1 },
  { stage: 'stage2', n: 150, known_pass: 8, decoy_pass: 0 },
  { stage: 'final_top3', n: 81, known_pass: 6, decoy_pass: 0 },
];

const file: MethodFile = {
  meta: {
    generated_utc: new Date('2026-11-14T00:00:00Z').toISOString(),
    pipeline_version: 'mock-0.1',
    sources: [
      {
        name: 'MOCK DATA - synthetic, not real measurements',
        url: '',
        licence: 'n/a',
        citation: 'Generated by web/scripts/gen-mock-method.ts',
      },
    ],
  },
  screen: {
    n_draws: 314104,
    n_land: 88003,
    n_pool: 30000,
    n_screened: N,
    coverage_km2: 1070000,
    coverage_pct_bare: 5.8,
    seed: 0,
    strata: ['60–90°S', '30–60°S', '0–30°S', '0–30°N', '30–60°N', '60–90°N'].flatMap((band: string) =>
      ['low', 'mid', 'high'].map((relief: string) => ({ lat_band: band, relief_class: relief, n: 0 })),
    ),
  },
  funnel,
  validation: {
    known_median_pct: median(kp),
    decoy_median_pct: median(dp),
    auc: Math.round(auc(kp, dp) * 100) / 100,
    known,
    decoys,
  },
  points,
  example: {
    region_id: 'malapert_massif',
    hazard: 'rim',
    site_id: 'EP002',
    moon: { jump1km_p95_m: 440.1, jump1km_p99_m: 498.6, frac_track_over_500m: 0.0021 },
    earth: { jump1km_p95_m: 395.4, jump1km_p99_m: 471.0, frac_track_over_500m: 0.0012 },
  },
};
// Fill the strata counts from the points so the numbers agree.
for (const s of file.screen.strata) {
  const [lo, hi] = s.lat_band.replace(/°[NS]/, '').split('–').map(Number);
  const south = s.lat_band.endsWith('S');
  const inBand = points.filter((p: MethodPoint): boolean => {
    const lat = south ? -p.lat : p.lat;
    return lat >= lo && lat < hi;
  });
  s.n = Math.round(inBand.length / 3);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(file));
console.log(`wrote ${OUT}: ${points.length} points, ${kept.length} kept, AUC ${file.validation.auc}`);
