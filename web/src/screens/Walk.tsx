import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { loadFloat32, loadJson, loadJsonFrom, type Origin } from '../data/loader';
import { loadTile, type LoadedTile } from '../data/tiles';
import { sampleProfile, type WalkProfile } from '../lib/terrain';
import { SampleChip, ScreenHead } from '../components/ScreenHead';
import { useApp, useRegion, type CoreData } from '../store';
import { isEarthSitesFile, isPresetsFile, isTransectsFile, type EarthSite, type PresetRoute, type TransectItem, type TransectsFile } from '../types/contract';
import type { InitMsg, QueryMsg, ResultRow, WorkerReply } from '../workers/dtw.worker';
import { heightsFromSlopes, netRise } from '../lib/match';
import { isFindbackRaw, parseFindback, type Findback } from './walk/findback';
import type { SiteInfo } from './walk/place';
import { buildReadyRoutes, fromPresets, routeLength, type ReadyRoute } from './walk/routes';
import { StepBar, type StepState } from './walk/StepBar';
import { RouteChooser } from './walk/RouteChooser';
import { Results, type Found } from './walk/Results';
import { HowItWorks } from './walk/HowItWorks';
import { placeLabel } from './walk/place';
import './walk/walk.css';

const nf = new Intl.NumberFormat('en-US');

type XY = [number, number];

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
  findback: Findback | null;
  /** Site names from the transects' own lookup, else earth_sites.json of the SAME origin (never a real/sample mix). */
  sites: Map<string, SiteInfo>;
}

let walkDataPromise: Promise<WalkData> | null = null;

function loadWalkData(): Promise<WalkData> {
  if (!walkDataPromise) {
    walkDataPromise = (async (): Promise<WalkData> => {
      const t = await loadJson('walk/transects.json', isTransectsFile);
      const rows = await loadFloat32('walk/transects.bin', t.value.n * t.value.points, t.origin);
      const presets = await loadJsonFrom('walk/presets.json', isPresetsFile, t.origin); // same origin as the transects only
      const sites = new Map<string, SiteInfo>();
      if (t.value.sites) {
        for (const [id, st] of Object.entries(t.value.sites)) sites.set(id, { name: st.name, country: st.country ?? null });
      } else {
        const es = await loadJsonFrom('earth_sites.json', isEarthSitesFile, t.origin);
        (es?.value.sites ?? []).forEach((st: EarthSite): void => {
          sites.set(st.id, { name: st.name, country: null });
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
      const fb = await loadJsonFrom('walk/findback.json', isFindbackRaw, t.origin);
      return {
        lengths,
        descents,
        findback: fb ? parseFindback(fb.value) : null,
        transects: t.value,
        rows: rows.value,
        presets: presets?.value ?? [],
        presetsOrigin: presets?.origin ?? null,
        transectsOrigin: t.origin,
        sites,
      };
    })();
    walkDataPromise.catch((): void => {
      walkDataPromise = null;
    });
  }
  return walkDataPromise;
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
    return { idx: strict.map((t: TransectItem): number => t.i), note: `${nf.format(strict.length)} Earth paths of ${cls / 1000} km with a similar climb` };
  if (sameLen.length >= 25)
    return { idx: sameLen.map((t: TransectItem): number => t.i), note: `${nf.format(sameLen.length)} Earth paths of ${cls / 1000} km` };
  return { idx: items.map((t: TransectItem): number => t.i), note: `all ${nf.format(items.length)} Earth paths` };
}

function rmsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let k = 0; k < a.length; k++) s += (a[k] - b[k]) ** 2;
  return Math.sqrt(s / Math.max(a.length, 1));
}

type Source = { kind: 'ready'; id: string } | { kind: 'drawn' } | null;

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
  const [route, setRoute] = useState<XY[]>(walk && region && walk.regionId === region.id ? walk.route : []);
  const [source, setSource] = useState<Source>(walk && region && walk.regionId === region.id ? { kind: 'drawn' } : null);
  const [drawing, setDrawing] = useState<boolean>(false);
  const [hover, setHover] = useState<XY | null>(null);
  const [stretch, setStretch] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [found, setFound] = useState<Found[]>([]);
  const [sel, setSel] = useState<number>(0);
  const [note, setNote] = useState<string>('');
  const [problem, setProblem] = useState<string | null>(null);
  const [query, setQuery] = useState<WalkProfile | null>(null);
  const [searched, setSearched] = useState<{ route: XY[]; label: string; matcher: 'height_slope' | 'dtw' } | null>(null);
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

  // Reset when the region changes.
  const lastRegion = useRef<string | undefined>(region?.id);
  useEffect((): void => {
    if (region && lastRegion.current !== region.id) {
      lastRegion.current = region.id;
      setRoute([]);
      setSource(null);
      setDrawing(false);
      setFound([]);
      setQuery(null);
      setSearched(null);
      setNote('');
      setProblem(null);
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
    (pts: XY[], presetBest: PresetRoute['best'] | null, label: string): void => {
      if (!data || !tile || !region) return;
      const prof = sampleProfile(tile.raw, tile.ref.origin_x, tile.ref.origin_y, pts, data.transects.points);
      if (!prof) return;
      if (prof.hasNaN) {
        setProblem('This route crosses a gap in the Moon elevation data. Redraw it inside the shaded terrain.');
        return;
      }
      setProblem(null);
      const P = data.transects.points;
      const qh = heightsFromSlopes(prof.slopes, prof.length_m);
      const matcher: 'height_slope' | 'dtw' = stretch ? 'dtw' : 'height_slope';
      const toFound = (rows: ResultRow[]): Found[] =>
        rows.flatMap((row: ResultRow): Found[] => {
          const item = data.transects.items[row.i];
          if (!item) return [];
          const raw = Array.from(data.rows.subarray(row.i * P, (row.i + 1) * P));
          const slopes = row.reversed ? raw.reverse().map((v: number): number => -v) : raw;
          const shown: TransectItem = row.reversed
            ? { ...item, x0: item.x1, y0: item.y1, x1: item.x0, y1: item.y0, lat0: item.lat1, lon0: item.lon1, lat1: item.lat0, lon1: item.lon0 }
            : item;
          const eh = heightsFromSlopes(slopes, item.length_m);
          return [
            {
              row,
              item: shown,
              slopes,
              heights: Array.from(eh),
              climb: row.reversed ? (data.descents[row.i] ?? item.climb_m) : item.climb_m,
              rmsHeight: rmsDiff(qh, eh),
              rmsSlope: rmsDiff(prof.slopes, slopes),
            },
          ];
        });
      const finish = (rows: ResultRow[], msg: string): void => {
        const f = toFound(rows);
        setQuery(prof);
        setSearched({ route: pts, label, matcher });
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
            `Showing matches prepared with the dataset (${why}).`,
          );
        else {
          setBusy(false);
          setProblem(`The search could not run: ${why}`);
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
            ? `Compared with ${pre?.note ?? `${nf.format(m.searched)} Earth paths`}, allowing stretch, in ${m.ms.toFixed(0)} ms.`
            : `Compared with all ${nf.format(m.searched)} Earth paths, both walking directions, in ${m.ms.toFixed(0)} ms.`,
        );
      };
      w.addEventListener('message', onMsg);
      const msg: QueryMsg = {
        type: 'query',
        id,
        matcher,
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

  // Ready-made routes: a preset file of the same data source as the tiles, else found on the tile itself.
  const ready = useMemo((): ReadyRoute[] => {
    const fromFile =
      data && region && data.presetsOrigin === core.regionsOrigin ? data.presets.filter((p: PresetRoute): boolean => p.region_id === region.id) : [];
    if (fromFile.length > 0) return fromPresets(fromFile);
    return tile && region && tile.ref === region.tile ? buildReadyRoutes(tile, region.id) : [];
  }, [data, region, core.regionsOrigin, tile]);

  const pickReady = useCallback(
    (r: ReadyRoute): void => {
      setDrawing(false);
      setHover(null);
      setSource({ kind: 'ready', id: r.id });
      setRoute(r.moon_xy);
      run(r.moon_xy, r.best.length ? r.best : null, r.name);
    },
    [run],
  );

  // First visit to a region: run the remembered route or the first ready-made one, so the screen opens with a result.
  const autoRan = useRef<string | null>(null);
  useEffect((): void => {
    if (!data || !tile || !region || tile.ref !== region.tile || !workerRef.current) return;
    if (autoRan.current === region.id || query || busy) return;
    autoRan.current = region.id;
    if (route.length >= 2) {
      run(route, null, 'Your route');
      return;
    }
    const first = ready[0];
    if (route.length === 0 && first) pickReady(first);
  }, [data, tile, region, ready, route, query, busy, run, pickReady]);

  // Switching the stretch option re-runs the last search with the other matcher.
  const lastStretch = useRef<boolean>(stretch);
  useEffect((): void => {
    if (lastStretch.current === stretch) return;
    lastStretch.current = stretch;
    if (searched && !busy) run(searched.route, null, searched.label);
  }, [stretch, searched, busy, run]);

  // Live profile of the route on the Moon map (with the leg under the pointer while drawing).
  const live = useMemo((): WalkProfile | null => {
    if (!tile) return null;
    const pts = drawing && hover && route.length > 0 ? [...route, hover] : route;
    if (pts.length < 2) return null;
    const p = sampleProfile(tile.raw, tile.ref.origin_x, tile.ref.origin_y, pts, 100);
    return p && !p.hasNaN ? p : null;
  }, [tile, route, hover, drawing]);

  if (!region) return <p>No region selected.</p>;

  const routeLen = routeLength(route);
  const activeReady = source?.kind === 'ready' ? (ready.find((r: ReadyRoute): boolean => r.id === source.id) ?? null) : null;
  const routeLabel = activeReady ? activeReady.name : route.length >= 2 ? `Your route · ${(routeLen / 1000).toFixed(1)} km` : null;
  const stale = searched !== null && searched.route !== route;
  const searchBlock = route.length < 2 ? 'Place at least two points' : routeLen < 200 ? 'Make the route at least 200 m long' : !data ? 'Loading Earth paths…' : null;

  const best = found[0] ?? null;
  const placeOf = (id: string): ReturnType<typeof placeLabel> => placeLabel(data?.sites.get(id), id);
  const nPaths = data ? nf.format(data.transects.n) : '22,000';

  const verdict = best
    ? `Your route’s twin is ${placeOf(best.item.site_id).full}: heights within ${best.rmsHeight.toFixed(0)} m, slopes within ${best.rmsSlope.toFixed(1)}°`
    : busy
      ? `Searching ${nPaths} Earth paths for the same ups and downs…`
      : `Pick a route on ${region.name}; we find the Earth path with the same ups and downs`;

  const step2: StepState = route.length >= 2 ? 'done' : 'current';
  const step3: StepState = busy ? 'current' : best && !stale ? 'done' : route.length >= 2 ? 'current' : 'todo';
  const step3Value = busy
    ? 'Searching…'
    : best && !stale
      ? placeOf(best.item.site_id).short
      : route.length >= 2 && data
        ? 'Press “Find its Earth twin”'
        : 'Waiting for a route';

  const startDrawing = (first: XY | null): void => {
    setDrawing(true);
    setSource({ kind: 'drawn' });
    setRoute(first ? [first] : []);
    setHover(null);
    setProblem(null);
  };

  const current = found[sel] ?? null;
  const in3d = current ? core.setOrigin === data?.transectsOrigin && core.siteById.has(current.item.site_id) : false;

  return (
    <div className="wk">
      <ScreenHead
        kicker="Astronaut walk"
        chips={data?.transectsOrigin === 'mock' ? <SampleChip what="Earth paths" /> : null}
        result={verdict}
        methodLabel="How this works"
        method={<HowItWorks findback={data?.findback ?? null} nPaths={nPaths} />}
      />

      <StepBar
        regions={core.regions}
        regionId={region.id}
        onRegion={setRegion}
        step2={{ state: step2, value: drawing && route.length < 2 ? 'Drawing: click the map' : (routeLabel ?? 'Not chosen yet') }}
        step3={{ state: step3, value: step3Value }}
      />

      <div className="wk-layout">
        <RouteChooser
          region={region}
          tile={tile}
          ready={ready}
          activeId={activeReady?.id ?? null}
          route={route}
          drawing={drawing}
          hover={hover}
          live={live}
          busy={busy}
          dataReady={data !== null}
          stretch={stretch}
          searchBlock={searchBlock}
          problem={problem}
          canSearch={drawing || stale}
          onPick={pickReady}
          onDraw={(): void => startDrawing(null)}
          onCanvasClick={(xy: XY): void => {
            if (!drawing) startDrawing(xy);
            else {
              setProblem(null);
              setRoute((r: XY[]): XY[] => [...r, xy]);
            }
          }}
          onHover={setHover}
          onUndo={(): void => setRoute((r: XY[]): XY[] => r.slice(0, -1))}
          onClear={(): void => startDrawing(null)}
          onSearch={(): void => run(route, null, 'Your route')}
          onStretch={setStretch}
        />

        <Results
          region={region}
          data={data ? { sites: data.sites, n: data.transects.n, findback: data.findback } : null}
          dataErr={dataErr}
          busy={busy}
          stale={stale}
          query={query}
          searchedLabel={searched?.label ?? ''}
          matcher={searched?.matcher ?? 'height_slope'}
          found={found}
          sel={sel}
          onSel={setSel}
          note={note}
          in3d={in3d}
          onWalk3d={(): void => {
            if (!current || !in3d) return;
            if (walk) setWalk({ ...walk, bestItem: current.item, bestSlopes: current.slopes });
            setSite(current.item.site_id);
            setScreen('terrain');
          }}
          onCalgary={(): void => setScreen('alberta')}
        />
      </div>
    </div>
  );
}
