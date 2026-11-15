// Data hooks and in-browser measurements for the 3D comparison screen.
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { assetUrl, loadImage, loadJsonFrom, type Loaded, type Origin } from '../../data/loader';
import { loadTile, type LoadedTile } from '../../data/tiles';
import { sampleBilinear, type Grid } from '../../lib/terrain';
import type { ShadowReply, ShadowRequest } from '../../workers/shadow.worker';
import type { ShadowMode } from '../../store';
import { isObj, type Region, type ShadowMask, type TileRef } from '../../types/contract';
import { isAnnotations, type Annotations, type RimDrop, type TextureCell } from '../../types/annotations';

// ------------------------------------------------------------------------------------------------
// Tiles and annotations
// ------------------------------------------------------------------------------------------------

export interface TileState {
  tile: LoadedTile | null;
  error: string | null;
}

export function useTile(ref: TileRef | null, origin: Origin): TileState {
  const [state, setState] = useState<TileState>({ tile: null, error: null });
  useEffect((): (() => void) | void => {
    if (!ref) return;
    let alive = true;
    setState({ tile: null, error: null });
    loadTile(ref, origin)
      .then((t: LoadedTile): void => {
        if (alive) setState({ tile: t, error: null });
      })
      .catch((e: unknown): void => {
        if (alive) setState({ tile: null, error: e instanceof Error ? e.message : String(e) });
      });
    return (): void => {
      alive = false;
    };
  }, [ref, origin]);
  return state;
}

/**
 * After an Earth tile fails to load, ask the server whether the site is still listed in earth_sites.json
 * (bypassing the HTTP cache). false = the files on disk changed since this page loaded its data (the site was
 * replaced by a newer pipeline run), so a reload fixes it; true = the site is listed but its tile is genuinely
 * missing; null = not checked / unknown.
 */
export function useSiteStillListed(siteId: string | null, failed: boolean, origin: Origin): boolean | null {
  const [listed, setListed] = useState<{ id: string; ok: boolean } | null>(null);
  useEffect((): (() => void) | void => {
    if (!siteId || !failed) return;
    let alive = true;
    fetch(assetUrl('earth_sites.json', origin), { cache: 'no-store' })
      .then((r: Response): Promise<unknown> => (r.ok ? r.json() : Promise.resolve(null)))
      .then((doc: unknown): void => {
        if (!alive || !isObj(doc) || !Array.isArray(doc.sites)) return;
        const ok = doc.sites.some((x: unknown): boolean => isObj(x) && x.id === siteId);
        setListed({ id: siteId, ok });
      })
      .catch((): void => undefined);
    return (): void => {
      alive = false;
    };
  }, [siteId, failed, origin]);
  return listed && listed.id === siteId && failed ? listed.ok : null;
}

const annCache = new Map<string, Promise<Annotations | null>>();

function loadAnnotations(regionId: string, origin: Origin): Promise<Annotations | null> {
  const key = `${origin}:${regionId}`;
  const hit = annCache.get(key);
  if (hit) return hit;
  const p = loadJsonFrom(`moon/${regionId}_annotations.json`, isAnnotations, origin)
    .then((l: Loaded<Annotations> | null): Annotations | null => (l ? l.value : null))
    .catch((): null => null);
  annCache.set(key, p);
  return p;
}

/** Per-region Moon overlays (rim drops, featureless cells). Null while loading or when the file is absent. */
export function useAnnotations(region: Region | null, origin: Origin): Annotations | null {
  const [ann, setAnn] = useState<Annotations | null>(null);
  useEffect((): (() => void) | void => {
    if (!region) return;
    let alive = true;
    setAnn(null);
    void loadAnnotations(region.id, origin).then((a: Annotations | null): void => {
      if (alive && a && a.region_id === region.id) setAnn(a);
    });
    return (): void => {
      alive = false;
    };
  }, [region, origin]);
  return ann;
}

// ------------------------------------------------------------------------------------------------
// Rim drops: the biggest height changes over 1 km
// ------------------------------------------------------------------------------------------------

/** A 1 km segment in pixel-index coordinates (pixel centre = integer), oriented from high end to low end. */
export interface RimSeg {
  rank: number;
  start: [number, number];
  end: [number, number];
  absDh: number;
}

export function moonRimSegs(ann: Annotations | null, count: number): RimSeg[] | null {
  const drops = ann?.rim_drops?.drops;
  if (!drops) return null;
  // Annotation px are continuous with pixel centres at +0.5; the mesh samples centres at integers.
  return drops.slice(0, count).map(
    (d: RimDrop): RimSeg => ({
      rank: d.rank,
      start: [d.start.px[0] - 0.5, d.start.px[1] - 0.5],
      end: [d.end.px[0] - 0.5, d.end.px[1] - 0.5],
      absDh: d.abs_dh_m,
    }),
  );
}

/**
 * Same definition as the pipeline's rim scan (pipeline.moon.annotations / rim.jump_samples):
 * dh = h(p + 1 km·u) − h(p) for every pixel and 16 directions over 180°, partner height bilinear;
 * greedy picks by |dh|, dropping candidates whose midpoint is within 1.5 km of an earlier pick.
 * Only the best direction per pixel is kept as a candidate; a second direction from the same pixel
 * always has its midpoint within 1 km of the first, so the separation rule would drop it anyway.
 */
export function findRimSegs(g: Grid, count: number, baselineM: number = 1000, minSepM: number = 1500): RimSeg[] {
  const n = g.size;
  const L = baselineM / g.res;
  const dirs: { dc: number; dr: number }[] = [];
  for (let k = 0; k < 16; k++) {
    const a = (k * Math.PI) / 16;
    dirs.push({ dc: Math.sin(a) * L, dr: -Math.cos(a) * L });
  }
  const best = new Float32Array(n * n);
  const bestDir = new Int8Array(n * n);
  const sign = new Int8Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      const h0 = g.data[i];
      if (!Number.isFinite(h0)) continue;
      let b = 0;
      let bd = -1;
      let bs = 0;
      for (let k = 0; k < 16; k++) {
        const cc = c + dirs[k].dc;
        const rr = r + dirs[k].dr;
        if (cc < 0 || rr < 0 || cc > n - 1 || rr > n - 1) continue;
        const dh = sampleBilinear(g, cc, rr) - h0;
        if (!Number.isFinite(dh)) continue;
        const a = Math.abs(dh);
        if (a > b) {
          b = a;
          bd = k;
          bs = dh > 0 ? 1 : -1;
        }
      }
      best[i] = b;
      bestDir[i] = bd;
      sign[i] = bs;
    }
  }
  const order: number[] = [];
  for (let i = 0; i < best.length; i++) if (bestDir[i] >= 0 && best[i] > 0) order.push(i);
  order.sort((a: number, b: number): number => best[b] - best[a]);
  const sepPx = minSepM / g.res;
  const picks: RimSeg[] = [];
  const mids: [number, number][] = [];
  for (const i of order) {
    if (picks.length >= count) break;
    const r = Math.floor(i / n);
    const c = i - r * n;
    const d = dirs[bestDir[i]];
    const pc = c + d.dc;
    const pr = r + d.dr;
    const mc = (c + pc) / 2;
    const mr = (r + pr) / 2;
    if (mids.some(([x, y]: [number, number]): boolean => Math.hypot(x - mc, y - mr) < sepPx)) continue;
    mids.push([mc, mr]);
    const self: [number, number] = [c, r];
    const partner: [number, number] = [pc, pr];
    // Orient from the high end to the low end, like the pipeline.
    const up = sign[i] > 0;
    picks.push({ rank: picks.length + 1, start: up ? partner : self, end: up ? self : partner, absDh: best[i] });
  }
  return picks;
}

/** Earth rim drops computed after the tile loads (deferred so the first frame is not blocked). */
export function useEarthRimSegs(tile: LoadedTile | null, enabled: boolean, count: number): RimSeg[] | null {
  const [segs, setSegs] = useState<{ tile: LoadedTile; segs: RimSeg[] } | null>(null);
  useEffect((): (() => void) | void => {
    if (!tile || !enabled) return;
    if (segs && segs.tile === tile) return;
    const t = window.setTimeout((): void => {
      setSegs({ tile, segs: findRimSegs(tile.raw, count) });
    }, 60);
    return (): void => window.clearTimeout(t);
  }, [tile, enabled, count, segs]);
  return segs && segs.tile === tile ? segs.segs : null;
}

// ------------------------------------------------------------------------------------------------
// Shadow share: same method on both worlds, true heights, computed in the browser
// ------------------------------------------------------------------------------------------------

const READOUT_RES_M = 90; // readout grid: 90 m steps on both worlds (3 × 3 blocks of a 30 m tile)

/**
 * Area-weighted resample to `resM` cells (each output cell = the overlap-weighted mean of the input pixels it
 * covers). For an integer factor (30 m -> 90 m) this is exactly the plain block mean; it also takes a 60 m lite Earth
 * tile to the same 90 m grid as the 30 m Moon tile, so the two dark percentages stay like for like.
 */
function resampleTo(g: Grid, resM: number): Grid {
  const f = resM / g.res;
  if (f <= 1) return g;
  const n = Math.floor(g.size / f + 1e-9);
  // Per output index: the input pixels it overlaps and the overlap weights (same for rows and columns).
  const spans: { i: number; w: number }[][] = [];
  for (let o = 0; o < n; o++) {
    const a = o * f;
    const b = a + f;
    const span: { i: number; w: number }[] = [];
    for (let i = Math.floor(a); i < Math.min(g.size, Math.ceil(b - 1e-9)); i++) {
      const w = Math.min(b, i + 1) - Math.max(a, i);
      if (w > 1e-9) span.push({ i, w });
    }
    spans.push(span);
  }
  const out = new Float32Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      let sum = 0;
      let wsum = 0;
      for (const ri of spans[r]) for (const ci of spans[c]) {
        const w = ri.w * ci.w;
        sum += g.data[ri.i * g.size + ci.i] * w;
        wsum += w;
      }
      out[r * n + c] = sum / wsum;
    }
  }
  return { data: out, size: n, res: resM };
}

export interface ShadowShare {
  el: number;
  az: number;
  frac: number;
}

// The ray marching runs in a worker (workers/shadow.worker.ts): inline it blocked the page for tens to hundreds of
// milliseconds per sun change. One job in flight per hook, the newest request wins, and at most 4 updates a second.

let shadowWorker: Worker | null = null;
let nextJob = 1;
let nextGridKey = 1;
const jobs = new Map<number, (r: ShadowReply) => void>();
const gridKeys = new WeakMap<Grid, number>();

function getShadowWorker(): Worker {
  if (shadowWorker) return shadowWorker;
  const w = new Worker(new URL('../../workers/shadow.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<ShadowReply>): void => {
    const cb = jobs.get(e.data.id);
    if (!cb) return;
    jobs.delete(e.data.id);
    cb(e.data);
  };
  shadowWorker = w;
  return w;
}

/** Runs one shadow job off the main thread. The grid is copied to the worker once per Grid object (again if the
 * worker has since dropped it: it keeps only the last few tiles). */
function shadowJob(g: Grid, type: 'frac' | 'mask', el: number, az: number, maxDist: number, done: (r: ShadowReply) => void): () => void {
  const w = getShadowWorker();
  let cancelled = false;
  let id = 0;
  const send = (retry: boolean): void => {
    let key = gridKeys.get(g);
    if (key === undefined) {
      key = nextGridKey++;
      gridKeys.set(g, key);
      const msg: ShadowRequest = { type: 'grid', key, data: g.data.slice(), size: g.size, res: g.res };
      w.postMessage(msg);
    }
    id = nextJob++;
    jobs.set(id, (r: ShadowReply): void => {
      if (cancelled) return;
      if (r.type === 'error' && retry) {
        gridKeys.delete(g);
        send(false);
        return;
      }
      done(r);
    });
    const req: ShadowRequest = { type, id, key, el, az, maxDist };
    w.postMessage(req);
  };
  send(true);
  return (): void => {
    cancelled = true;
    jobs.delete(id);
  };
}

const READOUT_MIN_MS = 250;

const readoutGrids = new WeakMap<LoadedTile, Grid>();

/** The 90 m readout grid for a tile, shared by the live readout and the per-date figures (so they agree exactly). */
function readoutGrid(tile: LoadedTile): Grid {
  let g = readoutGrids.get(tile);
  if (!g) {
    g = resampleTo(tile.filled, READOUT_RES_M);
    readoutGrids.set(tile, g);
  }
  return g;
}

export function useShadowShare(tile: LoadedTile | null, el: number, az: number): ShadowShare | null {
  const small = useMemo((): Grid | null => (tile ? readoutGrid(tile) : null), [tile]);
  const [share, setShare] = useState<ShadowShare | null>(null);
  const smallRef = useRef<Grid | null>(small);
  const want = useRef<{ el: number; az: number } | null>(null);
  const busy = useRef<boolean>(false);
  const timer = useRef<number | null>(null);
  const last = useRef<number>(0);
  const gen = useRef<number>(0);
  const pumpRef = useRef<() => void>((): void => undefined);
  smallRef.current = small;

  pumpRef.current = (): void => {
    const g = smallRef.current;
    if (!g || busy.current || timer.current !== null || !want.current) return;
    const wait = READOUT_MIN_MS - (performance.now() - last.current);
    if (wait > 0) {
      timer.current = window.setTimeout((): void => {
        timer.current = null;
        pumpRef.current();
      }, wait);
      return;
    }
    const p = want.current;
    want.current = null;
    busy.current = true;
    last.current = performance.now();
    const myGen = gen.current;
    shadowJob(g, 'frac', p.el, p.az, g.size, (r: ShadowReply): void => {
      busy.current = false;
      if (myGen === gen.current && r.type === 'frac') setShare({ el: r.el, az: r.az, frac: r.frac });
      pumpRef.current();
    });
  };

  useEffect((): void => {
    gen.current += 1;
    busy.current = false;
    setShare(null);
  }, [small]);

  useEffect((): void => {
    if (!small) return;
    want.current = { el, az };
    pumpRef.current();
  }, [small, el, az]);

  useEffect(
    (): (() => void) => (): void => {
      gen.current += 1;
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  return share;
}

// ------------------------------------------------------------------------------------------------
// Per-date shadow shares: each rehearsal date's sun on both tiles (same grid and method as the live readout)
// ------------------------------------------------------------------------------------------------

/** A sun for the panes: elevation and azimuth from the tile's top, already rounded as the panes use them. */
export interface SunDir {
  el: number;
  az: number;
}

/** Moon and Earth dark shares for one sun; null until worked out. */
export interface DatePair {
  moon: number | null;
  earth: number | null;
}

const fracCache = new WeakMap<Grid, Map<string, number>>();

function sunKey(d: SunDir): string {
  return `${d.el}|${d.az}`;
}

function cachedFrac(g: Grid | null, d: SunDir): number | null {
  return g ? (fracCache.get(g)?.get(sunKey(d)) ?? null) : null;
}

/** Dark share on both tiles for each sun in `dirs`, worked out off the main thread and cached per tile and sun. */
export function useDateShares(moonTile: LoadedTile | null, earthTile: LoadedTile | null, dirs: SunDir[]): DatePair[] {
  const moonGrid = useMemo((): Grid | null => (moonTile ? readoutGrid(moonTile) : null), [moonTile]);
  const earthGrid = useMemo((): Grid | null => (earthTile ? readoutGrid(earthTile) : null), [earthTile]);
  const [version, setVersion] = useState<number>(0);
  useEffect((): (() => void) => {
    const cancels: (() => void)[] = [];
    for (const g of [moonGrid, earthGrid]) {
      if (!g) continue;
      let cache = fracCache.get(g);
      if (!cache) {
        cache = new Map<string, number>();
        fracCache.set(g, cache);
      }
      const store = cache;
      for (const d of dirs) {
        const k = sunKey(d);
        if (store.has(k)) continue;
        cancels.push(
          shadowJob(g, 'frac', d.el, d.az, g.size, (r: ShadowReply): void => {
            if (r.type !== 'frac') return;
            store.set(k, r.frac);
            setVersion((v: number): number => v + 1);
          }),
        );
      }
    }
    return (): void => cancels.forEach((f: () => void): void => f());
  }, [moonGrid, earthGrid, dirs]);
  return useMemo(
    (): DatePair[] => dirs.map((d: SunDir): DatePair => ({ moon: cachedFrac(moonGrid, d), earth: cachedFrac(earthGrid, d) })),
    // `version` re-reads the cache after each reply.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [moonGrid, earthGrid, dirs, version],
  );
}

// ------------------------------------------------------------------------------------------------
// Reference shadow masks ("More options" → reference masks)
// ------------------------------------------------------------------------------------------------

function nearestMask(masks: ShadowMask[], el: number, az: number): ShadowMask | null {
  let best: ShadowMask | null = null;
  let bd = Infinity;
  for (const m of masks) {
    const daz = Math.abs(((m.az - az + 540) % 360) - 180);
    const d = Math.abs(m.el - el) * 10 + daz / 10;
    if (d < bd) {
      bd = d;
      best = m;
    }
  }
  return best;
}

function maskToTexture(mask: Uint8Array, n: number): THREE.DataTexture {
  const data = new Uint8Array(n * n * 4);
  for (let r = 0; r < n; r++) {
    const dr = n - 1 - r; // DataTexture row 0 is the bottom (v = 0)
    for (let c = 0; c < n; c++) {
      const v = mask[r * n + c] ? 0 : 255;
      const o = (dr * n + c) * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Pipeline mask PNGs: 255 = cast shadow, 0 = lit, 128 = no data -> black / white / mid grey. */
function imageMaskTexture(img: HTMLImageElement, n: number): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = n;
  cv.height = n;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (ctx) {
    ctx.drawImage(img, 0, 0, n, n);
    const im = ctx.getImageData(0, 0, n, n);
    const d = im.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i] * (d[i + 3] / 255);
      const out = v >= 192 ? 0 : v > 64 ? 110 : 255;
      d[i] = out;
      d[i + 1] = out;
      d[i + 2] = out;
      d[i + 3] = 255;
    }
    ctx.putImageData(im, 0, 0);
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export interface MaskState {
  texture: THREE.Texture | null;
  note: string;
}

export function useMaskTexture(
  tile: LoadedTile | null,
  mode: ShadowMode,
  el: number,
  az: number,
  masks: ShadowMask[],
  origin: Origin,
): MaskState {
  const [state, setState] = useState<MaskState>({ texture: null, note: '' });
  useEffect((): (() => void) | void => {
    if (!tile || mode !== 'precomputed') {
      setState((prev: MaskState): MaskState => (prev.texture === null && prev.note === '' ? prev : { texture: null, note: '' }));
      return;
    }
    let alive = true;
    const cleanup: (() => void)[] = [];
    const pick = nearestMask(masks, el, az);
    const fallbackToCpu = (): void => {
      const t = window.setTimeout((): void => {
        if (!alive) return;
        cleanup.push(
          shadowJob(tile.filled, 'mask', el, az, 400, (r: ShadowReply): void => {
            if (!alive || r.type !== 'mask') return;
            setState({ texture: maskToTexture(r.mask, r.size), note: `worked out in your browser for a ${el}° sun` });
          }),
        );
      }, 120);
      cleanup.push((): void => window.clearTimeout(t));
    };
    if (pick) {
      loadImage(pick.path, origin)
        .then((img: HTMLImageElement): void => {
          if (alive)
            setState({
              texture: imageMaskTexture(img, tile.filled.size),
              note: `pipeline mask nearest to this sun: ${pick.el}° from ${pick.az}° (grey = no data)`,
            });
        })
        .catch((): void => fallbackToCpu());
    } else {
      fallbackToCpu();
    }
    return (): void => {
      alive = false;
      cleanup.forEach((f: () => void): void => f());
    };
  }, [tile, mode, el, az, masks, origin]);
  useEffect((): (() => void) => (): void => state.texture?.dispose(), [state.texture]);
  return state;
}

// ------------------------------------------------------------------------------------------------
// Texture overlay: 1 km cells drawn into an emissive map so they read even in shadow
// ------------------------------------------------------------------------------------------------

const CELL_TEX = 600;

/** Emissive overlay: featureless cells tinted (alpha = share of sun directions with no landmark) + 1 km grid. */
export function useCellTexture(enabled: boolean, cells: TextureCell[] | null, tileSize: number, cellPx: number, tint: string): THREE.Texture | null {
  const tex = useMemo((): THREE.CanvasTexture | null => {
    if (!enabled) return null;
    const cv = document.createElement('canvas');
    cv.width = CELL_TEX;
    cv.height = CELL_TEX;
    const ctx = cv.getContext('2d');
    if (!ctx) return null;
    const s = CELL_TEX / tileSize;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, CELL_TEX, CELL_TEX);
    if (cells) {
      for (const cell of cells) {
        // Only cells that are empty from at least half the sun directions; strength follows that share.
        const f = cell.empty_az_frac ?? 1;
        if (f < 0.5) continue;
        const [c0, r0, c1, r1] = cell.bbox.px;
        ctx.globalAlpha = 0.2 + 0.8 * ((f - 0.5) / 0.5);
        ctx.fillStyle = tint;
        ctx.fillRect(c0 * s, r0 * s, (c1 - c0) * s, (r1 - r0) * s);
      }
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = 'rgba(237, 234, 228, 0.32)';
    ctx.lineWidth = 1.5;
    for (let p = 0; p <= tileSize + 0.01; p += cellPx) {
      const q = Math.round(p * s) + 0.5;
      ctx.beginPath();
      ctx.moveTo(q, 0);
      ctx.lineTo(q, CELL_TEX);
      ctx.moveTo(0, q);
      ctx.lineTo(CELL_TEX, q);
      ctx.stroke();
    }
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }, [enabled, cells, tileSize, cellPx, tint]);
  useEffect((): (() => void) => (): void => tex?.dispose(), [tex]);
  return tex;
}
