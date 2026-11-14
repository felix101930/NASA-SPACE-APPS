import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { loadFloat32, loadImage, loadJson, loadOptionalJson, type Origin } from '../data/loader';
import { loadTile, type LoadedTile } from '../data/tiles';
import { mapToPixel, pixelToMap, sampleProfile, type WalkProfile } from '../lib/terrain';
import { EarthMap, type MapLine, type MapPoint } from '../components/EarthMap';
import { Loading } from '../components/Loading';
import { useApp, useRegion, type CoreData } from '../store';
import { isPresetsFile, isTransectsFile, type PresetRoute, type Region, type TransectItem, type TransectsFile } from '../types/contract';
import type { QueryMsg, ResultRow, WorkerReply } from '../workers/dtw.worker';

interface WalkData {
  transects: TransectsFile;
  rows: Float32Array;
  presets: PresetRoute[];
  presetsOrigin: Origin | null;
}

let walkDataPromise: Promise<WalkData> | null = null;

function loadWalkData(): Promise<WalkData> {
  if (!walkDataPromise) {
    walkDataPromise = (async (): Promise<WalkData> => {
      const t = await loadJson('walk/transects.json', isTransectsFile);
      const rows = await loadFloat32('walk/transects.bin', t.value.n * t.value.points, t.origin);
      const presets = await loadOptionalJson('walk/presets.json', isPresetsFile);
      return { transects: t.value, rows: rows.value, presets: presets?.value ?? [], presetsOrigin: presets?.origin ?? null };
    })();
    walkDataPromise.catch((): void => {
      walkDataPromise = null;
    });
  }
  return walkDataPromise;
}

/** Prefilter on summary stats before DTW: same length class, similar max slope and climb. */
function prefilter(items: TransectItem[], q: WalkProfile): { idx: number[]; note: string } {
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
      t.climb_m >= q.climb_m * 0.4 - 40 &&
      t.climb_m <= q.climb_m * 2.5 + 40,
  );
  if (strict.length >= 25) return { idx: strict.map((t: TransectItem): number => t.i), note: `${strict.length} transects of ${cls / 1000} km with similar climb and steepest slope` };
  if (sameLen.length >= 25) return { idx: sameLen.map((t: TransectItem): number => t.i), note: `${sameLen.length} transects of ${cls / 1000} km (slope/climb filter relaxed)` };
  return { idx: items.map((t: TransectItem): number => t.i), note: `all ${items.length} transects (filters relaxed)` };
}

interface Found {
  row: ResultRow;
  item: TransectItem;
  slopes: number[];
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
    ctx.fillStyle = 'rgba(5,6,8,0.75)';
    ctx.fillRect(N - kmPx - 28, N - 34, kmPx + 20, 24);
    ctx.fillStyle = '#ece7de';
    ctx.fillRect(N - kmPx - 18, N - 18, kmPx, 3);
    ctx.font = '12px "IBM Plex Mono", monospace';
    ctx.fillText('1 km', N - kmPx - 18, N - 22);
    if (route.length === 0) return;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#1a1306';
    ctx.lineWidth = 7;
    ctx.beginPath();
    route.forEach((p: [number, number], i: number): void => {
      const [px, py] = toCanvas(p);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.strokeStyle = '#f3b54a';
    ctx.lineWidth = 3.5;
    ctx.stroke();
    route.forEach((p: [number, number], i: number): void => {
      const [px, py] = toCanvas(p);
      ctx.fillStyle = i === 0 ? '#5ad593' : '#f3b54a';
      ctx.beginPath();
      ctx.arc(px, py, i === 0 ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fill();
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
  const [znorm, setZnorm] = useState<boolean>(false);
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
    w.postMessage({ type: 'init', bin: copy, points: data.transects.points }, [copy]);
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
      const { idx, note: fnote } = prefilter(data.transects.items, prof);
      const P = data.transects.points;
      const toFound = (rows: ResultRow[]): Found[] =>
        rows.flatMap((row: ResultRow): Found[] => {
          const item = data.transects.items[row.i];
          if (!item) return [];
          const raw = Array.from(data.rows.subarray(row.i * P, (row.i + 1) * P));
          const slopes = row.reversed ? raw.reverse().map((v: number): number => -v) : raw;
          const shown: TransectItem = row.reversed
            ? { ...item, x0: item.x1, y0: item.y1, x1: item.x0, y1: item.y0, lat0: item.lat1, lon0: item.lon1, lat1: item.lat0, lon1: item.lon0 }
            : item;
          return [{ row, item: shown, slopes }];
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
          results: rows.map((r: ResultRow) => ({ i: r.i, dtw: r.dtw })),
          bestSlopes: f[0]?.slopes ?? null,
          bestItem: f[0]?.item ?? null,
        });
      };
      const w = workerRef.current;
      const fallback = (why: string): void => {
        if (presetBest && presetBest.length) finish(presetBest.map((b) => ({ i: b.i, dtw: b.dtw, reversed: false })), `Precomputed preset matches (${why}).`);
        else {
          setBusy(false);
          setNote(`Search failed: ${why}`);
        }
      };
      if (!w) {
        fallback('search worker unavailable');
        return;
      }
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
        finish(m.results, `Searched ${fnote} with banded DTW (Sakoe-Chiba 10%${znorm ? ', z-normalised' : ''}) in ${m.ms.toFixed(0)} ms.`);
      };
      w.addEventListener('message', onMsg);
      const msg: QueryMsg = { type: 'query', id, query: prof.slopes, candidates: idx, band: 0.1, znorm, topK: 5 };
      w.postMessage(msg);
    },
    [data, tile, region, znorm, setWalk],
  );

  // Preset routes are in map metres of a specific DEM: only use them with tiles from the same source.
  const presets = useMemo(
    (): PresetRoute[] =>
      data && region && data.presetsOrigin === core.regionsOrigin ? data.presets.filter((p: PresetRoute): boolean => p.region_id === region.id) : [],
    [data, region, core.regionsOrigin],
  );
  const current = found[sel] ?? null;
  const currentSite = current ? core.siteById.get(current.item.site_id) ?? null : null;

  const chartData = useMemo(() => {
    if (!query) return [];
    const n = query.slopes.length;
    return query.slopes.map((v: number, i: number) => ({
      pct: Math.round((i / (n - 1)) * 100),
      moon: Number(v.toFixed(2)),
      earth: current ? Number((current.slopes[i] ?? NaN).toFixed(2)) : null,
    }));
  }, [query, current]);

  const mapPoints = useMemo(
    (): MapPoint[] =>
      current && currentSite ? [{ id: currentSite.id, lat: current.item.lat0, lon: current.item.lon0, label: '▶', title: `Start of the best path at ${currentSite.name}`, active: true }] : [],
    [current, currentSite],
  );
  const mapLines = useMemo(
    (): MapLine[] => (current ? [{ id: 'best', coords: [[current.item.lon0, current.item.lat0], [current.item.lon1, current.item.lat1]] }] : []),
    [current],
  );

  if (!region) return <p>No region selected.</p>;

  const routeLen = route.reduce((acc: number, p: [number, number], i: number): number => (i ? acc + Math.hypot(p[0] - route[i - 1][0], p[1] - route[i - 1][1]) : 0), 0);

  return (
    <div>
      <div className="screen-head">
        <div>
          <h1>Draw a moonwalk, find its twin on Earth</h1>
          <p>
            Click on the terrain to lay out a route. We sample the elevation model along it, turn it into a slope profile
            (100 points, uphill positive) and search Earth transects for the walk that climbs and descends the same way.
          </p>
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="label">Region</span>
          <select className="select" value={region.id} onChange={(e): void => setRegion(e.target.value)}>
            {core.regions.map((r: Region) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="walk-layout">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="draw-wrap">
            {tile ? <DrawCanvas region={region} tile={tile} route={route} onAdd={(xy): void => setRoute((r) => [...r, xy])} /> : <Loading label="Loading Moon terrain…" />}
            <div className="draw-hint">
              {route.length === 0
                ? 'Click to place the start of the walk.'
                : route.length === 1
                  ? 'Click again to add the next point.'
                  : `${route.length} points · ${(routeLen / 1000).toFixed(2)} km. Add more points or search.`}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn btn-primary" disabled={route.length < 2 || routeLen < 200 || !data || busy} onClick={(): void => run(route, null)}>
              {busy ? 'Searching…' : 'Find the Earth twin'}
            </button>
            <button className="btn" disabled={route.length === 0} onClick={(): void => setRoute((r) => r.slice(0, -1))}>
              Undo point
            </button>
            <button
              className="btn"
              disabled={route.length === 0}
              onClick={(): void => {
                setRoute([]);
                setFound([]);
                setQuery(null);
                setNote('');
              }}
            >
              Clear
            </button>
            {presets.length > 0 && (
              <select
                className="select"
                value=""
                aria-label="Load a preset route"
                onChange={(e): void => {
                  const p = presets[Number(e.target.value)];
                  if (p) {
                    setRoute(p.moon_xy);
                    run(p.moon_xy, p.best);
                  }
                }}
              >
                <option value="">Or try a preset route…</option>
                {presets.map((p: PresetRoute, i: number) => (
                  <option key={p.name} value={i}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14 }} title="Compare shape only, ignoring how steep overall">
              <input type="checkbox" checked={znorm} onChange={(e): void => setZnorm(e.target.checked)} /> z-normalise
            </label>
          </div>
          {dataErr && <div className="error-box">Walk data unavailable: {dataErr}</div>}
        </div>

        <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {!query ? (
            <div className="loading" style={{ minHeight: 320 }}>
              <span>Draw a route (or pick a preset) and press “Find the Earth twin”.</span>
              {!data && !dataErr && <span className="faint">Loading Earth transects…</span>}
            </div>
          ) : (
            <>
              <div>
                <div className="label">Slope along the walk (°, uphill positive)</div>
                <div style={{ height: 260, marginTop: 8 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
                      <CartesianGrid stroke="#2a303d" strokeDasharray="3 3" />
                      <XAxis dataKey="pct" stroke="#8f8b84" tick={{ fontSize: 12 }} unit="%" />
                      <YAxis stroke="#8f8b84" tick={{ fontSize: 12 }} unit="°" />
                      <ReferenceLine y={0} stroke="#3a4252" />
                      <Tooltip
                        contentStyle={{ background: '#161a23', border: '1px solid #3a4252', borderRadius: 6 }}
                        labelFormatter={(v): string => `${String(v)}% along the walk`}
                      />
                      <Legend wrapperStyle={{ fontSize: 13 }} />
                      <Line type="monotone" dataKey="moon" name={`Moon · ${region.name}`} stroke="#f3b54a" strokeWidth={2.5} dot={false} isAnimationActive={false} />
                      <Line
                        type="monotone"
                        dataKey="earth"
                        name={currentSite ? `Earth · ${currentSite.name}` : 'Earth'}
                        stroke="#93a4ff"
                        strokeWidth={2}
                        dot={false}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <p className="faint" style={{ fontSize: 12.5 }}>
                  Moon walk: {(query.length_m / 1000).toFixed(2)} km, climb {query.climb_m.toFixed(0)} m, steepest {query.max_slope_deg.toFixed(1)}°. {note}
                </p>
              </div>

              {found.length > 0 ? (
                <>
                  <table className="result-list">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Earth site</th>
                        <th>Length</th>
                        <th>Climb</th>
                        <th>Steepest</th>
                        <th title="Mean absolute slope difference along the warped path">DTW, mean °</th>
                      </tr>
                    </thead>
                    <tbody>
                      {found.map((f: Found, i: number) => {
                        const s = core.siteById.get(f.item.site_id);
                        return (
                          <tr key={`${f.row.i}`} data-active={i === sel} style={{ cursor: 'pointer' }} onClick={(): void => setSel(i)}>
                            <td className="num">{i + 1}</td>
                            <td>
                              <button className="btn btn-sm" style={{ background: 'none', border: 0, padding: 0, color: 'inherit', textAlign: 'left' }} onClick={(): void => setSel(i)}>
                                {s?.name ?? f.item.site_id}
                              </button>
                            </td>
                            <td className="num">{(f.item.length_m / 1000).toFixed(1)} km</td>
                            <td className="num">{f.item.climb_m.toFixed(0)} m</td>
                            <td className="num">{f.item.max_slope_deg.toFixed(1)}°</td>
                            <td className="num">{f.row.dtw.toFixed(2)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <div className="mini-map">
                    <EarthMap points={mapPoints} lines={mapLines} fitKey={`${current?.row.i ?? 'none'}`} maxZoom={12} />
                  </div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button
                      className="btn btn-primary"
                      disabled={!current}
                      onClick={(): void => {
                        if (!current) return;
                        if (walk) setWalk({ ...walk, bestItem: current.item, bestSlopes: current.slopes });
                        setSite(current.item.site_id);
                        setScreen('terrain');
                      }}
                    >
                      Walk both in 3D →
                    </button>
                    <span className="faint" style={{ fontSize: 12.5 }}>
                      A profile match compares slopes only, not surface material, boulders or gravity.
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
