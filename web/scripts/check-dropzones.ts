// Dev check (not shipped): the browser's "big drop zones" computation (src/lib/dropZones.ts, the same code the worker
// runs) should reproduce pipeline/metrics/rim.py. For a Moon region and its rank-1 rim match on Earth it prints the
// pooled P95 vs matches.json lights jump1km_p95_m, the runtime, the field P99 (shared colour scale) and the top-3
// segments (Moon segments are compared with the pipeline's annotations rim_drops).
// Run: node scripts/check-dropzones.ts [region_id]     (default cabeus_b_peak)
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeDropZones, type DropSegment, type DropZoneResult } from '../src/lib/dropZones.ts';

interface Light {
  metric: string;
  moon: number;
  earth: number;
}
interface Match {
  region_id: string;
  hazard: string;
  rank: number;
  site_id: string;
  lights: Light[];
}
interface Drop {
  rank: number;
  start: { px: [number, number] };
  end: { px: [number, number] };
  abs_dh_m: number;
}

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');
const region = process.argv[2] ?? 'cabeus_b_peak';
const matches: Match[] = JSON.parse(readFileSync(join(DATA, 'matches.json'), 'utf8')).matches;
const m = matches.find((x: Match): boolean => x.region_id === region && x.hazard === 'rim' && x.rank === 1);
if (!m) throw new Error(`no rank-1 rim match for ${region}`);
const light = m.lights.find((l: Light): boolean => l.metric === 'jump1km_p95_m');
if (!light) throw new Error('no jump1km_p95_m light');

function loadTile(path: string, size: number): Float32Array {
  const buf = readFileSync(path);
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + size * size * 4));
}

const fmtSeg = (s: DropSegment): string =>
  `#${s.rank} ${s.absDh.toFixed(1)} m  (${s.start[0].toFixed(1)}, ${s.start[1].toFixed(1)}) -> (${s.end[0].toFixed(1)}, ${s.end[1].toFixed(1)})`;

function run(label: string, path: string, expected: number): DropZoneResult {
  const dem = loadTile(path, 500);
  computeDropZones(dem, 500, 30); // warm-up (JIT), as the worker is after its first tile
  const t0 = performance.now();
  const r = computeDropZones(dem, 500, 30);
  const ms = performance.now() - t0;
  const err = ((r.p95 - expected) / expected) * 100;
  let nan = 0;
  for (let i = 0; i < r.field.length; i++) if (!(r.field[i] === r.field[i])) nan++;
  console.log(`\n${label}: ${path.replace(DATA + '/', '')}`);
  console.log(`  P95 pooled pairs  ${r.p95.toFixed(2)} m   pipeline ${expected.toFixed(2)} m   diff ${err >= 0 ? '+' : ''}${err.toFixed(3)}%`);
  console.log(`  P99 pooled pairs  ${r.p99.toFixed(2)} m   field P99 ${r.fieldP99.toFixed(2)} m   samples ${r.samples}   field NaN ${nan}`);
  console.log(`  runtime ${ms.toFixed(0)} ms (warm), node ${process.version}`);
  r.top.forEach((s: DropSegment): void => console.log(`  ${fmtSeg(s)}`));
  return r;
}

const moon = run(`Moon ${region}`, join(DATA, 'moon', `${region}.bin`), light.moon);
const earth = run(`Earth ${m.site_id} (rim #1)`, join(DATA, 'earth', `${m.site_id}.bin`), light.earth);
console.log(`\nshared scaleMax = max(field P99) = ${Math.max(moon.fieldP99, earth.fieldP99).toFixed(1)} m`);

const annPath = join(DATA, 'moon', `${region}_annotations.json`);
if (existsSync(annPath)) {
  const drops: Drop[] | undefined = JSON.parse(readFileSync(annPath, 'utf8')).rim_drops?.drops;
  if (drops) {
    console.log('\nMoon top-3 vs annotations rim_drops (annotation px − 0.5 = pixel-centre coords):');
    drops.slice(0, 3).forEach((d: Drop, k: number): void => {
      const s = moon.top[k];
      const dStart = s ? Math.hypot(s.start[0] - (d.start.px[0] - 0.5), s.start[1] - (d.start.px[1] - 0.5)) : Number.NaN;
      console.log(`  #${d.rank} pipeline ${d.abs_dh_m.toFixed(1)} m   ours ${s ? s.absDh.toFixed(1) : '-'} m   start offset ${dStart.toFixed(2)} px`);
    });
  }
}
