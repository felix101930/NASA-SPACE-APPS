// Dev check (not shipped): the browser's height + slope matcher should rank walks like
// pipeline/walkval/matchers.py. Prints, for a few distorted copies of library rows, where the true row
// ranks and the distances to the first rows, so they can be compared against the Python matcher.
// Run: node scripts/check-matcher.ts [out.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { heightsFromSlopes, heightSlopeDistance, libraryScale } from '../src/lib/match.ts';

interface Item {
  i: number;
  length_m: number;
}

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'walk');
const meta: { n: number; points: number; items: Item[] } = JSON.parse(readFileSync(join(DATA, 'transects.json'), 'utf8'));
const buf = readFileSync(join(DATA, 'transects.bin'));
const rows = new Float32Array(buf.buffer, buf.byteOffset, meta.n * meta.points);
const P = meta.points;
const N = meta.n;
const lengths = new Float64Array(N);
meta.items.forEach((it: Item): void => {
  lengths[it.i] = it.length_m;
});
const heights = new Float32Array(N * P);
const tmp = new Float64Array(P);
for (let i = 0; i < N; i++) heights.set(heightsFromSlopes(rows.subarray(i * P, (i + 1) * P), lengths[i], tmp), i * P);
const scale = libraryScale(rows, heights);

let seed = 7;
const rand = (): number => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

const out: {
  scale: typeof scale;
  cases: { row: number; reversed: boolean; query: number[]; lengthM: number; rank: number; d_first: number[] }[];
} = {
  scale,
  cases: [],
};
let top1 = 0;
const CASES = 40;
for (let c = 0; c < CASES; c++) {
  const row = Math.floor(rand() * N);
  const reversed = c % 2 === 1;
  const base = Array.from(rows.subarray(row * P, (row + 1) * P));
  const noisy = base.map((v: number): number => v + (rand() - 0.5) * 1.0);
  const query = reversed ? noisy.reverse().map((v: number): number => -v) : noisy;
  const qh = heightsFromSlopes(query, lengths[row]);
  const d = new Float64Array(N);
  for (let i = 0; i < N; i++)
    d[i] = heightSlopeDistance(qh, query, heights.subarray(i * P, (i + 1) * P), rows.subarray(i * P, (i + 1) * P), scale).d;
  let rank = 1;
  for (let i = 0; i < N; i++) if (i !== row && d[i] <= d[row]) rank++;
  if (rank === 1) top1++;
  out.cases.push({ row, reversed, query, lengthM: lengths[row], rank, d_first: Array.from(d.subarray(0, 50)) });
}
console.log(
  `scale: sd_height ${scale.sdHeight.toFixed(4)} m, sd_slope ${scale.sdSlope.toFixed(4)}°; true row ranked first in ${top1}/${CASES}`,
);
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(out));
