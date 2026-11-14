import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Line, OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import { loadImage, type Origin } from '../data/loader';
import { loadTile, type LoadedTile } from '../data/tiles';
import { computeShadowMask, mapToPixel, type Grid } from '../lib/terrain';
import { HAZARDS } from '../content';
import { matchesFor, useApp, useRegion, type CoreData, type ShadowMode } from '../store';
import type { EarthSite, Match, Region, ShadowMask, TileRef } from '../types/contract';
import { Loading } from '../components/Loading';
import { TERRAIN_KM, terrainHeightAt as heightAt, useTerrainGeometry } from '../components/terrainGeometry';
import { SunGlyph } from '../components/Glyphs';
import { ScreenHead } from '../components/ScreenHead';

// ------------------------------------------------------------------------------------------------
// Camera sync between the two canvases (shared mutable state, not React state, to avoid re-renders)
// ------------------------------------------------------------------------------------------------

const sync = { pos: new THREE.Vector3(0, 17, 19), target: new THREE.Vector3(0, 0, 0), version: 0, source: '' };

function SyncedControls({ id }: { id: string }): JSX.Element {
  const ref = useRef<OrbitControlsImpl>(null);
  const camera = useThree((s) => s.camera);
  const seen = useRef<number>(-1);
  const applying = useRef<boolean>(false);
  useFrame((): void => {
    const c = ref.current;
    if (!c || sync.version === seen.current) return;
    seen.current = sync.version;
    if (sync.source === id) return;
    applying.current = true;
    camera.position.copy(sync.pos);
    c.target.copy(sync.target);
    c.update();
    applying.current = false;
  });
  return (
    <OrbitControls
      ref={ref}
      makeDefault
      enableDamping={false}
      maxPolarAngle={Math.PI / 2.05}
      minDistance={3}
      maxDistance={60}
      onChange={(): void => {
        const c = ref.current;
        if (!c || applying.current) return;
        sync.pos.copy(camera.position);
        sync.target.copy(c.target);
        sync.version++;
        sync.source = id;
        seen.current = sync.version;
      }}
    />
  );
}

// ------------------------------------------------------------------------------------------------
// Terrain mesh
// ------------------------------------------------------------------------------------------------

const KM = TERRAIN_KM;

function TerrainMesh({
  tile,
  exag,
  map,
  shadows,
}: {
  tile: LoadedTile;
  exag: number;
  map: THREE.Texture | null;
  shadows: boolean;
}): JSX.Element {
  const geom = useTerrainGeometry(tile, exag);
  return (
    <mesh geometry={geom} castShadow={shadows} receiveShadow={shadows}>
      <meshStandardMaterial key={map ? map.uuid : 'plain'} color="#c4beb3" roughness={0.97} metalness={0} map={map} />
    </mesh>
  );
}

function PathLine({
  tile,
  exag,
  pixels,
  color,
}: {
  tile: LoadedTile;
  exag: number;
  pixels: [number, number][];
  color: string;
}): JSX.Element | null {
  const pts = useMemo((): [number, number, number][] => {
    const n = tile.filled.size;
    const W = n * tile.filled.res * KM;
    const out: [number, number, number][] = [];
    for (let i = 0; i < pixels.length - 1; i++) {
      const [c0, r0] = pixels[i];
      const [c1, r1] = pixels[i + 1];
      const steps = Math.max(2, Math.ceil(Math.hypot(c1 - c0, r1 - r0)));
      for (let s = 0; s <= steps; s++) {
        const c = c0 + ((c1 - c0) * s) / steps;
        const r = r0 + ((r1 - r0) * s) / steps;
        out.push([(c / (n - 1) - 0.5) * W, heightAt(tile, c, r, exag) + 0.04, (r / (n - 1) - 0.5) * W]);
      }
    }
    return out;
  }, [tile, exag, pixels]);
  if (pts.length < 2) return null;
  return <Line points={pts} color={color} lineWidth={4} />;
}

function Sun({ el, az, shadows, extent }: { el: number; az: number; shadows: boolean; extent: number }): JSX.Element {
  const light = useRef<THREE.DirectionalLight>(null);
  const { scene } = useThree();
  useEffect((): void => {
    const l = light.current;
    if (!l) return;
    const e = (el * Math.PI) / 180;
    const a = (az * Math.PI) / 180;
    const dist = 40;
    // azimuth clockwise from grid +y (north, = -z here); east = +x
    l.position.set(Math.sin(a) * Math.cos(e) * dist, Math.sin(e) * dist, -Math.cos(a) * Math.cos(e) * dist);
    l.target.position.set(0, 0, 0);
    if (!l.target.parent) scene.add(l.target);
    const half = extent * 0.72 + 0.3; // half-diagonal of the tile plus a margin: a tight frustum
    const cam = l.shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = 1;
    cam.far = dist * 2;
    cam.updateProjectionMatrix();
    l.shadow.needsUpdate = true;
  }, [el, az, extent, scene]);
  return (
    <directionalLight
      ref={light}
      intensity={3.2}
      castShadow={shadows}
      shadow-mapSize-width={4096}
      shadow-mapSize-height={4096}
      shadow-bias={-0.0004}
      shadow-normalBias={0.03}
    />
  );
}

// ------------------------------------------------------------------------------------------------
// Shadow-mask textures for the fallback mode
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

/**
 * Pipeline mask PNGs are 8-bit grayscale: 255 = cast shadow, 0 = lit, 128 = no data.
 * Decoded into a shading texture: shadow -> black, lit -> white, no data -> mid grey.
 */
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
      const v = d[i] * (d[i + 3] / 255); // treat transparent as 0 (lit)
      const out = v >= 192 ? 0 : v > 64 ? 110 : 255; // >=192 shadow, <=64 lit, else no data
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

interface MaskState {
  texture: THREE.Texture | null;
  note: string;
}

function useMaskTexture(tile: LoadedTile | null, mode: ShadowMode, el: number, az: number, masks: ShadowMask[], origin: Origin): MaskState {
  const [state, setState] = useState<MaskState>({ texture: null, note: '' });
  useEffect((): (() => void) | void => {
    if (!tile || mode !== 'precomputed') {
      setState({ texture: null, note: '' });
      return;
    }
    let alive = true;
    const pick = nearestMask(masks, el, az);
    const fallbackToCpu = (): void => {
      const t = setTimeout((): void => {
        if (!alive) return;
        const m = computeShadowMask(tile.filled, el, az, 400);
        setState({ texture: maskToTexture(m, tile.filled.size), note: `in-browser ray-marched mask at ${el}° / ${az}°` });
      }, 120);
      cleanup.push((): void => clearTimeout(t));
    };
    const cleanup: (() => void)[] = [];
    if (pick) {
      loadImage(pick.path, origin)
        .then((img: HTMLImageElement): void => {
          if (alive)
            setState({
              texture: imageMaskTexture(img, tile.filled.size),
              note: `pipeline mask, nearest to slider: sun ${pick.el}° / ${pick.az}° (grey = no data)`,
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
// Tile loading (cached in data/tiles)
// ------------------------------------------------------------------------------------------------

function useTile(ref: TileRef | null, origin: Origin): { tile: LoadedTile | null; error: string | null } {
  const [tile, setTile] = useState<LoadedTile | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect((): (() => void) | void => {
    if (!ref) return;
    let alive = true;
    setTile(null);
    setError(null);
    loadTile(ref, origin)
      .then((t: LoadedTile): void => {
        if (alive) setTile(t);
      })
      .catch((e: unknown): void => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return (): void => {
      alive = false;
    };
  }, [ref, origin]);
  return { tile, error };
}

// ------------------------------------------------------------------------------------------------
// Shadow share readout: same method on both worlds, true heights, computed in the browser
// ------------------------------------------------------------------------------------------------

const READOUT_STEP = 3; // 30 m tiles -> 90 m samples for the readout

/** Block-mean downsample so the readout ray-march stays fast enough to follow a slider. */
function downsample(g: Grid, f: number): Grid {
  const n = Math.floor(g.size / f);
  const out = new Float32Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      let sum = 0;
      for (let i = 0; i < f; i++) for (let j = 0; j < f; j++) sum += g.data[(r * f + i) * g.size + (c * f + j)];
      out[r * n + c] = sum / (f * f);
    }
  }
  return { data: out, size: n, res: g.res * f };
}

interface ShadowShare {
  el: number;
  az: number;
  frac: number;
}

function useShadowShare(tile: LoadedTile | null, el: number, az: number): ShadowShare | null {
  const small = useMemo((): Grid | null => (tile ? downsample(tile.filled, READOUT_STEP) : null), [tile]);
  const [share, setShare] = useState<ShadowShare | null>(null);
  const smallRef = useRef<Grid | null>(small);
  const pending = useRef<{ el: number; az: number } | null>(null);
  const timer = useRef<number | null>(null);
  const last = useRef<number>(0);
  smallRef.current = small;

  useEffect((): void => {
    setShare(null);
  }, [small]);

  useEffect((): void => {
    if (!small) return;
    pending.current = { el, az };
    if (timer.current !== null) return;
    const wait = Math.max(30, 140 - (performance.now() - last.current));
    timer.current = window.setTimeout((): void => {
      timer.current = null;
      const p = pending.current;
      const g = smallRef.current;
      pending.current = null;
      if (!p || !g) return;
      last.current = performance.now();
      const m = computeShadowMask(g, p.el, p.az, g.size);
      let n = 0;
      for (let i = 0; i < m.length; i++) n += m[i];
      setShare({ el: p.el, az: p.az, frac: n / m.length });
    }, wait);
  }, [small, el, az]);

  useEffect(
    (): (() => void) => (): void => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  return share;
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

// ------------------------------------------------------------------------------------------------
// One pane
// ------------------------------------------------------------------------------------------------

interface PaneProps {
  id: string;
  title: string;
  world: string;
  subtitle: string;
  tile: LoadedTile | null;
  error: string | null;
  tileRef: TileRef;
  origin: Origin;
  masks: ShadowMask[];
  path: ((tile: LoadedTile) => [number, number][]) | null;
  share: ShadowShare | null;
}

function Pane({ id, title, world, subtitle, tile, error, tileRef, origin, masks, path, share }: PaneProps): JSX.Element {
  const exag = useApp((s) => s.exaggeration);
  const el = useApp((s) => s.sunEl);
  const az = useApp((s) => s.sunAz);
  const mode = useApp((s) => s.shadowMode);
  const mask = useMaskTexture(tile, mode, el, az, masks, origin);
  const extent = tileRef.size * tileRef.res_m * KM;
  const realtime = mode === 'realtime';
  const pixels = useMemo((): [number, number][] | null => (tile && path ? path(tile) : null), [tile, path]);

  return (
    <div className="twin-pane">
      {error ? (
        <div className="loading">Could not load terrain: {error}</div>
      ) : !tile ? (
        <Loading label={`Loading ${title} terrain…`} />
      ) : (
        <Canvas
          shadows="percentage"
          dpr={[1, 1.75]}
          camera={{ position: [0, 17, 19], fov: 38, near: 0.05, far: 200 }}
          gl={{ antialias: true }}
        >
          <color attach="background" args={['#1a1d23']} />
          <hemisphereLight args={['#9aa3b5', '#000000', 0.06]} />
          <Sun el={el} az={az} shadows={realtime} extent={extent} />
          <TerrainMesh tile={tile} exag={exag} map={realtime ? null : mask.texture} shadows={realtime} />
          {pixels && <PathLine tile={tile} exag={exag} pixels={pixels} color="#edeae4" />}
          <SyncedControls id={id} />
        </Canvas>
      )}
      <div className="twin-label">
        <span className="twin-tag">
          <strong>{title}</strong> <span className="muted">{subtitle}</span>
        </span>
        {tile && (
          <span className="twin-tag caption" title="Elevation range in the tile">
            Relief {Math.round(tile.stats.max - tile.stats.min).toLocaleString('en-US')} m
            {tile.nanCount > 0 ? ` · ${tile.nanCount} no-data px filled` : ''}
          </span>
        )}
      </div>
      <div className="twin-readout" aria-live="polite">
        <span className="twin-readout-world">{world}</span>
        <span className="twin-readout-big">{share ? pct(share.frac) : '…'}</span>
        <span className="caption">in shadow at {(share?.el ?? el).toFixed(1)}° sun</span>
      </div>
      {!realtime && mask.note && <div className="twin-note caption">Shadows: {mask.note}</div>}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Screen
// ------------------------------------------------------------------------------------------------

function siteOptions(core: CoreData, region: Region, hazardMatches: Match[]): { site: EarthSite; tag: string }[] {
  const top = new Map<string, string>();
  for (const h of ['shadow', 'rim', 'texture'] as const) {
    for (const m of matchesFor(core, region.id, h)) {
      if (!top.has(m.site_id)) top.set(m.site_id, `#${m.rank} ${HAZARDS[h].short}`);
    }
  }
  hazardMatches.forEach((m: Match): void => {
    top.set(m.site_id, `#${m.rank} ${HAZARDS[m.hazard].short}`);
  });
  const first = core.sites.filter((s: EarthSite): boolean => top.has(s.id)).map((s: EarthSite) => ({ site: s, tag: top.get(s.id) ?? '' }));
  const rest = core.sites.filter((s: EarthSite): boolean => !top.has(s.id)).map((s: EarthSite) => ({ site: s, tag: '' }));
  return [...first, ...rest];
}

function useSunSweep(): { sweeping: boolean; start: () => void; stop: () => void } {
  const [sweeping, setSweeping] = useState<boolean>(false);
  useEffect((): (() => void) | void => {
    if (!sweeping) return;
    const st = useApp.getState();
    const startAz = st.sunAz;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      // No continuous motion: step the sun round in 30° jumps instead.
      let k = 0;
      const id = window.setInterval((): void => {
        k += 1;
        const s2 = useApp.getState();
        s2.setSun(s2.sunEl, (startAz + k * 30) % 360);
        if (k >= 12) setSweeping(false);
      }, 700);
      return (): void => window.clearInterval(id);
    }
    const DUR = 10000;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number): void => {
      const p = Math.min(1, (now - t0) / DUR);
      const eased = 0.5 - 0.5 * Math.cos(Math.PI * p); // ease in and out of one full turn
      const s2 = useApp.getState();
      s2.setSun(s2.sunEl, Math.round(((startAz + 360 * eased) % 360) * 10) / 10);
      if (p < 1) raf = requestAnimationFrame(tick);
      else setSweeping(false);
    };
    raf = requestAnimationFrame(tick);
    return (): void => cancelAnimationFrame(raf);
  }, [sweeping]);
  return { sweeping, start: (): void => setSweeping(true), stop: (): void => setSweeping(false) };
}

export default function Terrain3D(): JSX.Element {
  const core = useApp((s) => s.core) as CoreData;
  const region = useRegion();
  const hazard = useApp((s) => s.hazard);
  const siteId = useApp((s) => s.siteId);
  const setSite = useApp((s) => s.setSite);
  const exag = useApp((s) => s.exaggeration);
  const setExag = useApp((s) => s.setExaggeration);
  const el = useApp((s) => s.sunEl);
  const az = useApp((s) => s.sunAz);
  const setSun = useApp((s) => s.setSun);
  const mode = useApp((s) => s.shadowMode);
  const setMode = useApp((s) => s.setShadowMode);
  const walk = useApp((s) => s.walk);
  const setRegion = useApp((s) => s.setRegion);
  const sweep = useSunSweep();

  const hazardMatches = useMemo((): Match[] => (region ? matchesFor(core, region.id, hazard) : []), [core, region, hazard]);
  const effectiveSiteId = siteId ?? hazardMatches[0]?.site_id ?? core.sites[0]?.id ?? null;
  const site = effectiveSiteId ? (core.siteById.get(effectiveSiteId) ?? null) : null;
  const options = useMemo(() => (region ? siteOptions(core, region, hazardMatches) : []), [core, region, hazardMatches]);

  const moon = useTile(region?.tile ?? null, core.regionsOrigin);
  const earth = useTile(site?.tile ?? null, core.sitesOrigin);
  const moonShare = useShadowShare(moon.tile, el, az);
  const earthShare = useShadowShare(earth.tile, el, az);

  const moonPath = useMemo((): ((t: LoadedTile) => [number, number][]) | null => {
    if (!walk || !region || walk.regionId !== region.id) return null;
    const ref = region.tile;
    return (): [number, number][] => walk.route.map(([x, y]: [number, number]) => mapToPixel(x, y, ref.origin_x, ref.origin_y, ref.res_m));
  }, [walk, region]);
  const earthPath = useMemo((): ((t: LoadedTile) => [number, number][]) | null => {
    const it = walk?.bestItem;
    if (!it || !site || it.site_id !== site.id) return null;
    const ref = site.tile;
    return (): [number, number][] => [
      mapToPixel(it.x0, it.y0, ref.origin_x, ref.origin_y, ref.res_m),
      mapToPixel(it.x1, it.y1, ref.origin_x, ref.origin_y, ref.res_m),
    ];
  }, [walk, site]);

  if (!region || !site) return <p>No region or site available.</p>;

  const result =
    moonShare && earthShare
      ? `Shadowed at ${el.toFixed(1)}° sun: Moon ${pct(moonShare.frac)} · Earth ${pct(earthShare.frac)}`
      : `Measuring shadow at ${el.toFixed(1)}° sun…`;

  return (
    <div>
      <ScreenHead
        kicker={`3D side by side · ${region.name} and ${site.name}`}
        result={result}
        methodLabel="What is the same in both views"
        method={
          <p>
            Both tiles are 15 × 15 km on a 30 m grid, with the same grey material, the same vertical exaggeration and one sun at the same
            elevation and azimuth. Drag either view; the other follows.
          </p>
        }
      />

      <div className="panel controls">
        <div className="controls-row controls-terrain">
          <label className="control">
            <span className="field-label">Moon region</span>
            <select className="select" value={region.id} onChange={(e): void => setRegion(e.target.value)}>
              {core.regions.map((r: Region) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label className="control">
            <span className="field-label">Earth site</span>
            <select className="select" value={site.id} onChange={(e): void => setSite(e.target.value)}>
              {options.map(({ site: s, tag }) => (
                <option key={s.id} value={s.id}>
                  {tag ? `${tag} · ` : ''}
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <div className="control">
            <label htmlFor="exag" className="field-label field-label-row">
              <span>Vertical exaggeration</span>
              <span className="field-value">{exag.toFixed(1)}×</span>
            </label>
            <input
              id="exag"
              className="range"
              type="range"
              min={1}
              max={6}
              step={0.5}
              value={exag}
              onChange={(e): void => setExag(Number(e.target.value))}
            />
          </div>
          <div className="control control-fit">
            <span className="field-label" id="shadow-mode-label">
              Shadows
            </span>
            <div className="seg" role="group" aria-labelledby="shadow-mode-label">
              <button type="button" aria-pressed={mode === 'realtime'} onClick={(): void => setMode('realtime')}>
                Live
              </button>
              <button type="button" aria-pressed={mode === 'precomputed'} onClick={(): void => setMode('precomputed')}>
                Masks
              </button>
            </div>
          </div>
        </div>
        <div className="controls-row controls-sun">
          <div className="control">
            <label htmlFor="sunel" className="field-label field-label-row">
              <span className="sun-label">
                <SunGlyph /> Sun elevation
              </span>
              <span className="field-value">{el.toFixed(1)}°</span>
            </label>
            <input
              id="sunel"
              className="range range-sun"
              type="range"
              min={1}
              max={30}
              step={0.5}
              value={el}
              onChange={(e): void => setSun(Number(e.target.value), az)}
            />
          </div>
          <div className="control">
            <label htmlFor="sunaz" className="field-label field-label-row">
              <span className="sun-label">
                <SunGlyph /> Sun azimuth
              </span>
              <span className="field-value">{az.toFixed(0)}°</span>
            </label>
            <input
              id="sunaz"
              className="range range-sun"
              type="range"
              min={0}
              max={359}
              step={1}
              value={Math.round(az) % 360}
              onChange={(e): void => {
                sweep.stop();
                setSun(el, Number(e.target.value));
              }}
            />
          </div>
          <div className="control control-fit">
            <button
              type="button"
              className="btn btn-primary btn-sweep"
              aria-pressed={sweep.sweeping}
              onClick={sweep.sweeping ? sweep.stop : sweep.start}
            >
              <SunGlyph />
              {sweep.sweeping ? 'Stop the sweep' : 'Sweep the sun'}
            </button>
          </div>
        </div>
      </div>

      <div className="twin">
        <Pane
          id="moon"
          title={region.name}
          world="Moon"
          subtitle="LOLA"
          tile={moon.tile}
          error={moon.error}
          tileRef={region.tile}
          origin={core.regionsOrigin}
          masks={region.shadow_masks}
          path={moonPath}
          share={moonShare}
        />
        <Pane
          id="earth"
          title={site.name}
          world="Earth"
          subtitle={site.country}
          tile={earth.tile}
          error={earth.error}
          tileRef={site.tile}
          origin={core.sitesOrigin}
          masks={[]}
          path={earthPath}
          share={earthShare}
        />
      </div>
      <p className="footnote">
        Azimuth is measured clockwise from the top of each tile; on Moon tiles the top is not geographic north. Live shadows are drawn by
        your graphics card and can flicker or leave gaps when the sun is very low; switch to Masks for the reference picture. The shadow
        percentages are worked out in your browser from true heights (90 m steps), so vertical exaggeration changes the picture, not the
        numbers.
        {walk && walk.regionId === region.id ? ' The white line is your drawn walk.' : ''}
      </p>
    </div>
  );
}
