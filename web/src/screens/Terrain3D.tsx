import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Line, OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import { loadImage, type Origin } from '../data/loader';
import { loadTile, type LoadedTile } from '../data/tiles';
import { computeShadowMask, mapToPixel, sampleBilinear } from '../lib/terrain';
import { HAZARDS } from '../content';
import { matchesFor, useApp, useRegion, type CoreData, type ShadowMode } from '../store';
import type { EarthSite, Match, Region, ShadowMask, TileRef } from '../types/contract';
import { Loading } from '../components/Loading';

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

const KM = 1 / 1000;

function heightAt(tile: LoadedTile, col: number, row: number, exag: number): number {
  return (sampleBilinear(tile.filled, col, row) - tile.stats.median) * KM * exag;
}

function useTerrainGeometry(tile: LoadedTile, exag: number): THREE.BufferGeometry {
  const geom = useMemo((): THREE.BufferGeometry => {
    const n = tile.filled.size;
    const W = n * tile.filled.res * KM;
    const pos = new Float32Array(n * n * 3);
    const uv = new Float32Array(n * n * 2);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const i = r * n + c;
        pos[i * 3] = (c / (n - 1) - 0.5) * W;
        pos[i * 3 + 2] = (r / (n - 1) - 0.5) * W;
        uv[i * 2] = c / (n - 1);
        uv[i * 2 + 1] = 1 - r / (n - 1);
      }
    }
    const idx = new Uint32Array((n - 1) * (n - 1) * 6);
    let k = 0;
    for (let r = 0; r < n - 1; r++) {
      for (let c = 0; c < n - 1; c++) {
        const a = r * n + c;
        const b = a + 1;
        const d = a + n;
        const e = d + 1;
        idx[k++] = a;
        idx[k++] = d;
        idx[k++] = b;
        idx[k++] = b;
        idx[k++] = d;
        idx[k++] = e;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    return g;
  }, [tile]);

  useMemo((): void => {
    const attr = geom.getAttribute('position') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const d = tile.filled.data;
    const med = tile.stats.median;
    for (let i = 0; i < d.length; i++) arr[i * 3 + 1] = (d[i] - med) * KM * exag;
    attr.needsUpdate = true;
    geom.computeVertexNormals();
    geom.computeBoundingSphere();
  }, [geom, tile, exag]);

  useEffect((): (() => void) => (): void => geom.dispose(), [geom]);
  return geom;
}

function TerrainMesh({ tile, exag, map, shadows }: { tile: LoadedTile; exag: number; map: THREE.Texture | null; shadows: boolean }): JSX.Element {
  const geom = useTerrainGeometry(tile, exag);
  return (
    <mesh geometry={geom} castShadow={shadows} receiveShadow={shadows}>
      <meshStandardMaterial key={map ? map.uuid : 'plain'} color="#c4beb3" roughness={0.97} metalness={0} map={map} />
    </mesh>
  );
}

function PathLine({ tile, exag, pixels, color }: { tile: LoadedTile; exag: number; pixels: [number, number][]; color: string }): JSX.Element | null {
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
      const out = v >= 192 ? 0 : v >= 64 ? 110 : 255;
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

function useMaskTexture(
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
          if (alive) setState({ texture: imageMaskTexture(img, tile.filled.size), note: `pipeline mask, nearest to slider: sun ${pick.el}° / ${pick.az}° (grey = no data)` });
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
// One pane
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

interface PaneProps {
  id: string;
  title: string;
  subtitle: string;
  tileRef: TileRef;
  origin: Origin;
  masks: ShadowMask[];
  path: ((tile: LoadedTile) => [number, number][]) | null;
  pathColor: string;
}

function Pane({ id, title, subtitle, tileRef, origin, masks, path, pathColor }: PaneProps): JSX.Element {
  const exag = useApp((s) => s.exaggeration);
  const el = useApp((s) => s.sunEl);
  const az = useApp((s) => s.sunAz);
  const mode = useApp((s) => s.shadowMode);
  const { tile, error } = useTile(tileRef, origin);
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
        <Canvas shadows="percentage" dpr={[1, 1.75]} camera={{ position: [0, 17, 19], fov: 38, near: 0.05, far: 200 }} gl={{ antialias: true }}>
          <color attach="background" args={['#050608']} />
          <hemisphereLight args={['#9aa3b5', '#000000', 0.06]} />
          <Sun el={el} az={az} shadows={realtime} extent={extent} />
          <TerrainMesh tile={tile} exag={exag} map={realtime ? null : mask.texture} shadows={realtime} />
          {pixels && <PathLine tile={tile} exag={exag} pixels={pixels} color={pathColor} />}
          <SyncedControls id={id} />
        </Canvas>
      )}
      <div className="twin-label">
        <span>
          <strong>{title}</strong> <span className="muted">{subtitle}</span>
        </span>
        {tile && (
          <span className="num faint" title="Elevation range in the tile">
            relief {Math.round(tile.stats.max - tile.stats.min)} m{tile.nanCount > 0 ? ` · ${tile.nanCount} no-data px filled` : ''}
          </span>
        )}
      </div>
      {!realtime && mask.note && (
        <div className="map-legend" style={{ maxWidth: 'none' }}>
          Shadows: {mask.note}
        </div>
      )}
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

  const hazardMatches = useMemo((): Match[] => (region ? matchesFor(core, region.id, hazard) : []), [core, region, hazard]);
  const effectiveSiteId = siteId ?? hazardMatches[0]?.site_id ?? core.sites[0]?.id ?? null;
  const site = effectiveSiteId ? core.siteById.get(effectiveSiteId) ?? null : null;
  const options = useMemo(() => (region ? siteOptions(core, region, hazardMatches) : []), [core, region, hazardMatches]);

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

  return (
    <div>
      <div className="screen-head">
        <div>
          <h1>Same light, same scale</h1>
          <p>
            Both tiles are 15 × 15 km on a 30 m grid, with the same grey material, the same vertical exaggeration and one sun
            at the same elevation and azimuth. Drag either view; the other follows.
          </p>
        </div>
      </div>

      <div className="panel controls-bar">
        <label className="control">
          <span className="label">Moon region</span>
          <select className="select" value={region.id} onChange={(e): void => setRegion(e.target.value)}>
            {core.regions.map((r: Region) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label className="control">
          <span className="label">Earth site</span>
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
          <label htmlFor="exag">
            <span className="label">Vertical exaggeration</span>
            <span className="num">{exag.toFixed(1)}×</span>
          </label>
          <input id="exag" type="range" min={1} max={6} step={0.5} value={exag} onChange={(e): void => setExag(Number(e.target.value))} />
        </div>
        <div className="control">
          <label htmlFor="sunel">
            <span className="label">Sun elevation</span>
            <span className="num">{el.toFixed(1)}°</span>
          </label>
          <input id="sunel" type="range" min={1} max={30} step={0.5} value={el} onChange={(e): void => setSun(Number(e.target.value), az)} />
        </div>
        <div className="control">
          <label htmlFor="sunaz">
            <span className="label">Sun azimuth</span>
            <span className="num">{az.toFixed(0)}°</span>
          </label>
          <input id="sunaz" type="range" min={0} max={359} step={1} value={az} onChange={(e): void => setSun(el, Number(e.target.value))} />
        </div>
        <div className="control" style={{ minWidth: 0 }}>
          <span className="label">Shadows</span>
          <div className="seg" role="group" aria-label="Shadow rendering">
            <button aria-pressed={mode === 'realtime'} onClick={(): void => setMode('realtime')}>
              Real-time
            </button>
            <button aria-pressed={mode === 'precomputed'} onClick={(): void => setMode('precomputed')}>
              Precomputed masks
            </button>
          </div>
        </div>
      </div>

      <div className="twin">
        <Pane
          id="moon"
          title={region.name}
          subtitle="Moon · LOLA"
          tileRef={region.tile}
          origin={core.regionsOrigin}
          masks={region.shadow_masks}
          path={moonPath}
          pathColor="#f3b54a"
        />
        <Pane
          id="earth"
          title={site.name}
          subtitle={`Earth · ${site.country}`}
          tileRef={site.tile}
          origin={core.sitesOrigin}
          masks={[]}
          path={earthPath}
          pathColor="#f3b54a"
        />
      </div>
      <p className="faint" style={{ fontSize: 12.5, marginTop: 10 }}>
        Azimuth is clockwise from grid +y (up in each tile). On Moon tiles grid +y is not geographic north. Real-time
        shadows use a 4096² shadow map with a tight frustum; at 1–3° sun they can show acne or gaps, so switch to precomputed
        masks for the reference picture. {walk && walk.regionId === region.id ? 'The amber line is your drawn walk.' : ''}
      </p>
    </div>
  );
}
