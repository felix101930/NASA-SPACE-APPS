import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type JSX, type RefObject } from 'react';
import { loadImage, type Origin } from '../data/loader';
import { CoordBadge, DangerProfile, formatLatLon, profileSentence } from '../components/DangerProfile';
import { ScreenHead } from '../components/ScreenHead';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { Loading } from '../components/Loading';
import type { ExploreLayer } from '../components/ExploreRegion';

const ExploreRegion = lazy(() => import('../components/ExploreRegion'));
import { useApp, useRegion, type CoreData } from '../store';
import type { Region } from '../types/contract';

const R_MOON = 1737400;

function rhoForLat(latDeg: number): number {
  return 2 * R_MOON * Math.tan(((90 + latDeg) * Math.PI) / 360);
}

interface Extent {
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface TileBox extends Rect {
  r: Region;
}

interface LabelBox extends Rect {
  id: string;
  /** Leader line from the tile edge to the label, when the label had to move away. */
  leader: [number, number, number, number] | null;
}

interface Layout {
  extent: Extent;
  pxPerM: number;
  tiles: TileBox[];
  labels: LabelBox[];
}

/** A backdrop is only meaningful when it comes from the same source (real vs mock) as the regions. */
function usableOverview(core: CoreData): CoreData['overview'] {
  return core.overview && core.overview.origin === core.regionsOrigin ? core.overview : null;
}

/**
 * Frame: the bounding box of every region tile plus the pole, padded, then widened to the canvas aspect.
 * This keeps the view on roughly 84–90°S where the candidates actually are, instead of a pole-centred square.
 */
function frameExtent(regions: Region[], w: number, h: number): Extent {
  let xmin = 0;
  let xmax = 0;
  let ymin = 0;
  let ymax = 0;
  for (const r of regions) {
    const ext = r.tile.size * r.tile.res_m;
    xmin = Math.min(xmin, r.tile.origin_x);
    xmax = Math.max(xmax, r.tile.origin_x + ext);
    ymin = Math.min(ymin, r.tile.origin_y - ext);
    ymax = Math.max(ymax, r.tile.origin_y);
  }
  const span = Math.max(xmax - xmin, ymax - ymin, 60000);
  const padX = span * 0.2; // room for labels left and right
  const padY = span * 0.09;
  xmin -= padX;
  xmax += padX;
  ymin -= padY;
  ymax += padY;
  const cx = (xmin + xmax) / 2;
  const cy = (ymin + ymax) / 2;
  let sx = xmax - xmin;
  let sy = ymax - ymin;
  const aspect = w / Math.max(h, 1);
  if (sx / sy < aspect) sx = sy * aspect;
  else sy = sx / aspect;
  return { xmin: cx - sx / 2, xmax: cx + sx / 2, ymin: cy - sy / 2, ymax: cy + sy / 2 };
}

const LABEL_FONT = '600 14px "IBM Plex Sans", system-ui, sans-serif';
const LABEL_H = 26;
let measureCtx: CanvasRenderingContext2D | null = null;

function textWidth(text: string): number {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * 8;
  measureCtx.font = LABEL_FONT;
  return measureCtx.measureText(text).width;
}

function overlapArea(a: Rect, b: Rect): number {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return x * y;
}

function computeLayout(regions: Region[], w: number, h: number): Layout {
  const extent = frameExtent(regions, w, h);
  const pxPerM = w / (extent.xmax - extent.xmin);
  const toPx = (x: number, y: number): [number, number] => [(x - extent.xmin) * pxPerM, (extent.ymax - y) * pxPerM];
  const tiles: TileBox[] = regions.map((r: Region): TileBox => {
    const [x, y] = toPx(r.tile.origin_x, r.tile.origin_y);
    const s = r.tile.size * r.tile.res_m * pxPerM;
    return { r, x, y, w: s, h: s };
  });
  const obstacles: Rect[] = tiles.map((t: TileBox): Rect => ({ x: t.x - 3, y: t.y - 3, w: t.w + 6, h: t.h + 6 }));
  // South Pole marker and its label are obstacles too.
  const [px, py] = toPx(0, 0);
  obstacles.push({ x: px - 8, y: py - 8, w: 96, h: 30 });

  const labels: LabelBox[] = [];
  // Lay out labels in a stable order (top to bottom) so they don't jump when the selection changes.
  const order = [...tiles].sort((a: TileBox, b: TileBox): number => a.y - b.y || a.x - b.x);
  for (const t of order) {
    const lw = Math.ceil(textWidth(t.r.name)) + 16;
    const midY = t.y + t.h / 2 - LABEL_H / 2;
    const cands: { x: number; y: number; far: boolean }[] = [];
    for (const gap of [6, 22, 44]) {
      const far = gap > 6;
      cands.push(
        { x: t.x + t.w + gap, y: midY, far },
        { x: t.x - lw - gap, y: midY, far },
        { x: t.x + t.w / 2 - lw / 2, y: t.y + t.h + gap, far },
        { x: t.x + t.w / 2 - lw / 2, y: t.y - LABEL_H - gap, far },
        { x: t.x + t.w + gap, y: t.y + t.h + gap * 0.4, far },
        { x: t.x + t.w + gap, y: t.y - LABEL_H - gap * 0.4, far },
        { x: t.x - lw - gap, y: t.y + t.h + gap * 0.4, far },
        { x: t.x - lw - gap, y: t.y - LABEL_H - gap * 0.4, far },
      );
    }
    let best: { x: number; y: number; far: boolean } | null = null;
    let bestCost = Infinity;
    for (const c of cands) {
      const rect: Rect = { x: c.x, y: c.y, w: lw, h: LABEL_H };
      if (c.x < 4 || c.y < 4 || c.x + lw > w - 4 || c.y + LABEL_H > h - 4) continue;
      let cost = 0;
      for (const o of obstacles) cost += overlapArea(rect, o);
      for (const l of labels) cost += overlapArea(rect, l) * 2;
      if (cost === 0) {
        best = c;
        break;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = c;
      }
    }
    const spot = best ?? {
      x: Math.min(Math.max(t.x + t.w + 6, 4), w - lw - 4),
      y: Math.min(Math.max(midY, 4), h - LABEL_H - 4),
      far: false,
    };
    let leader: LabelBox['leader'] = null;
    if (spot.far) {
      const lcx = Math.min(Math.max(t.x + t.w / 2, spot.x), spot.x + lw);
      const lcy = Math.min(Math.max(t.y + t.h / 2, spot.y), spot.y + LABEL_H);
      const tcx = Math.min(Math.max(lcx, t.x), t.x + t.w);
      const tcy = Math.min(Math.max(lcy, t.y), t.y + t.h);
      leader = [tcx, tcy, lcx, lcy];
    }
    labels.push({ id: t.r.id, x: spot.x, y: spot.y, w: lw, h: LABEL_H, leader });
  }
  return { extent, pxPerM, tiles, labels };
}

function useBox(ref: RefObject<HTMLDivElement | null>): { w: number; h: number } {
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 800, h: 600 });
  useEffect((): (() => void) | void => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries: ResizeObserverEntry[]): void => {
      const r = entries[0]?.contentRect;
      if (r && r.width > 0 && r.height > 0) setBox({ w: Math.floor(r.width), h: Math.floor(r.height) });
    });
    ro.observe(el);
    return (): void => ro.disconnect();
  }, [ref]);
  return box;
}

function useFontsReady(): boolean {
  const [ready, setReady] = useState<boolean>(false);
  useEffect((): void => {
    document.fonts.ready.then((): void => setReady(true)).catch((): void => setReady(true));
  }, []);
  return ready;
}

function PoleMap({
  core,
  selected,
  onSelect,
  onOpen,
}: {
  core: CoreData;
  selected: string;
  onSelect: (id: string) => void;
  /** Clicking a region square opens it in 3D. */
  onOpen: (id: string) => void;
}): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { w, h } = useBox(wrapRef);
  const fontsReady = useFontsReady();
  const [images, setImages] = useState<Map<string, HTMLImageElement>>(new Map());
  const [hover, setHover] = useState<string | null>(null);
  const layout = useMemo((): Layout => computeLayout(core.regions, w, h), [core.regions, w, h, fontsReady]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect((): (() => void) => {
    let alive = true;
    const want: { key: string; path: string; origin: Origin }[] = core.regions.map((r: Region) => ({
      key: r.id,
      path: r.hillshade,
      origin: core.regionsOrigin,
    }));
    const ov = usableOverview(core);
    if (ov) want.push({ key: '__overview', path: ov.file.hillshade, origin: ov.origin });
    want.forEach((it): void => {
      loadImage(it.path, it.origin)
        .then((img: HTMLImageElement): void => {
          if (alive) setImages((prev: Map<string, HTMLImageElement>) => new Map(prev).set(it.key, img));
        })
        .catch((): void => undefined);
    });
    return (): void => {
      alive = false;
    };
  }, [core]);

  useEffect((): void => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const { extent, pxPerM, tiles, labels } = layout;
    const toPx = (x: number, y: number): [number, number] => [(x - extent.xmin) * pxPerM, (extent.ymax - y) * pxPerM];
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0d0f13';
    ctx.fillRect(0, 0, w, h);

    const ovImg = images.get('__overview');
    const ovFile = usableOverview(core);
    if (ovImg && ovFile) {
      const [xmin, xmax, ymin, ymax] = ovFile.file.extent_m;
      const [ax, ay] = toPx(xmin, ymax);
      const [bx, by] = toPx(xmax, ymin);
      ctx.globalAlpha = 0.45;
      ctx.drawImage(ovImg, ax, ay, bx - ax, by - ay);
      ctx.globalAlpha = 1;
    }

    // Graticule: latitude rings every degree, longitude spokes every 30°.
    const [cx, cy] = toPx(0, 0);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(237, 234, 228, 0.09)';
    const maxR = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
    const tileRects: Rect[] = tiles.map((t: TileBox): Rect => ({ x: t.x - 4, y: t.y - 4, w: t.w + 8, h: t.h + 8 }));
    const placed: Rect[] = [...tileRects, ...labels];
    ctx.font = '12px "IBM Plex Mono", ui-monospace, monospace';
    const rings: { lat: number; r: number }[] = [];
    for (let lat = -89; lat <= -80; lat++) {
      const r = rhoForLat(lat) * pxPerM;
      if (r > maxR) break;
      rings.push({ lat, r });
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Ring labels sit on one shared bearing (between two spokes), chosen where most of them fit clear.
    const ringRect = (r: number, deg: number, tw: number): Rect => {
      const a = (deg * Math.PI) / 180;
      return { x: cx + Math.sin(a) * r - tw / 2, y: cy - Math.cos(a) * r - 8, w: tw, h: 16 };
    };
    const fits = (rect: Rect, taken: Rect[]): boolean =>
      rect.x >= 6 &&
      rect.y >= 6 &&
      rect.x + rect.w <= w - 6 &&
      rect.y + rect.h <= h - 6 &&
      !taken.some((p: Rect): boolean => overlapArea(rect, p) > 0);
    let bestDeg = 195;
    let bestCount = -1;
    for (const deg of [195, 165, 225, 135, 255, 105, 285, 75, 315, 45, 345, 15]) {
      const taken = [...placed];
      let count = 0;
      for (const ring of rings) {
        const rect = ringRect(ring.r, deg, ctx.measureText(`${Math.abs(ring.lat)}°S`).width + 6);
        if (fits(rect, taken)) {
          taken.push(rect);
          count++;
        }
      }
      if (count > bestCount) {
        bestCount = count;
        bestDeg = deg;
      }
    }
    for (const ring of rings) {
      const text = `${Math.abs(ring.lat)}°S`;
      const rect = ringRect(ring.r, bestDeg, ctx.measureText(text).width + 6);
      if (!fits(rect, placed)) continue;
      placed.push(rect);
      ctx.fillStyle = '#0d0f13';
      ctx.fillRect(rect.x, rect.y, rect.w, 16);
      ctx.fillStyle = 'rgba(185, 181, 174, 0.75)';
      ctx.fillText(text, rect.x + 3, rect.y + 12);
    }
    for (let lon = 0; lon < 360; lon += 30) {
      const a = (lon * Math.PI) / 180;
      const dx = Math.sin(a);
      const dy = -Math.cos(a);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + dx * maxR, cy + dy * maxR);
      ctx.stroke();
      // Label where the spoke leaves the frame (inset).
      const inset = 16;
      const tx = dx > 0 ? (w - inset - cx) / dx : dx < 0 ? (inset - cx) / dx : Infinity;
      const ty = dy > 0 ? (h - inset - cy) / dy : dy < 0 ? (inset - cy) / dy : Infinity;
      const t = Math.min(tx, ty);
      if (!Number.isFinite(t) || t <= 0) continue;
      const lab = lon === 0 ? '0°' : lon === 180 ? '180°' : lon < 180 ? `${lon}°E` : `${360 - lon}°W`;
      const tw = ctx.measureText(lab).width + 6;
      const lx = Math.min(Math.max(cx + dx * t - tw / 2, 4), w - tw - 4);
      const ly = Math.min(Math.max(cy + dy * t - 8, 4), h - 20);
      const rect: Rect = { x: lx, y: ly, w: tw, h: 16 };
      if (placed.some((p: Rect): boolean => overlapArea(rect, p) > 0)) continue;
      placed.push(rect);
      ctx.fillStyle = '#0d0f13';
      ctx.fillRect(lx, ly, tw, 16);
      ctx.fillStyle = 'rgba(185, 181, 174, 0.75)';
      ctx.fillText(lab, lx + 3, ly + 12);
    }
    // Pole
    if (cx > -10 && cx < w + 10 && cy > -10 && cy < h + 10) {
      ctx.strokeStyle = '#edeae4';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx - 5, cy);
      ctx.lineTo(cx + 5, cy);
      ctx.moveTo(cx, cy - 5);
      ctx.lineTo(cx, cy + 5);
      ctx.stroke();
      ctx.fillStyle = '#b9b5ae';
      ctx.font = '12px "IBM Plex Sans", system-ui, sans-serif';
      ctx.fillText('South Pole', cx + 9, cy + 16);
    }

    // Leader lines for displaced labels
    ctx.strokeStyle = 'rgba(237, 234, 228, 0.45)';
    ctx.lineWidth = 1;
    for (const l of labels) {
      if (!l.leader) continue;
      ctx.beginPath();
      ctx.moveTo(l.leader[0], l.leader[1]);
      ctx.lineTo(l.leader[2], l.leader[3]);
      ctx.stroke();
    }

    // Region tiles at true scale; selected last so its outline sits on top.
    const ordered = [...tiles].sort((a: TileBox, b: TileBox): number => (a.r.id === selected ? 1 : b.r.id === selected ? -1 : 0));
    for (const t of ordered) {
      const img = images.get(t.r.id);
      if (img) ctx.drawImage(img, t.x, t.y, t.w, t.h);
      else {
        ctx.fillStyle = '#23272e';
        ctx.fillRect(t.x, t.y, t.w, t.h);
      }
      const isSel = t.r.id === selected;
      const isHover = t.r.id === hover;
      if (t.r.coord_quality === 'traced_approx') ctx.setLineDash([4, 3]);
      if (isSel) {
        ctx.lineWidth = 5;
        ctx.strokeStyle = '#0a0b0e';
        ctx.strokeRect(t.x - 1.5, t.y - 1.5, t.w + 3, t.h + 3);
      }
      ctx.lineWidth = isSel ? 2 : isHover ? 1.5 : 1;
      ctx.strokeStyle = isSel || isHover ? '#edeae4' : 'rgba(237, 234, 228, 0.55)';
      ctx.strokeRect(isSel ? t.x - 1.5 : t.x, isSel ? t.y - 1.5 : t.y, isSel ? t.w + 3 : t.w, isSel ? t.h + 3 : t.h);
      ctx.setLineDash([]);
    }
  }, [w, h, images, selected, hover, layout, core]);

  const byId = new Map(layout.labels.map((l: LabelBox): [string, LabelBox] => [l.id, l]));

  return (
    <div ref={wrapRef} className="pole-map">
      <canvas ref={canvasRef} className="pole-canvas" aria-hidden="true" />
      {layout.tiles.map((t: TileBox) => {
        const pad = Math.max(0, (28 - t.w) / 2);
        return (
          <div
            key={`hit-${t.r.id}`}
            className="tile-hit"
            aria-hidden="true"
            style={{ left: t.x - pad, top: t.y - pad, width: t.w + pad * 2, height: t.h + pad * 2 }}
            onClick={(): void => onOpen(t.r.id)}
            title={`Explore ${t.r.name} in 3D`}
            onMouseEnter={(): void => setHover(t.r.id)}
            onMouseLeave={(): void => setHover(null)}
          />
        );
      })}
      <div className="map-labels" role="group" aria-label="Candidate regions on the south-pole map">
        {core.regions.map((r: Region) => {
          const l = byId.get(r.id);
          if (!l) return null;
          return (
            <button
              key={r.id}
              type="button"
              className="map-label"
              aria-pressed={r.id === selected}
              style={{ left: l.x, top: l.y, width: l.w }}
              onClick={(): void => onSelect(r.id)}
              onMouseEnter={(): void => setHover(r.id)}
              onMouseLeave={(): void => setHover(null)}
              onFocus={(): void => setHover(r.id)}
              onBlur={(): void => setHover(null)}
            >
              {r.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function sumScore(r: Region): number {
  return r.hazards.shadow.score + r.hazards.rim.score + r.hazards.texture.score;
}

function countLevel(r: Region, level: 'high' | 'low'): number {
  return (['shadow', 'rim', 'texture'] as const).filter((h): boolean => r.hazards[h].level === level).length;
}

function overviewResult(regions: Region[]): string {
  if (regions.length === 0) return 'No regions loaded.';
  const sorted = [...regions].sort((a: Region, b: Region): number => sumScore(b) - sumScore(a));
  const hardest = sorted[0];
  const easiest = sorted[sorted.length - 1];
  const of3 = (n: number): string => (n === 3 ? 'all 3' : `${n} of 3`);
  return `${hardest.name} is high-danger on ${of3(countLevel(hardest, 'high'))} hazards; ${easiest.name} is low on ${of3(countLevel(easiest, 'low'))}`;
}

export function MoonOverview(): JSX.Element {
  const core = useApp((s) => s.core) as CoreData;
  const regionId = useApp((s) => s.regionId);
  const setRegion = useApp((s) => s.setRegion);
  const setScreen = useApp((s) => s.setScreen);
  const region = useRegion();
  const [view, setView] = useState<'map' | '3d'>('map');
  const [layers, setLayers] = useState<Set<ExploreLayer>>(new Set<ExploreLayer>(['shadow']));
  const [available, setAvailable] = useState<ExploreLayer[]>([]);
  const toggleLayer = useCallback((l: ExploreLayer): void => {
    setLayers((prev: Set<ExploreLayer>): Set<ExploreLayer> => {
      const next = new Set(prev);
      if (next.has(l)) next.delete(l);
      else next.add(l);
      return next;
    });
  }, []);
  const openRegion = useCallback(
    (id: string): void => {
      setRegion(id);
      setView('3d');
    },
    [setRegion],
  );
  const ovNote = usableOverview(core)?.file.note;

  return (
    <div>
      <ScreenHead
        kicker="Moon danger profiles · 9 candidate regions"
        result={overviewResult(core.regions)}
        method={
          <>
            <p>
              Each region is a 15 × 15 km tile of the 20 m LOLA elevation model, resampled to 30 m. For each hazard we measure the terrain
              directly: cast shadow at 1°, 3° and 5° sun; height jumps along 1 km tracks in 16 directions; camera keypoints on a low-sun
              hillshade; slope at a 30 m baseline.
            </p>
            <p>
              The danger level is the tercile of a score that combines a hazard’s metrics, ranked across the nine regions. It says how a
              region compares with the other eight, not whether it is safe.
            </p>
          </>
        }
      />
      <div className="moon-layout">
        <div className="moon-map-col">
          {view === '3d' && region ? (
            <ErrorBoundary name={`Explore ${region.name} in 3D`} resetKey={region.id}>
              <Suspense
                fallback={
                  <div className="x3d">
                    <Loading label="Loading the 3D view…" />
                  </div>
                }
              >
                <ExploreRegion
                  region={region}
                  origin={core.regionsOrigin}
                  layers={layers}
                  onToggle={toggleLayer}
                  onAvailable={setAvailable}
                  onClose={(): void => setView('map')}
                />
              </Suspense>
            </ErrorBoundary>
          ) : (
            <PoleMap core={core} selected={regionId} onSelect={setRegion} onOpen={openRegion} />
          )}
          {view === '3d' ? (
            <p className="map-caption">
              Drag to orbit. Click a danger row on the right to turn its layer on. Shadows are precomputed masks from the elevation model;
              slope classes and the safest patch use illustrative thresholds, not mission rules.
            </p>
          ) : (
            <p className="map-caption">
              South-polar stereographic, 0° longitude up. Each square is a 15 × 15 km analysis tile at true scale, shaded from our own
              hillshade. Dashed outline: approximate location.
              {ovNote ? ` Backdrop: ${ovNote}` : ''}
            </p>
          )}
        </div>
        <aside className="panel panel-pad region-panel">
          <div className="region-list" role="group" aria-label="Choose a region">
            {core.regions.map((r: Region) => (
              <button
                key={r.id}
                type="button"
                className="region-btn"
                aria-pressed={r.id === regionId}
                onClick={(): void => setRegion(r.id)}
              >
                {r.name}
              </button>
            ))}
          </div>
          {region && (
            <>
              <div className="region-title">
                <h2>{region.name}</h2>
                <div className="chip-row">
                  <CoordBadge region={region} />
                  <span className="chip mono">{formatLatLon(region.lat, region.lon)}</span>
                </div>
                <p className="region-sentence">{profileSentence(region)}</p>
              </div>
              <DangerProfile
                region={region}
                regions={core.regions}
                activeLayers={view === '3d' ? layers : undefined}
                onRowActivate={(id): void => {
                  if (view !== '3d') return;
                  const l: ExploreLayer = id;
                  if (available.includes(l) && !layers.has(l)) toggleLayer(l);
                }}
              />
              <details className="method">
                <summary>Sun and data quality here</summary>
                <div className="method-body">
                  <p>
                    Sun elevation here ranges from {region.sun.el_min.toFixed(1)}° to {region.sun.el_max.toFixed(1)}° ({region.sun.note}).
                    Elevation-model error (median) {region.uncertainty.dem_err_p50_m.toFixed(1)} m.
                    {region.illumination && typeof region.illumination.pgda_avg_visibility === 'number'
                      ? ` Long-term average sun visibility (NASA PGDA): ${(region.illumination.pgda_avg_visibility * 100).toFixed(0)}%.`
                      : ''}
                  </p>
                </div>
              </details>
              <div className="panel-actions">
                <button type="button" className="btn btn-primary" onClick={(): void => setScreen('region')}>
                  Find Earth sites for {region.name} →
                </button>
                <button type="button" className="btn" onClick={(): void => setView(view === '3d' ? 'map' : '3d')}>
                  {view === '3d' ? 'Back to the map' : 'Explore in 3D'}
                </button>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
