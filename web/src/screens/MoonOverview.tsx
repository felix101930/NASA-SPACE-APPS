import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { loadImage, type Origin } from '../data/loader';
import { CoordBadge, DangerProfile } from '../components/DangerProfile';
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

/** A backdrop is only meaningful when it comes from the same source (real vs mock) as the regions. */
function usableOverview(core: CoreData): CoreData['overview'] {
  return core.overview && core.overview.origin === core.regionsOrigin ? core.overview : null;
}

function computeExtent(core: CoreData): Extent {
  // Square view centred on the pole that always contains every region tile (plus the backdrop, if any).
  let m = 40000;
  for (const r of core.regions) {
    const half = (r.tile.size * r.tile.res_m) / 2;
    m = Math.max(m, Math.abs(r.x_m) + half + 25000, Math.abs(r.y_m) + half + 25000);
  }
  const ov = usableOverview(core);
  if (ov) {
    const [xmin, xmax, ymin, ymax] = ov.file.extent_m;
    m = Math.max(m, Math.abs(xmin), Math.abs(xmax), Math.abs(ymin), Math.abs(ymax));
  }
  return { xmin: -m, xmax: m, ymin: -m, ymax: m };
}

function useSize(ref: React.RefObject<HTMLDivElement | null>): number {
  const [size, setSize] = useState<number>(600);
  useEffect((): (() => void) | void => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries: ResizeObserverEntry[]): void => {
      const box = entries[0]?.contentRect;
      if (box) setSize(Math.floor(Math.min(box.width, box.height)));
    });
    ro.observe(el);
    return (): void => ro.disconnect();
  }, [ref]);
  return size;
}

function PoleMap({ core, selected, onSelect }: { core: CoreData; selected: string; onSelect: (id: string) => void }): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = useSize(wrapRef);
  const extent = useMemo((): Extent => computeExtent(core), [core]);
  const [images, setImages] = useState<Map<string, HTMLImageElement>>(new Map());
  const [hover, setHover] = useState<string | null>(null);

  useEffect((): (() => void) => {
    let alive = true;
    const want: { key: string; path: string; origin: Origin }[] = core.regions.map((r: Region) => ({ key: r.id, path: r.hillshade, origin: core.regionsOrigin }));
    const ov = usableOverview(core);
    if (ov) want.push({ key: '__overview', path: ov.file.hillshade, origin: ov.origin });
    want.forEach((w): void => {
      loadImage(w.path, w.origin)
        .then((img: HTMLImageElement): void => {
          if (alive) setImages((prev: Map<string, HTMLImageElement>) => new Map(prev).set(w.key, img));
        })
        .catch((): void => undefined);
    });
    return (): void => {
      alive = false;
    };
  }, [core]);

  const toPx = (x: number, y: number): [number, number] => [
    ((x - extent.xmin) / (extent.xmax - extent.xmin)) * size,
    ((extent.ymax - y) / (extent.ymax - extent.ymin)) * size,
  ];

  useEffect((): void => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = size * dpr;
    cv.height = size * dpr;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#050608';
    ctx.fillRect(0, 0, size, size);
    const ovImg = images.get('__overview');
    const ovFile = usableOverview(core);
    if (ovImg && ovFile) {
      const [xmin, xmax, ymin, ymax] = ovFile.file.extent_m;
      const [ax, ay] = toPx(xmin, ymax);
      const [bx, by] = toPx(xmax, ymin);
      ctx.globalAlpha = 0.5;
      ctx.drawImage(ovImg, ax, ay, bx - ax, by - ay);
      ctx.globalAlpha = 1;
    }
    // graticule
    const [cx, cy] = toPx(0, 0);
    ctx.strokeStyle = 'rgba(236,231,222,0.16)';
    ctx.fillStyle = 'rgba(236,231,222,0.55)';
    ctx.font = '11px "IBM Plex Mono", monospace';
    ctx.lineWidth = 1;
    const pxPerM = size / (extent.xmax - extent.xmin);
    for (let lat = -89; lat <= -75; lat++) {
      const r = rhoForLat(lat) * pxPerM;
      if (r > size) break;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillText(`${Math.abs(lat)}°S`, cx + 4, cy + r - 4);
    }
    for (let lon = 0; lon < 360; lon += 30) {
      const a = (lon * Math.PI) / 180;
      const far = size;
      const [ex, ey] = [cx + Math.sin(a) * far, cy - Math.cos(a) * far];
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      const lab = lon === 0 ? '0°' : lon === 180 ? '180°' : lon < 180 ? `${lon}°E` : `${360 - lon}°W`;
      const lr = size * 0.46;
      ctx.fillText(lab, cx + Math.sin(a) * lr - 12, cy - Math.cos(a) * lr + 4);
    }
    ctx.fillStyle = '#ece7de';
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText('South Pole', cx + 6, cy + 14);

    // region tiles at true scale
    const placed: [number, number, number, number][] = [];
    const tiles: { r: Region; x0: number; y0: number; w: number }[] = [];
    for (const r of core.regions) {
      const ext = r.tile.size * r.tile.res_m;
      const [x0, y0] = toPx(r.tile.origin_x, r.tile.origin_y);
      const w = ext * pxPerM;
      tiles.push({ r, x0, y0, w });
      placed.push([x0, y0, w, w]);
      const img = images.get(r.id);
      if (img) ctx.drawImage(img, x0, y0, w, w);
      const isSel = r.id === selected;
      const isHover = r.id === hover;
      ctx.lineWidth = isSel ? 2.5 : 1;
      ctx.strokeStyle = isSel ? '#f3b54a' : isHover ? '#ece7de' : 'rgba(236,231,222,0.6)';
      if (r.coord_quality === 'traced_approx') ctx.setLineDash([4, 3]);
      ctx.strokeRect(x0, y0, w, w);
      ctx.setLineDash([]);
    }
    // labels with simple collision avoidance (selected first so it gets the best spot)
    const overlaps = (a: [number, number, number, number]): boolean =>
      placed.some((b: [number, number, number, number]): boolean => a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1]);
    const order = [...tiles].sort((a, b): number => (a.r.id === selected ? -1 : b.r.id === selected ? 1 : 0));
    for (const { r, x0, y0, w } of order) {
      const isSel = r.id === selected;
      ctx.font = `${isSel ? 600 : 500} 12.5px "IBM Plex Sans", sans-serif`;
      const tw = ctx.measureText(r.name).width + 6;
      const h = 17;
      const cands: [number, number][] = [
        [x0 + w + 5, y0 + w / 2 - h / 2],
        [x0 - tw - 5, y0 + w / 2 - h / 2],
        [x0 + w / 2 - tw / 2, y0 + w + 4],
        [x0 + w / 2 - tw / 2, y0 - h - 4],
        [x0 + w + 5, y0 + w / 2 + h * 0.7],
        [x0 + w + 5, y0 + w / 2 - h * 1.7],
        [x0 - tw - 5, y0 + w / 2 + h * 0.7],
        [x0 - tw - 5, y0 + w / 2 - h * 1.7],
      ];
      let spot = cands[0];
      for (const c of cands) {
        const rect: [number, number, number, number] = [c[0], c[1], tw, h];
        if (c[0] >= 2 && c[0] + tw <= size - 2 && c[1] >= 2 && c[1] + h <= size - 2 && !overlaps(rect)) {
          spot = c;
          break;
        }
      }
      placed.push([spot[0], spot[1], tw, h]);
      ctx.fillStyle = 'rgba(5,6,8,0.82)';
      ctx.fillRect(spot[0], spot[1], tw, h);
      ctx.fillStyle = isSel ? '#f3b54a' : '#ece7de';
      ctx.fillText(r.name, spot[0] + 3, spot[1] + 12.5);
    }
  }, [size, images, selected, hover, extent, core]);

  const pick = (e: React.MouseEvent<HTMLCanvasElement>): string | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * size;
    const my = ((e.clientY - rect.top) / rect.height) * size;
    let best: string | null = null;
    let bd = 26;
    for (const r of core.regions) {
      const [px, py] = toPx(r.x_m, r.y_m);
      const d = Math.hypot(px - mx, py - my);
      if (d < bd) {
        bd = d;
        best = r.id;
      }
    }
    return best;
  };

  return (
    <div ref={wrapRef} className="moon-canvas-wrap panel">
      <canvas
        ref={canvasRef}
        style={{ width: size, height: size, margin: '0 auto' }}
        role="img"
        aria-label="South-pole map with the nine candidate regions drawn at true scale. Use the region buttons to select."
        onClick={(e): void => {
          const id = pick(e);
          if (id) onSelect(id);
        }}
        onMouseMove={(e): void => setHover(pick(e))}
        onMouseLeave={(): void => setHover(null)}
      />
      <div className="map-legend">
        South-polar stereographic, north (0°) up. Each square is a 15 × 15 km analysis tile drawn at true scale, shaded
        from our own hillshade. Dashed = approximate location.
        {usableOverview(core)?.file.note ? <div className="faint">Backdrop: {usableOverview(core)?.file.note}</div> : null}
      </div>
    </div>
  );
}

export function MoonOverview(): JSX.Element {
  const core = useApp((s) => s.core) as CoreData;
  const regionId = useApp((s) => s.regionId);
  const setRegion = useApp((s) => s.setRegion);
  const setScreen = useApp((s) => s.setScreen);
  const region = useRegion();

  return (
    <div>
      <div className="screen-head">
        <div>
          <h1>Nine candidate regions, four dangers</h1>
          <p>
            NASA’s candidate landing regions near the lunar south pole, profiled for the hazards behind real failures.
            Pick a region on the map or in the list.
          </p>
        </div>
      </div>
      <div className="moon-layout">
        <PoleMap core={core} selected={regionId} onSelect={setRegion} />
        <aside className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div className="region-list" role="group" aria-label="Choose a region">
            {core.regions.map((r: Region) => (
              <button key={r.id} className="region-btn" aria-pressed={r.id === regionId} onClick={(): void => setRegion(r.id)}>
                {r.name}
              </button>
            ))}
          </div>
          {region && (
            <>
              <div>
                <h2 style={{ fontSize: 24 }}>{region.name}</h2>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
                  <CoordBadge region={region} />
                  <span className="chip num">
                    {Math.abs(region.lat).toFixed(2)}°S {region.lon >= 0 ? `${region.lon.toFixed(1)}°E` : `${Math.abs(region.lon).toFixed(1)}°W`}
                  </span>
                </div>
                <p className="muted" style={{ marginTop: 10, fontSize: 14 }}>
                  Sun elevation here ranges from <span className="num">{region.sun.el_min.toFixed(1)}°</span> to{' '}
                  <span className="num">{region.sun.el_max.toFixed(1)}°</span> ({region.sun.note}). Elevation-model error
                  (median) <span className="num">{region.uncertainty.dem_err_p50_m.toFixed(1)} m</span>.
                  {region.illumination && typeof region.illumination.pgda_avg_visibility === 'number' && (
                    <>
                      {' '}
                      Long-term average sun visibility (NASA PGDA):{' '}
                      <span className="num">{(region.illumination.pgda_avg_visibility * 100).toFixed(0)}%</span>.
                    </>
                  )}
                </p>
              </div>
              <DangerProfile region={region} />
              <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={(): void => setScreen('region')}>
                Find Earth sites for {region.name} →
              </button>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
