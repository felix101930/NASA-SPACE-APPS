import { fillNaN, type Grid, type Stats } from '../lib/terrain';
import { isObj, type TileRef } from '../types/contract';
import { loadBytesFrom, loadFloat32, loadJsonFrom, type Loaded, type Origin } from './loader';

export interface LoadedTile {
  /** Raw grid (NaN = no data), for profile sampling that must match the pipeline. */
  raw: Grid;
  /** NaN-filled grid for rendering and shadow casting. */
  filled: Grid;
  stats: Stats;
  nanCount: number;
  /**
   * The tile as actually loaded: `path` is the requested one (identity), but `size`, `res_m` and the origin are
   * those of the grid in hand. Consumers must use these (or raw/filled .size/.res), never the site's JSON ref,
   * because a deploy without the full Earth tiles serves a 250 × 250 / 60 m lite copy instead.
   */
  ref: TileRef;
  /** True when this is the lite (60 m, Int16) copy from earth_lite/ rather than the full 30 m tile. */
  lite: boolean;
}

// ------------------------------------------------------------------------------------------------
// Lite Earth tiles (pipeline.publish_lite): committed so a static deploy without data/earth/ still has terrain
// ------------------------------------------------------------------------------------------------

interface LiteEntry {
  size: number;
  res_m: number;
  origin_x: number;
  origin_y: number;
  crs: string;
  h_offset: number;
  h_scale: number;
  nodata_value: number;
  encoding: string;
}

interface LiteIndex {
  tiles: Record<string, LiteEntry>;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

function isLiteEntry(v: unknown): v is LiteEntry {
  return (
    isObj(v) &&
    isNum(v.size) &&
    isNum(v.res_m) &&
    isNum(v.origin_x) &&
    isNum(v.origin_y) &&
    isStr(v.crs) &&
    isNum(v.h_offset) &&
    isNum(v.h_scale) &&
    isNum(v.nodata_value) &&
    v.encoding === LITE_ENCODING
  );
}

function isLiteIndex(v: unknown): v is LiteIndex {
  return isObj(v) && isObj(v.tiles) && Object.values(v.tiles).every(isLiteEntry);
}

const LITE_DIR = 'earth_lite';
const LITE_EXT = '.i16z';
/** See pipeline/publish_lite.py: gzip of [low bytes, high bytes] of the wrapping 2D first difference of the Int16 grid. */
const LITE_ENCODING = 'delta2d-planes-gzip';

async function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(buf);
  // A host that sent the file with Content-Encoding: gzip has already inflated it; only inflate real gzip bytes.
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return buf;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/** Undoes the packing: byte planes -> Int16 differences -> wrapping 2D prefix sum (Int16Array stores wrap mod 2^16). */
function unpackLite(plain: ArrayBuffer, n: number): Int16Array | null {
  const nn = n * n;
  if (plain.byteLength !== nn * 2) return null;
  const b = new Uint8Array(plain);
  const v = new Int16Array(nn);
  for (let i = 0; i < nn; i++) v[i] = b[i] | (b[nn + i] << 8);
  for (let r = 1; r < n; r++) for (let c = 0; c < n; c++) v[r * n + c] += v[(r - 1) * n + c];
  for (let r = 0; r < n; r++) for (let c = 1; c < n; c++) v[r * n + c] += v[r * n + c - 1];
  return v;
}
const EARTH_TILE = /^earth\/([^/]+)\.bin$/;
let liteIndex: Promise<LiteIndex | null> | null = null;

function loadLiteIndex(): Promise<LiteIndex | null> {
  if (!liteIndex) {
    liteIndex = loadJsonFrom(`${LITE_DIR}/index.json`, isLiteIndex, 'data')
      .then((l: Loaded<LiteIndex> | null): LiteIndex | null => (l ? l.value : null))
      .catch((): null => null);
  }
  return liteIndex;
}

/** Lite copy of an Earth tile as Float32 heights (NaN = no data) plus its actual grid; null when unavailable. */
async function loadLite(ref: TileRef): Promise<{ data: Float32Array; ref: TileRef } | null> {
  const m = EARTH_TILE.exec(ref.path);
  if (!m) return null;
  const id = m[1];
  const entry = (await loadLiteIndex())?.tiles[id];
  if (!entry) return null;
  // Same corner origin as the full tile; a mismatch means the lite copy is from an older pipeline run.
  if (Math.abs(entry.origin_x - ref.origin_x) > 1 || Math.abs(entry.origin_y - ref.origin_y) > 1) {
    console.warn(`[data] ${LITE_DIR}/${id}: origin differs from earth_sites.json (stale lite tile); not using it.`);
    return null;
  }
  const n = entry.size;
  const buf = await loadBytesFrom(`${LITE_DIR}/${id}${LITE_EXT}`, null, 'data');
  if (!buf) return null;
  let q: Int16Array | null = null;
  try {
    q = unpackLite(await gunzip(buf), n);
  } catch {
    q = null;
  }
  if (!q) {
    console.warn(`[data] ${LITE_DIR}/${id}${LITE_EXT}: could not be decoded; not using it.`);
    return null;
  }
  const data = new Float32Array(n * n);
  for (let i = 0; i < q.length; i++) data[i] = q[i] === entry.nodata_value ? NaN : q[i] * entry.h_scale + entry.h_offset;
  return {
    data,
    ref: { ...ref, size: n, res_m: entry.res_m, origin_x: entry.origin_x, origin_y: entry.origin_y, crs: entry.crs },
  };
}

// ------------------------------------------------------------------------------------------------

function build(data: Float32Array, ref: TileRef, lite: boolean): LoadedTile {
  const { filled, stats, nanCount } = fillNaN(data);
  return {
    raw: { data, size: ref.size, res: ref.res_m },
    filled: { data: filled, size: ref.size, res: ref.res_m },
    stats,
    nanCount,
    ref,
    lite,
  };
}

/**
 * Order for Earth tiles with real data preferred: full tile in data/ -> lite copy in data/earth_lite/ -> mock/.
 * Everything else (Moon, Alberta, mock-first) keeps the plain data/mock fallback.
 */
async function loadAny(ref: TileRef, prefer: Origin): Promise<LoadedTile> {
  if (prefer === 'data' && EARTH_TILE.test(ref.path)) {
    const full = await loadBytesFrom(ref.path, ref.size * ref.size * 4, 'data');
    if (full) return build(new Float32Array(full), ref, false);
    const lite = await loadLite(ref);
    if (lite) return build(lite.data, lite.ref, true);
  }
  const l: Loaded<Float32Array> = await loadFloat32(ref.path, ref.size * ref.size, prefer);
  return build(l.value, ref, false);
}

const cache = new Map<string, Promise<LoadedTile>>();

export function loadTile(ref: TileRef, prefer: Origin): Promise<LoadedTile> {
  // Real and sample tiles can share a path, so the cache key includes the preferred origin.
  const key = `${prefer}:${ref.path}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = loadAny(ref, prefer);
  cache.set(key, p);
  p.catch((): void => {
    cache.delete(key);
  });
  return p;
}
