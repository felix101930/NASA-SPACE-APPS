// One 3D pane: terrain, one sun, and the hazard overlay. Both panes share camera, sun and exaggeration.
import { useEffect, useMemo, useRef, type JSX, type MutableRefObject, type ReactNode } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Line, OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import { SafeCanvas } from '../../components/SafeCanvas';
import { Loading } from '../../components/Loading';
import { TERRAIN_KM, tileToScene, useTerrainGeometry } from '../../components/terrainGeometry';
import { SunMarker, sunGeometry, sunPosition } from '../../components/SunMarker';
import type { LoadedTile } from '../../data/tiles';
import type { RimSeg } from './data';
import { PATCH_TINT_OPACITY, PatchLabelProjector, PatchLabels, PatchLines, patchAnchors, usePatchTexture, type PatchLayerData } from './PatchLayer';

const KM = TERRAIN_KM;
export const SHADOW_MAP = 2048; // per pane; 4096² on two canvases was part of the WebGL context pressure
const RIM_COLOR = '#F07B4A';
const PATH_COLOR = '#edeae4';

// ------------------------------------------------------------------------------------------------
// Camera sync (shared mutable state, not React state, so dragging does not re-render the screen)
// ------------------------------------------------------------------------------------------------

// Far enough back that the sun's ring (0.76× the tile width) fits in the first view.
const START_POS: [number, number, number] = [0, 19.5, 23];
const sync = { pos: new THREE.Vector3(...START_POS), target: new THREE.Vector3(0, 0, 0), version: 0, source: '' };

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
// Scene pieces
// ------------------------------------------------------------------------------------------------

function TerrainMesh({
  tile,
  exag,
  map,
  emissiveMap,
  shadows,
  patchMap,
}: {
  tile: LoadedTile;
  exag: number;
  map: THREE.Texture | null;
  emissiveMap: THREE.Texture | null;
  shadows: boolean;
  /** 25-patch tint drawn over the lit terrain on the same geometry (no second heightfield). */
  patchMap: THREE.Texture | null;
}): JSX.Element {
  const geom = useTerrainGeometry(tile, exag);
  return (
    <>
    <mesh geometry={geom} castShadow={shadows} receiveShadow={shadows}>
      {/* Keyed on whether maps are present (that changes the shader), not on which texture: a new material per
          shadow mask released and recompiled the program on every sun step. Swapping textures needs no recompile. */}
      <meshStandardMaterial
        key={`${map ? 'map' : 'plain'}:${emissiveMap ? 'em' : 'none'}`}
        color="#c4beb3"
        roughness={0.97}
        metalness={0}
        map={map}
        emissive={emissiveMap ? '#ffffff' : '#000000'}
        emissiveMap={emissiveMap}
        emissiveIntensity={emissiveMap ? 0.4 : 0}
      />
    </mesh>
    {patchMap && (
      <mesh geometry={geom} renderOrder={1}>
        {/* Multiply tint: result = terrain × mix(1, patch colour, opacity), so cast shadows stay black. */}
        <meshBasicMaterial
          map={patchMap}
          transparent
          opacity={PATCH_TINT_OPACITY}
          premultipliedAlpha
          blending={THREE.CustomBlending}
          blendEquation={THREE.AddEquation}
          blendSrc={THREE.DstColorFactor}
          blendDst={THREE.OneMinusSrcAlphaFactor}
          depthWrite={false}
          polygonOffset
          polygonOffsetFactor={-2}
          polygonOffsetUnits={-2}
          toneMapped={false}
        />
      </mesh>
    )}
    </>
  );
}

function DrapedLine({
  tile,
  exag,
  from,
  to,
  color,
  width,
}: {
  tile: LoadedTile;
  exag: number;
  from: [number, number];
  to: [number, number];
  color: string;
  width: number;
}): JSX.Element | null {
  const pts = useMemo((): [number, number, number][] => {
    const steps = Math.max(2, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1])));
    const out: [number, number, number][] = [];
    for (let s = 0; s <= steps; s++) {
      const c = from[0] + ((to[0] - from[0]) * s) / steps;
      const r = from[1] + ((to[1] - from[1]) * s) / steps;
      out.push(tileToScene(tile, c, r, exag, 0.05));
    }
    return out;
  }, [tile, exag, from, to]);
  if (pts.length < 2) return null;
  return <Line points={pts} color={color} lineWidth={width} />;
}

function RimOverlay({ tile, exag, segs }: { tile: LoadedTile; exag: number; segs: RimSeg[] }): JSX.Element {
  return (
    <group>
      {segs.map((s: RimSeg) => {
        const top = tileToScene(tile, s.start[0], s.start[1], exag, 0.08);
        return (
          <group key={s.rank}>
            <DrapedLine tile={tile} exag={exag} from={s.start} to={s.end} color={RIM_COLOR} width={5} />
            <mesh position={top}>
              <sphereGeometry args={[0.09, 12, 12]} />
              <meshBasicMaterial color={RIM_COLOR} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

interface Tag3D {
  key: string;
  pos: [number, number, number];
  /** Rim rank; 0 for the sun tag. */
  rank: number;
  text: string;
}

/** Lowest point of the tile in scene units (the horizon plane for the sun marker). */
function baseHeight(tile: LoadedTile, exag: number): number {
  const v = (tile.stats.min - tile.stats.median) * KM * exag;
  return Number.isFinite(v) ? v : 0;
}

function elLabel(el: number): string {
  return `${Number.isInteger(el) ? el.toFixed(0) : el.toFixed(1)}°`;
}

function rimTags(tile: LoadedTile, exag: number, segs: RimSeg[]): Tag3D[] {
  return segs.map(
    (s: RimSeg): Tag3D => ({
      key: `rim-${s.rank}`,
      pos: tileToScene(tile, (s.start[0] + s.end[0]) / 2, (s.start[1] + s.end[1]) / 2, exag, 0.6),
      rank: s.rank,
      text: `${Math.round(s.absDh)} m drop`,
    }),
  );
}

interface Placed {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Labels are plain DOM elements over the canvas, moved every frame to their projected 3D anchor
 * (drei's <Html> mounts a nested React root per label, which throws when it unmounts mid-render).
 * Labels are nudged down until they no longer overlap one placed earlier.
 */
function TagProjector({ tags, els }: { tags: Tag3D[]; els: MutableRefObject<Map<string, HTMLSpanElement>> }): null {
  const camera = useThree((st) => st.camera);
  const size = useThree((st) => st.size);
  const v = useMemo((): THREE.Vector3 => new THREE.Vector3(), []);
  useFrame((): void => {
    const placed: Placed[] = [];
    const items = tags
      .map((t: Tag3D) => {
        v.set(t.pos[0], t.pos[1], t.pos[2]).project(camera);
        return {
          el: els.current.get(t.key),
          x: ((v.x + 1) / 2) * size.width,
          y: ((1 - v.y) / 2) * size.height,
          hidden: v.z > 1 || v.z < -1,
        };
      })
      .sort((a: { y: number }, b: { y: number }): number => a.y - b.y);
    for (const it of items) {
      if (!it.el) continue;
      const w = it.el.offsetWidth;
      const h = it.el.offsetHeight + 4;
      let y = it.y;
      for (let guard = 0; guard < tags.length; guard++) {
        const hit = placed.find((p: Placed): boolean => Math.abs(p.x - it.x) < (p.w + w) / 2 && Math.abs(p.y - y) < (p.h + h) / 2);
        if (!hit) break;
        y = hit.y + (hit.h + h) / 2;
      }
      placed.push({ x: it.x, y, w, h });
      it.el.style.visibility = it.hidden ? 'hidden' : 'visible';
      it.el.style.transform = `translate(-50%, -50%) translate(${it.x}px, ${y}px)`;
    }
  });
  return null;
}

/**
 * The scene's sun is raised to cancel the vertical exaggeration: with heights scaled by k, a sun at
 * atan(k·tan(el)) casts shadows over exactly the same ground as the real sun on real heights, so the
 * picture agrees with the "% dark" readouts (which use true heights) at any exaggeration.
 */
export function sceneSunEl(el: number, exag: number): number {
  return (Math.atan(Math.max(1, exag) * Math.tan((el * Math.PI) / 180)) * 180) / Math.PI;
}

function Sun({ el, az, shadows, extent }: { el: number; az: number; shadows: boolean; extent: number }): JSX.Element {
  const light = useRef<THREE.DirectionalLight>(null);
  const scene = useThree((s) => s.scene);
  useEffect((): void => {
    const l = light.current;
    if (!l) return;
    const e = (el * Math.PI) / 180;
    const a = (az * Math.PI) / 180;
    const dist = 40;
    // azimuth clockwise from the tile's top (grid +y = -z here); right = +x
    l.position.set(Math.sin(a) * Math.cos(e) * dist, Math.sin(e) * dist, -Math.cos(a) * Math.cos(e) * dist);
    l.target.position.set(0, 0, 0);
    if (!l.target.parent) scene.add(l.target);
    const half = extent * 0.72 + 0.3;
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
      intensity={5.5}
      castShadow={shadows}
      shadow-mapSize-width={SHADOW_MAP}
      shadow-mapSize-height={SHADOW_MAP}
      shadow-bias={-0.0005}
      shadow-normalBias={0.04}
    />
  );
}

// ------------------------------------------------------------------------------------------------
// Pane
// ------------------------------------------------------------------------------------------------

export interface PaneProps {
  id: 'moon' | 'earth';
  name: string;
  world: string;
  /** Short line under the name (e.g. data source, country). */
  sub: string;
  /** Tooltip for the name (precise place). */
  nameTitle?: string;
  /** "Up" direction note for this tile. */
  upNote: string;
  tile: LoadedTile | null;
  /** Load failure: a message, or richer content (e.g. a reload prompt). */
  error: ReactNode;
  extentKm: number;
  exag: number;
  el: number;
  az: number;
  realtime: boolean;
  lift: boolean;
  shadeMap: THREE.Texture | null;
  cellMap: THREE.Texture | null;
  rim: RimSeg[] | null;
  path: [number, number][] | null;
  /** Big corner readout. */
  readout: ReactNode;
  /** Small note at the bottom right. */
  note?: ReactNode;
  /** "Show the 25 patches": values on the scale shared by both panes, or null when off. */
  patches?: PatchLayerData | null;
}

export function Pane(p: PaneProps): JSX.Element {
  const { tile } = p;
  const shadows = p.realtime;
  const tagEls = useRef<Map<string, HTMLSpanElement>>(new Map());
  const patchEls = useRef<(HTMLSpanElement | null)[]>([]);
  const patches = p.patches ?? null;
  const patchMap = usePatchTexture(patches);
  const anchors = useMemo((): [number, number, number][] => (tile && patches ? patchAnchors(tile, p.exag) : []), [tile, patches, p.exag]);
  const baseY = tile ? baseHeight(tile, p.exag) : 0;
  const tags = useMemo((): Tag3D[] => {
    if (!tile) return [];
    const sunAt = sunPosition(p.el, p.az, sunGeometry(p.extentKm, baseY));
    const sunTag: Tag3D = { key: 'sun', pos: [sunAt[0], sunAt[1] + p.extentKm * 0.07, sunAt[2]], rank: 0, text: `Sun ${elLabel(p.el)}` };
    return [...(p.rim ? rimTags(tile, p.exag, p.rim) : []), sunTag];
  }, [tile, p.exag, p.rim, p.el, p.az, p.extentKm, baseY]);
  return (
    <figure className="t3-pane" data-world={p.id}>
      {p.error ? (
        <div className="t3-pane-error" role="alert">
          <p>Could not load the {p.world} terrain.</p>
          <p className="caption">{p.error}</p>
        </div>
      ) : !tile ? (
        <Loading label={`Loading ${p.name} terrain…`} />
      ) : (
        <SafeCanvas
          name={`3D view (${p.world})`}
          resetKey={tile.ref.path}
          shadows={shadows ? 'percentage' : false}
          dpr={[1, 1.5]}
          camera={{ position: START_POS, fov: 38, near: 0.05, far: 200 }}
          gl={{ antialias: true, powerPreference: 'default' }}
        >
          <color attach="background" args={['#14161b']} />
          <hemisphereLight args={['#9aa3b5', '#2a2620', p.lift ? 0.45 : 0.05]} />
          {/* Light raised for the exaggeration (true shadow lengths); marker on the TRUE angle; same azimuth. */}
          <Sun el={sceneSunEl(p.el, p.exag)} az={p.az} shadows={shadows} extent={p.extentKm} />
          <SunMarker el={p.el} az={p.az} extent={p.extentKm} baseY={baseY} />
          <TerrainMesh tile={tile} exag={p.exag} map={p.realtime ? null : p.shadeMap} emissiveMap={p.cellMap} shadows={shadows} patchMap={patchMap} />
          {patches && <PatchLines tile={tile} exag={p.exag} />}
          {patches && <PatchLabelProjector anchors={anchors} els={patchEls} />}
          {p.rim && <RimOverlay tile={tile} exag={p.exag} segs={p.rim} />}
          {p.path &&
            p.path.slice(1).map((pt: [number, number], i: number) => (
              <DrapedLine key={i} tile={tile} exag={p.exag} from={p.path?.[i] ?? pt} to={pt} color={PATH_COLOR} width={3} />
            ))}
          <TagProjector tags={tags} els={tagEls} />
          <SyncedControls id={p.id} />
        </SafeCanvas>
      )}
      {tile && !p.error && patches && <PatchLabels data={patches} els={patchEls} />}
      {tile && !p.error && (
        <div className="t3-tags" aria-hidden="true">
          {tags.map((t: Tag3D) => (
            <span
              key={t.key}
              className={t.rank === 0 ? 't3-tag3d t3-tag-sun' : 't3-tag3d'}
              style={{ visibility: 'hidden' }}
              ref={(el: HTMLSpanElement | null): void => {
                if (el) tagEls.current.set(t.key, el);
                else tagEls.current.delete(t.key);
              }}
            >
              {t.rank > 0 && <b>#{t.rank} </b>}
              {t.text}
            </span>
          ))}
        </div>
      )}
      <figcaption className="t3-pane-head">
        <span className="t3-pane-world">{p.world}</span>
        <span className="t3-pane-name" title={p.nameTitle}>
          {p.name}
        </span>
        <span className="t3-pane-sub">{p.sub}</span>
      </figcaption>
      <div className="t3-pane-up" aria-hidden="true">
        <svg width="12" height="14" viewBox="0 0 12 14">
          <path d="M6 1l4.5 6H7.2v6H4.8V7H1.5z" fill="currentColor" />
        </svg>
        {p.upNote}
      </div>
      <div className="t3-pane-readout" aria-live="polite">
        {p.readout}
      </div>
      {p.note && <div className="t3-pane-note">{p.note}</div>}
    </figure>
  );
}
