import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { loadFloat32, loadImage, loadJson, loadJsonFrom, type Origin } from '../data/loader';
import { loadTile, type LoadedTile } from '../data/tiles';
import { mapToPixel, pixelToMap, sampleProfile, type WalkProfile } from '../lib/terrain';
import { EarthMap, type MapLine, type MapPoint } from '../components/EarthMap';
import { Loading } from '../components/Loading';
import { SlopeChart } from '../components/SlopeChart';
import { SampleChip, ScreenHead } from '../components/ScreenHead';
import { useApp, useRegion, type CoreData } from '../store';
import {
  isObj,
  isEarthSitesFile,
  isPresetsFile,
  isTransectsFile,
  type EarthSite,
  type PresetRoute,
  type Region,
  type TransectItem,
  type TransectsFile,
} from '../types/contract';
import type { InitMsg, QueryMsg, ResultRow, WorkerReply } from '../workers/dtw.worker';
import { heightsFromSlopes, netRise } from '../lib/match';

const nf = new Intl.NumberFormat('en-US');

interface WalkData {
  transects: TransectsFile;
  rows: Float32Array;
  presets: PresetRoute[];
  presetsOrigin: Origin | null;
  transectsOrigin: Origin;
  /** Walk length (m) per row, indexed by row. */
  lengths: Float64Array;
  /** Descent (m) per row, from the stored climb and the net rise of the integrated profile. */
  descents: Float64Array;
  /** Find-back test top-1 rate of the height + slope matcher (findback.json), if available. */
  findbackTop1: number | null;
  /** Site names from earth_sites.json of the SAME origin as the transects (never a real/sample mix). */
  siteNames: Map<string, string>;
}

let walkDataPromise: Promise<WalkData> | null = null;

function loadWalkData(): Promise<WalkData> {
  if (!walkDataPromise) {
    walkDataPromise = (async (): Promise<WalkData> => {
      const t = await loadJson('walk/transects.json', isTransectsFile);
      const rows = await loadFloat32('walk/transects.bin', t.value.n * t.value.points, t.origin);
      const presets = await loadJsonFrom('walk/presets.json', isPresetsFile, t.origin); // same origin as the transects only
      // Place names: the transects' own `sites` lookup first, else earth_sites.json of the SAME origin.
      const siteNames = new Map<string, string>();
      if (t.value.sites) {
        for (const [id, st] of Object.entries(t.value.sites)) siteNames.set(id, st.country ? `${st.name}, ${st.country}` : st.name);
      } else {
        const sites = await loadJsonFrom('earth_sites.json', isEarthSitesFile, t.origin);
        (sites?.value.sites ?? []).forEach((st: EarthSite): void => {
          siteNames.set(st.id, st.name);
        });
      }
      const P = t.value.points;
      const n = t.value.n;
      const lengths = new Float64Array(n);
      const descents = new Float64Array(n);
      const h = new Float64Array(P);
      for (const it of t.value.items) {
        if (it.i < 0 || it.i >= n) continue;
        lengths[it.i] = it.length_m;
        heightsFromSlopes(rows.value.subarray(it.i * P, (it.i + 1) * P), it.length_m, h);
        descents[it.i] = Math.max(0, it.climb_m - netRise(h));
      }
      const fb = await loadJsonFrom('walk/findback.json', isFindback, t.origin);
      const winner = fb?.value.matchers.find((m) => m.name === 'euclid_height_slope');
      return {
        lengths,
        descents,
        findbackTop1: typeof winner?.top1 === 'number' ? winner.top1 : null,
        transects: t.value,
        rows: rows.value,
        presets: presets?.value ?? [],
        presetsOrigin: presets?.origin ?? null,
        transectsOrigin: t.origin,
        siteNames,
      };
    })();
    walkDataPromise.catch((): void => {
      walkDataPromise = null;
    });
  }
  return walkDataPromise;
}

interface FindbackFile {
  matchers: { name: string; top1: number; top5?: number }[];
}

function isFindback(v: unknown): v is FindbackFile {
  if (!isObj(v) || !Array.isArray(v.matchers)) return false;
  return v.matchers.every((m: unknown): boolean => isObj(m) && typeof m.name === 'string' && typeof m.top1 === 'number');
}

/**
 * Prefilter for the (slower) DTW option: same length class, similar steepest slope and climb. Climb is
 * checked in BOTH walking directions (a twin walked backwards climbs what the stored walk descends).
 */
function prefilter(items: TransectItem[], descents: Float64Array, q: WalkProfile): { idx: number[]; note: string } {
  const classes = Array.from(new Set(items.map((t: TransectItem): number => t.length_m))).sort((a: number, b: number): number => a - b);
  const cls = classes.reduce(
    (best: number, c: number): number => (Math.abs(Math.log(c / q.length_m)) < Math.abs(Math.log(best / q.length_m)) ? c : best),
    classes[0] ?? q.length_m,
  );
  const sameLen = items.filter((t: TransectItem): boolean => t.length_m === cls);
  const strict = sameLen.filter(
    (t: TransectItem): boolean =>
      t.max_slope_deg >= q.max_slope_deg * 0.5 - 6 &&
      t.max_slope_deg <= q.max_slope_deg * 1.7 + 6 &&
      [t.climb_m, descents[t.i] ?? t.climb_m].some((c: number): boolean => c >= q.climb_m * 0.4 - 40 && c <= q.climb_m * 2.5 + 40),
  );
  if (strict.length >= 25)
    return {
      idx: strict.map((t: TransectItem): number => t.i),
      note: `${strict.length} transects of ${cls / 1000} km with similar climb and steepest slope`,
    };
  if (sameLen.length >= 25)
    return {
      idx: sameLen.map((t: TransectItem): number => t.i),
      note: `${sameLen.length} transects of ${cls / 1000} km (slope/climb filter relaxed)`,
    };
  return { idx: items.map((t: TransectItem): number => t.i), note: `all ${items.length} transects (filters relaxed)` };
}

/**
 * Routes generated from the loaded Moon tile, used when the dataset has no preset routes for it
 * (preset coordinates are only valid for tiles from the same source).
 */
function builtInPresets(tile: LoadedTile, regionId: string): PresetRoute[] {
  const ref = tile.ref;
  const span = ref.size * ref.res_m;
  const cx = ref.origin_x + span / 2;
  const cy = ref.origin_y - span / 2;
  const out: PresetRoute[] = [];
  const line = (az: number, len: number, fromCentre: boolean): [number, number][] => {
    const a = (az * Math.PI) / 180;
    const dx = Math.sin(a) * len;
    const dy = Math.cos(a) * len;
    return fromCentre
      ? [
          [cx, cy],
          [cx + dx, cy + dy],
        ]
      : [
          [cx - dx / 2, cy - dy / 2],
          [cx + dx / 2, cy + dy / 2],
        ];
  };
  // Steepest 2 km climb out of the centre, of 16 directions.
  let best: { route: [number, number][]; climb: number } | null = null;
  for (let k = 0; k < 16; k++) {
    const route = line(k * 22.5, 2000, true);
    const prof = sampleProfile(tile.raw, ref.origin_x, ref.origin_y, route, 50);
    if (!prof || prof.hasNaN) continue;
    const climb = prof.climb_m - prof.descent_m;
    if (!best || climb > best.climb) best = { route, climb };
  }
  if (best) out.push({ region_id: regionId, name: 'Steepest climb · 2 km', moon_xy: best.route, best: [] });
  out.push({ region_id: regionId, name: 'Straight across · 2 km', moon_xy: line(90, 2000, false), best: [] });
  out.push({ region_id: regionId, name: 'Long traverse · 5 km', moon_xy: line(45, 5000, false), best: [] });
  return out;
}

interface Found {
  row: ResultRow;
  item: TransectItem;
  slopes: number[];
  /** RMS differences to the Moon walk, in the matched direction. */
  rmsHeight: number;
  rmsSlope: number;
}

function rmsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let k = 0; k < a.length; k++) s += (a[k] - b[k]) ** 2;
  return Math.sqrt(s / Math.max(a.length, 1));
}

function DrawCanvas({
  region,
  tile,
  route,
  onAdd,
}: {
  region: Region;
  tile: LoadedTile;
  route: [number, number][];
  onAdd: (xy: [number, number]) => void;
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const origin = useApp((s) => s.core?.regionsOrigin ?? 'data');
  const N = 720;
  useEffect((): (() => void) => {
    let alive = true;
    setImg(null);
    loadImage(region.hillshade, origin)
      .then((i: HTMLImageElement): void => {
        if (alive) setImg(i);
      })
      .catch((): void => undefined);
    return (): void => {
      alive = false;
    };
  }, [region, origin]);

  useEffect((): void => {
    const cv = ref.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    ctx.fillStyle = '#050608';
    ctx.fillRect(0, 0, N, N);
    if (img) ctx.drawImage(img, 0, 0, N, N);
    const n = tile.ref.size;
    const toCanvas = ([x, y]: [number, number]): [number, number] => {
      const [c, r] = mapToPixel(x, y, tile.ref.origin_x, tile.ref.origin_y, tile.ref.res_m);
      return [((c + 0.5) / n) * N, ((r + 0.5) / n) * N];
    };
    // scale bar: 1 km
    const kmPx = (1000 / (n * tile.ref.res_m)) * N;
    ctx.fillStyle = 'rgba(10, 11, 14, 0.78)';
    ctx.fillRect(N - kmPx - 28, N - 34, kmPx + 20, 24);
    ctx.fillStyle = '#edeae4';
    ctx.fillRect(N - kmPx - 18, N - 18, kmPx, 3);
    ctx.font = '12px "IBM Plex Sans", system-ui, sans-serif';
    ctx.fillText('1 km', N - kmPx - 18, N - 22);
    if (route.length === 0) return;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#0a0b0e';
    ctx.lineWidth = 7;
    ctx.beginPath();
    route.forEach((p: [number, number], i: number): void => {
      const [px, py] = toCanvas(p);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.strokeStyle = '#edeae4';
    ctx.lineWidth = 3;
    ctx.stroke();
    route.forEach((p: [number, number], i: number): void => {
      const [px, py] = toCanvas(p);
      ctx.beginPath();
      ctx.arc(px, py, i === 0 ? 7 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#edeae4';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#0a0b0e';
      ctx.stroke();
      if (i === 0) {
        ctx.beginPath();
        ctx.arc(px, py, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = '#0a0b0e';
        ctx.fill();
      }
    });
  }, [img, route, tile]);

  return (
    <canvas
      ref={ref}
      width={N}
      height={N}
      role="img"
      aria-label={`Hillshade of ${region.name}. Click to add route points.`}
      onClick={(e): void => {
        const rect = e.currentTarget.getBoundingClientRect();
        const n = tile.ref.size;
        const col = ((e.clientX - rect.left) / rect.width) * n - 0.5;
        const row = ((e.clientY - rect.top) / rect.height) * n - 0.5;
        onAdd(pixelToMap(col, row, tile.ref.origin_x, tile.ref.origin_y, tile.ref.res_m));
      }}
    />
  );
}

export default function Walk(): JSX.Element {
  const core = useApp((s) => s.core) as CoreData;
  const region = useRegion();
  const setRegion = useApp((s) => s.setRegion);
  const setSite = useApp((s) => s.setSite);
  const setScreen = useApp((s) => s.setScreen);
  const walk = useApp((s) => s.walk);
  const setWalk = useApp((s) => s.setWalk);

  const [data, setData] = useState<WalkData | null>(null);
  const [dataErr, setDataErr] = useState<string | null>(null);
  const [tile, setTile] = useState<LoadedTile | null>(null);
  const [route, setRoute] = useState<[number, number][]>(walk && region && walk.regionId === region.id ? walk.route : []);
  const [stretch, setStretch] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [found, setFound] = useState<Found[]>([]);
  const [sel, setSel] = useState<number>(0);
  const [note, setNote] = useState<string>('');
  const [query, setQuery] = useState<WalkProfile | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const reqId = useRef<number>(0);

  useEffect((): void => {
    loadWalkData()
      .then(setData)
      .catch((e: unknown): void => setDataErr(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect((): (() => void) | void => {
    if (!region) return;
    let alive = true;
    setTile(null);
    loadTile(region.tile, core.regionsOrigin)
      .then((t: LoadedTile): void => {
        if (alive) setTile(t);
      })
      .catch((): void => undefined);
    return (): void => {
      alive = false;
    };
  }, [region, core.regionsOrigin]);

  // reset when region changes
  const lastRegion = useRef<string | undefined>(region?.id);
  useEffect((): void => {
    if (region && lastRegion.current !== region.id) {
      lastRegion.current = region.id;
      setRoute([]);
      setFound([]);
      setQuery(null);
      setNote('');
    }
  }, [region]);

  useEffect((): (() => void) | void => {
    if (!data) return;
    const w = new Worker(new URL('../workers/dtw.worker.ts', import.meta.url), { type: 'module' });
    const copy = data.rows.slice().buffer;
    const init: InitMsg = { type: 'init', bin: copy, points: data.transects.points, lengths: data.lengths };
    w.postMessage(init, [copy]);
    workerRef.current = w;
    return (): void => {
      w.terminate();
      workerRef.current = null;
    };
  }, [data]);

  const run = useCallback(
    (pts: [number, number][], presetBest: PresetRoute['best'] | null): void => {
      if (!data || !tile || !region) return;
      const prof = sampleProfile(tile.raw, tile.ref.origin_x, tile.ref.origin_y, pts, data.transects.points);
      if (!prof) return;
      if (prof.hasNaN) {
        setNote('The route crosses a no-data area of the elevation model. Redraw it inside the shaded terrain.');
        return;
      }
      setQuery(prof);
      const P = data.transects.points;
      const qh = heightsFromSlopes(prof.slopes, prof.length_m);
      const toFound = (rows: ResultRow[]): Found[] =>
        rows.flatMap((row: ResultRow): Found[] => {
          const item = data.transects.items[row.i];
          if (!item) return [];
          const raw = Array.from(data.rows.subarray(row.i * P, (row.i + 1) * P));
          const slopes = row.reversed ? raw.reverse().map((v: number): number => -v) : raw;
          const shown: TransectItem = row.reversed
            ? {
                ...item,
                x0: item.x1,
                y0: item.y1,
                x1: item.x0,
                y1: item.y0,
                lat0: item.lat1,
                lon0: item.lon1,
                lat1: item.lat0,
                lon1: item.lon0,
              }
            : item;
          const eh = heightsFromSlopes(slopes, item.length_m);
          return [{ row, item: shown, slopes, rmsHeight: rmsDiff(qh, eh), rmsSlope: rmsDiff(prof.slopes, slopes) }];
        });
      const finish = (rows: ResultRow[], msg: string): void => {
        const f = toFound(rows);
        setFound(f);
        setSel(0);
        setNote(msg);
        setBusy(false);
        setWalk({
          regionId: region.id,
          route: pts,
          moonSlopes: prof.slopes,
          results: rows.map((r: ResultRow) => ({ i: r.i, dist: r.dist })),
          bestSlopes: f[0]?.slopes ?? null,
          bestItem: f[0]?.item ?? null,
        });
      };
      const w = workerRef.current;
      const fallback = (why: string): void => {
        if (presetBest && presetBest.length)
          finish(
            presetBest.map((b) => ({ i: b.i, dist: b.dtw, reversed: false })),
            `Precomputed preset matches (${why}).`,
          );
        else {
          setBusy(false);
          setNote(`Search failed: ${why}`);
        }
      };
      if (!w) {
        fallback('search worker unavailable');
        return;
      }
      // Height + slope scans every row (fast); the DTW option keeps the orientation-aware prefilter.
      const pre = stretch ? prefilter(data.transects.items, data.descents, prof) : null;
      setBusy(true);
      const id = ++reqId.current;
      const onMsg = (ev: MessageEvent<WorkerReply>): void => {
        const m = ev.data;
        if (m.type === 'error') {
          w.removeEventListener('message', onMsg);
          fallback(m.message);
          return;
        }
        if (m.type !== 'result' || m.id !== id) return;
        w.removeEventListener('message', onMsg);
        finish(
          m.results,
          stretch
            ? `Searched ${pre?.note ?? `${m.searched} transects`} with banded DTW (Sakoe-Chiba 10%), both directions, in ${m.ms.toFixed(0)} ms.`
            : `Searched all ${nf.format(m.searched)} Earth transects in both directions in ${m.ms.toFixed(0)} ms.`,
        );
      };
      w.addEventListener('message', onMsg);
      const msg: QueryMsg = {
        type: 'query',
        id,
        matcher: stretch ? 'dtw' : 'height_slope',
        query: prof.slopes,
        lengthM: prof.length_m,
        candidates: pre ? pre.idx : null,
        band: 0.1,
        topK: 5,
      };
      w.postMessage(msg);
    },
    [data, tile, region, stretch, setWalk],
  );

  // Preset routes are in map metres of a specific DEM: only use them with tiles from the same source.
  const presets = useMemo((): PresetRoute[] => {
    const fromFile =
      data && region && data.presetsOrigin === core.regionsOrigin
        ? data.presets.filter((p: PresetRoute): boolean => p.region_id === region.id)
        : [];
    if (fromFile.length > 0) return fromFile;
    return tile && region && tile.ref === region.tile ? builtInPresets(tile, region.id) : [];
  }, [data, region, core.regionsOrigin, tile]);
  const [activePreset, setActivePreset] = useState<string | null>(null);

  const runPreset = useCallback(
    (p: PresetRoute): void => {
      setActivePreset(p.name);
      setRoute(p.moon_xy);
      run(p.moon_xy, p.best.length ? p.best : null);
    },
    [run],
  );

  // First visit to a region: run a preset (or the remembered route) so the screen opens with a result.
  const autoRan = useRef<string | null>(null);
  useEffect((): void => {
    if (!data || !tile || !region || tile.ref !== region.tile || !workerRef.current) return;
    if (autoRan.current === region.id || query || busy) return;
    autoRan.current = region.id;
    if (route.length >= 2) {
      run(route, null);
      return;
    }
    const first = presets[0];
    if (route.length === 0 && first) runPreset(first);
  }, [data, tile, region, presets, route, query, busy, run, runPreset]);

  const current = found[sel] ?? null;
  const siteName = (id: string): string => data?.siteNames.get(id) ?? `Earth square ${id}`;
  const currentSite = current ? { id: current.item.site_id, name: siteName(current.item.site_id) } : null;
  // The 3D view joins with the core site set; only offer it when this square is in that set (same origin).
  const in3d = current ? core.setOrigin === data?.transectsOrigin && core.siteById.has(current.item.site_id) : false;

  const mapPoints = useMemo(
    (): MapPoint[] =>
      current && currentSite
        ? [
            {
              id: currentSite.id,
              lat: current.item.lat0,
              lon: current.item.lon0,
              label: '▶',
              title: `Start of the best path at ${currentSite.name}`,
              active: true,
            },
          ]
        : [],
    [current, currentSite],
  );
  const mapLines = useMemo(
    (): MapLine[] =>
      current
        ? [
            {
              id: 'best',
              coords: [
                [current.item.lon0, current.item.lat0],
                [current.item.lon1, current.item.lat1],
              ],
            },
          ]
        : [],
    [current],
  );

  if (!region) return <p>No region selected.</p>;

  const routeLen = route.reduce(
    (acc: number, p: [number, number], i: number): number => (i ? acc + Math.hypot(p[0] - route[i - 1][0], p[1] - route[i - 1][1]) : 0),
    0,
  );
  const searchBlock =
    route.length < 2 ? 'Place 2+ points' : routeLen < 200 ? 'Make the route at least 200 m' : !data ? 'Loading Earth transects…' : null;
  const best = found[0] ?? null;
  const bestSite = best ? { name: siteName(best.item.site_id) } : null;
  const result = busy
    ? 'Searching Earth transects for the same climb…'
    : best && query
      ? `${bestSite?.name ?? `Earth square ${best.item.site_id}`} walks most like this ${(query.length_m / 1000).toFixed(1)} km route: heights within ${best.rmsHeight.toFixed(0)} m and slopes within ${best.rmsSlope.toFixed(1)}° (RMS)`
      : query
        ? 'No Earth transect matched this route'
        : `Draw a moonwalk on ${region.name}; we find the Earth path that climbs the same way`;

  const matchCopy =
    data?.findbackTop1 != null
      ? `Matched on the shape of the climb and the slope; in a hidden-copy test the matcher found the Moon route first ${Math.round(data.findbackTop1 * 100)}% of the time`
      : 'Matched on the shape of the climb and the slope';

  const clearAll = (): void => {
    setRoute([]);
    setFound([]);
    setQuery(null);
    setNote('');
    setActivePreset(null);
  };

  return (
    <div>
      <ScreenHead
        kicker="Astronaut walk"
        chips={data?.transectsOrigin === 'mock' ? <SampleChip what="Earth transects" /> : null}
        result={result}
        aside={
          <label className="field">
            <span className="field-label">Moon region</span>
            <select className="select" value={region.id} onChange={(e): void => setRegion(e.target.value)}>
              {core.regions.map((r: Region) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        }
        method={
          <p>
            Click on the terrain to lay out a route. We sample the elevation model along it into a 100-point profile and compare it with
            every Earth transect, in both walking directions. {matchCopy}. “Tolerate stretched routes” switches to dynamic time warping,
            which is slower and less accurate unless a route is clearly stretched.
          </p>
        }
      />

      <div className="walk-layout">
        <div className="walk-draw">
          <div className="draw-wrap">
            {tile ? (
              <DrawCanvas
                region={region}
                tile={tile}
                route={route}
                onAdd={(xy): void => {
                  setActivePreset(null);
                  setRoute((r) => [...r, xy]);
                }}
              />
            ) : (
              <Loading label="Loading Moon terrain…" />
            )}
            <div className="draw-hint">
              {route.length === 0
                ? 'Click to place the start of the walk.'
                : route.length === 1
                  ? 'Click again to add the next point.'
                  : `${route.length} points · ${(routeLen / 1000).toFixed(2)} km. Add more points or search.`}
            </div>
          </div>
          <div className="toolbar">
            <button
              type="button"
              className="btn btn-primary"
              disabled={searchBlock !== null || busy}
              onClick={(): void => run(route, null)}
            >
              {busy ? 'Searching…' : 'Find the Earth twin'}
            </button>
            <button type="button" className="btn" disabled={route.length === 0} onClick={(): void => setRoute((r) => r.slice(0, -1))}>
              Undo point
            </button>
            <button type="button" className="btn" disabled={route.length === 0} onClick={clearAll}>
              Clear
            </button>
            {searchBlock && !busy && <span className="caption">{searchBlock}</span>}
            <label
              className="check"
              title="Uses dynamic time warping, which lets hills sit slightly out of place. Slower, and less accurate when routes are not stretched."
            >
              <input type="checkbox" checked={stretch} onChange={(e): void => setStretch(e.target.checked)} /> Tolerate stretched routes
              (slower)
            </label>
          </div>
          {dataErr && <div className="error-box">Walk data unavailable: {dataErr}</div>}
        </div>

        <div className="panel panel-pad walk-panel">
          {presets.length > 0 && (
            <div className="preset-row" role="group" aria-label="Preset routes">
              <span className="field-label">Try a route</span>
              <div className="preset-buttons">
                {presets.map((p: PresetRoute) => (
                  <button
                    key={p.name}
                    type="button"
                    className="btn btn-sm"
                    aria-pressed={activePreset === p.name}
                    disabled={!data || busy}
                    onClick={(): void => runPreset(p)}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {!query ? (
            <div className="empty">
              <p>
                {busy ? 'Searching…' : 'Pick a route above, or click on the terrain to draw your own, then press “Find the Earth twin”.'}
              </p>
              {!data && !dataErr && <p className="caption">Loading Earth transects…</p>}
            </div>
          ) : (
            <>
              <section>
                <SlopeChart
                  title="Slope along the walk"
                  moon={query.slopes}
                  earth={current ? current.slopes : null}
                  moonLabel={`Moon · ${region.name}`}
                  earthLabel={current ? `Earth · ${currentSite?.name ?? ''}` : null}
                />
                <p className="caption">
                  Degrees, uphill positive. Moon walk: {(query.length_m / 1000).toFixed(2)} km, climb {query.climb_m.toFixed(0)} m, steepest{' '}
                  {query.max_slope_deg.toFixed(1)}°. {note}
                </p>
              </section>

              {found.length > 0 ? (
                <>
                  <table className="data-table result-list">
                    <thead>
                      <tr>
                        <th className="r">#</th>
                        <th>Earth site</th>
                        <th className="r">Length</th>
                        <th className="r">Climb</th>
                        <th className="r">Steepest</th>
                        <th className="r" title="RMS difference in relative height along the walk, in the matched direction">
                          Height diff.
                        </th>
                        <th className="r" title="RMS difference in slope along the walk, in the matched direction">
                          Slope diff.
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {found.map((f: Found, i: number) => {
                        const s2 = { name: siteName(f.item.site_id) };
                        return (
                          <tr key={`${f.row.i}`} data-active={i === sel} onClick={(): void => setSel(i)}>
                            <td className="r">{i + 1}</td>
                            <td>
                              <button type="button" className="row-btn" aria-pressed={i === sel} onClick={(): void => setSel(i)}>
                                {s2?.name ?? f.item.site_id}
                              </button>
                            </td>
                            <td className="r">{(f.item.length_m / 1000).toFixed(1)} km</td>
                            <td className="r">
                              {(f.row.reversed ? (data?.descents[f.row.i] ?? f.item.climb_m) : f.item.climb_m).toFixed(0)} m
                            </td>
                            <td className="r">{f.item.max_slope_deg.toFixed(1)}°</td>
                            <td className="r">{f.rmsHeight.toFixed(0)} m</td>
                            <td className="r">{f.rmsSlope.toFixed(1)}°</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <div className="mini-map">
                    <EarthMap points={mapPoints} lines={mapLines} fitKey={`${current?.row.i ?? 'none'}`} maxZoom={12} />
                  </div>
                  <div className="card-actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={!current || !in3d}
                      onClick={(): void => {
                        if (!current || !in3d) return;
                        if (walk) setWalk({ ...walk, bestItem: current.item, bestSlopes: current.slopes });
                        setSite(current.item.site_id);
                        setScreen('terrain');
                      }}
                    >
                      Walk both in 3D →
                    </button>
                    <span className="caption">
                      {!in3d && current ? 'This Earth square isn’t in the loaded site set yet, so it can’t open in 3D. ' : ''}
                      {matchCopy}. It compares terrain shape only, not surface material, boulders or gravity.
                    </span>
                  </div>
                </>
              ) : (
                !busy && <p className="muted">No Earth transect passed the search.</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
