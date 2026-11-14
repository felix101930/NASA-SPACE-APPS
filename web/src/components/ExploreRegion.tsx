// "Explore in 3D": one large canvas with a region's tile and switchable danger layers.
// Shadow masks come from regions.json (always available); rim drops, featureless cells, slope classes and the
// safest patch come from moon/<id>_annotations.json and are hidden when that file is missing.
// Loaded lazily (three.js stays out of the first load).
import { useEffect, useMemo, useRef, useState, type JSX, type MutableRefObject } from 'react';
import { Line, OrbitControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { loadImage, loadJsonFrom, type Origin } from '../data/loader';
import { loadTile, type LoadedTile } from '../data/tiles';
import { hillshade } from '../lib/terrain';
import type { Region, ShadowMask } from '../types/contract';
import { isAnnotations, type Annotations, type Px } from '../types/annotations';
import { HazardGlyph, SunGlyph, type HazardKey } from './Glyphs';
import { Loading } from './Loading';
import { SafeCanvas } from './SafeCanvas';
import { TERRAIN_KM, terrainHeightAt, useTerrainGeometry } from './terrainGeometry';
import { avgShadowAt, singleSunShadow } from '../lib/shadow';

export type ExploreLayer = 'shadow' | 'rim' | 'texture' | 'slope' | 'safe';

const EXAG = 2;
const SLOPE_COLOURS: [number, number, number][] = [
  [42, 45, 51],
  [96, 92, 84],
  [150, 145, 136],
  [222, 217, 208],
];

export const LAYER_LABEL: Record<ExploreLayer, string> = {
  shadow: 'Shadow',
  rim: 'Rim drops',
  texture: 'No camera texture',
  slope: 'Slope classes',
  safe: 'Safest patch',
};

const LAYER_GLYPH: Record<ExploreLayer, HazardKey | null> = {
  shadow: 'shadow',
  rim: 'rim',
  texture: 'texture',
  slope: 'slope',
  safe: null,
};

interface ExploreData {
  tile: LoadedTile;
  base: Uint8ClampedArray;
  annotations: Annotations | null;
  slopeClasses: { data: Uint8Array; size: number } | null;
}

async function readGrey(img: HTMLImageElement, size: number): Promise<Uint8Array> {
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.drawImage(img, 0, 0, size, size);
  const d = ctx.getImageData(0, 0, size, size).data;
  const out = new Uint8Array(size * size);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4];
  return out;
}

function useExploreData(region: Region, origin: Origin): { data: ExploreData | null; error: string | null } {
  const [data, setData] = useState<ExploreData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect((): (() => void) => {
    let alive = true;
    setData(null);
    setError(null);
    (async (): Promise<void> => {
      const [tile, ann] = await Promise.all([
        loadTile(region.tile, origin),
        loadJsonFrom(`moon/${region.id}_annotations.json`, isAnnotations, origin),
      ]);
      const annotations = ann?.value ?? null;
      let slopeClasses: ExploreData['slopeClasses'] = null;
      const png = annotations?.steep_mask_summary?.class_png;
      if (png) {
        try {
          const img = await loadImage(png.path, origin);
          slopeClasses = { data: await readGrey(img, png.size), size: png.size };
        } catch {
          slopeClasses = null;
        }
      }
      const base = hillshade(tile.filled, 315, 30);
      if (alive) setData({ tile, base, annotations, slopeClasses });
    })().catch((e: unknown): void => {
      if (alive) setError(e instanceof Error ? e.message : String(e));
    });
    return (): void => {
      alive = false;
    };
  }, [region, origin]);
  return { data, error };
}

function useMask(mask: ShadowMask | null, size: number, origin: Origin): Uint8Array | null {
  const [m, setM] = useState<Uint8Array | null>(null);
  useEffect((): (() => void) => {
    let alive = true;
    setM(null);
    if (mask) {
      loadImage(mask.path, origin)
        .then((img: HTMLImageElement): Promise<Uint8Array> => readGrey(img, size))
        .then((g: Uint8Array): void => {
          if (alive) setM(g);
        })
        .catch((): void => undefined);
    }
    return (): void => {
      alive = false;
    };
  }, [mask, size, origin]);
  return m;
}

/** Bakes the base hillshade plus the raster layers (shadow, slope classes, empty cells) into one texture. */
function paintTexture(d: ExploreData, layers: Set<ExploreLayer>, mask: Uint8Array | null): THREE.CanvasTexture {
  const n = d.tile.filled.size;
  const cv = document.createElement('canvas');
  cv.width = n;
  cv.height = n;
  const ctx = cv.getContext('2d');
  if (ctx) {
    const im = ctx.createImageData(n, n);
    const px = im.data;
    const slope = layers.has('slope') ? d.slopeClasses : null;
    const dim = layers.has('texture') || layers.has('rim') || layers.has('safe') ? 0.7 : 1;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const i = r * n + c;
        const b = d.base[i] * dim;
        let rr = b;
        let gg = b;
        let bb = b;
        if (slope) {
          const sc =
            slope.data[
              Math.min(slope.size - 1, Math.floor((r / n) * slope.size)) * slope.size +
                Math.min(slope.size - 1, Math.floor((c / n) * slope.size))
            ];
          const col = SLOPE_COLOURS[Math.min(3, sc)] ?? SLOPE_COLOURS[0];
          rr = col[0] * 0.75 + b * 0.25;
          gg = col[1] * 0.75 + b * 0.25;
          bb = col[2] * 0.75 + b * 0.25;
        }
        if (mask && layers.has('shadow')) {
          const v = mask[i];
          if (v >= 192) {
            rr = rr * 0.15 + 124 * 0.5;
            gg = gg * 0.15 + 196 * 0.5;
            bb = bb * 0.15 + 242 * 0.5;
          }
        }
        px[i * 4] = rr;
        px[i * 4 + 1] = gg;
        px[i * 4 + 2] = bb;
        px[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(im, 0, 0);
    const cells = layers.has('texture') ? d.annotations?.texture?.texture_empty_cells : undefined;
    if (cells) {
      // Opacity follows how many of the 8 sun directions leave the cell blank; mostly-blank cells get an outline.
      ctx.lineWidth = 1.5;
      for (const cell of cells) {
        const f = cell.empty_az_frac ?? 1;
        const [c0, r0, c1, r1] = cell.bbox.px;
        ctx.fillStyle = `rgba(217, 140, 196, ${(0.06 + 0.4 * f).toFixed(3)})`;
        ctx.fillRect(c0 + 1, r0 + 1, c1 - c0 - 2, r1 - r0 - 2);
        if (f >= 0.75) {
          ctx.strokeStyle = 'rgba(217, 140, 196, 0.9)';
          ctx.strokeRect(c0 + 1.5, r0 + 1.5, c1 - c0 - 3, r1 - r0 - 3);
        }
      }
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function toScene(tile: LoadedTile, p: Px, lift: number): [number, number, number] {
  const n = tile.filled.size;
  const W = n * tile.filled.res * TERRAIN_KM;
  const c = p[0] - 0.5;
  const r = p[1] - 0.5;
  return [(c / (n - 1) - 0.5) * W, terrainHeightAt(tile, c, r, EXAG) + lift, (r / (n - 1) - 0.5) * W];
}

function draped(tile: LoadedTile, a: Px, b: Px, lift: number): [number, number, number][] {
  const steps = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
  const out: [number, number, number][] = [];
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    out.push(toScene(tile, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], lift));
  }
  return out;
}

interface Tag3D {
  key: string;
  pos: [number, number, number];
  hazard: HazardKey | null;
  text: string;
}

/**
 * Labels are plain DOM elements over the canvas, moved every frame to their projected 3D anchor.
 * (drei's <Html> mounts a nested React root per label, which throws when it unmounts mid-render.)
 */
function TagProjector({ tags, els }: { tags: Tag3D[]; els: MutableRefObject<Map<string, HTMLSpanElement>> }): null {
  const camera = useThree((st) => st.camera);
  const size = useThree((st) => st.size);
  const v = useMemo((): THREE.Vector3 => new THREE.Vector3(), []);
  useFrame((): void => {
    // Project, then nudge labels down until they no longer overlap one placed earlier (top to bottom).
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const items = tags
      .map((t: Tag3D) => {
        v.set(t.pos[0], t.pos[1], t.pos[2]).project(camera);
        return {
          t,
          el: els.current.get(t.key),
          x: ((v.x + 1) / 2) * size.width,
          y: ((1 - v.y) / 2) * size.height,
          hidden: v.z > 1 || v.z < -1,
        };
      })
      .sort((a, b): number => a.y - b.y);
    for (const it of items) {
      if (!it.el) continue;
      const w = it.el.offsetWidth;
      const h = it.el.offsetHeight + 4;
      let y = it.y;
      for (let guard = 0; guard < tags.length; guard++) {
        const hit = placed.find((p) => Math.abs(p.x - it.x) < (p.w + w) / 2 && Math.abs(p.y - y) < (p.h + h) / 2);
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

function buildTags(d: ExploreData, layers: Set<ExploreLayer>, maskNote: string | null): Tag3D[] {
  const a = d.annotations;
  const n = d.tile.filled.size;
  const out: Tag3D[] = [];
  const label = (h: string): { anchor: Px; title: string } | undefined => {
    const l = a?.labels?.find((x) => x.hazard === h);
    return l ? { anchor: l.anchor.px, title: l.title } : undefined;
  };
  const top = a?.rim_drops?.drops[0];
  if (layers.has('rim') && top) out.push({ key: 'rim', pos: toScene(d.tile, top.mid.px, 0.5), hazard: 'rim', text: top.label });
  if (layers.has('texture') && a?.texture) {
    out.push({
      key: 'texture',
      pos: toScene(d.tile, label('texture')?.anchor ?? [n / 2, n / 2], 0.4),
      hazard: 'texture',
      text: `${Math.round(a.texture.empty_frac * 100)}% of 1 km squares give a camera nothing to track`,
    });
  }
  const slope = label('slope');
  if (layers.has('slope') && slope) out.push({ key: 'slope', pos: toScene(d.tile, slope.anchor, 0.4), hazard: 'slope', text: slope.title });
  if (layers.has('shadow') && maskNote)
    out.push({ key: 'shadow', pos: toScene(d.tile, [n / 2, n / 2], 0.6), hazard: 'shadow', text: maskNote });
  const safe = a?.safest_patch;
  if (layers.has('safe') && safe) out.push({ key: 'safe', pos: toScene(d.tile, safe.anchor.px, 0.5), hazard: null, text: safe.label });
  return out;
}

function Scene({
  d,
  layers,
  mask,
  tags,
  tagEls,
}: {
  d: ExploreData;
  layers: Set<ExploreLayer>;
  mask: Uint8Array | null;
  tags: Tag3D[];
  tagEls: MutableRefObject<Map<string, HTMLSpanElement>>;
}): JSX.Element {
  const geom = useTerrainGeometry(d.tile, EXAG);
  const texture = useMemo((): THREE.CanvasTexture => paintTexture(d, layers, mask), [d, layers, mask]);
  useEffect((): (() => void) => (): void => texture.dispose(), [texture]);
  const a = d.annotations;
  const drops = layers.has('rim') ? (a?.rim_drops?.drops ?? []).slice(0, 3) : [];
  const safe = layers.has('safe') ? a?.safest_patch : undefined;
  return (
    <>
      <color attach="background" args={['#1a1d23']} />
      <mesh geometry={geom}>
        <meshBasicMaterial map={texture} />
      </mesh>
      {drops.map((dr) => (
        <Line
          key={dr.rank}
          points={draped(d.tile, dr.start.px, dr.end.px, 0.08)}
          color="#f07b4a"
          lineWidth={dr.rank === drops[0]?.rank ? 5 : 3}
        />
      ))}
      {safe && (
        <Line
          points={[
            ...draped(d.tile, [safe.bbox.px[0], safe.bbox.px[1]], [safe.bbox.px[2], safe.bbox.px[1]], 0.08),
            ...draped(d.tile, [safe.bbox.px[2], safe.bbox.px[1]], [safe.bbox.px[2], safe.bbox.px[3]], 0.08),
            ...draped(d.tile, [safe.bbox.px[2], safe.bbox.px[3]], [safe.bbox.px[0], safe.bbox.px[3]], 0.08),
            ...draped(d.tile, [safe.bbox.px[0], safe.bbox.px[3]], [safe.bbox.px[0], safe.bbox.px[1]], 0.08),
          ]}
          color="#edeae4"
          lineWidth={2.5}
          dashed
          dashSize={0.25}
          gapSize={0.15}
        />
      )}
      <TagProjector tags={tags} els={tagEls} />
      <OrbitControls makeDefault enableDamping={false} maxPolarAngle={Math.PI / 2.05} minDistance={4} maxDistance={60} />
    </>
  );
}

function nearestMask(masks: ShadowMask[], el: number, az: number): ShadowMask | null {
  let best: ShadowMask | null = null;
  let bd = Infinity;
  for (const m of masks) {
    const daz = Math.abs(((m.az - az + 540) % 360) - 180);
    const dd = Math.abs(m.el - el) * 10 + daz / 10;
    if (dd < bd) {
      bd = dd;
      best = m;
    }
  }
  return best;
}

const AZ_WORD: Record<number, string> = { 0: 'the top of the tile', 90: 'the right', 180: 'the bottom', 270: 'the left' };

interface ExploreProps {
  region: Region;
  origin: Origin;
  layers: Set<ExploreLayer>;
  onToggle: (l: ExploreLayer) => void;
  onAvailable: (available: ExploreLayer[]) => void;
  onClose: () => void;
}

export default function ExploreRegion({ region, origin, layers, onToggle, onAvailable, onClose }: ExploreProps): JSX.Element {
  const { data, error } = useExploreData(region, origin);
  const masks = region.shadow_masks;
  const elevations = useMemo(
    (): number[] => Array.from(new Set(masks.map((m: ShadowMask): number => m.el))).sort((a, b) => a - b),
    [masks],
  );
  const azimuths = useMemo((): number[] => Array.from(new Set(masks.map((m: ShadowMask): number => m.az))).sort((a, b) => a - b), [masks]);
  const [el, setEl] = useState<number>(elevations.includes(3) ? 3 : (elevations[0] ?? 3));
  const [azIdx, setAzIdx] = useState<number>(Math.max(0, azimuths.indexOf(90)));
  const az = azimuths[azIdx] ?? 90;
  const maskRef = useMemo((): ShadowMask | null => nearestMask(masks, el, az), [masks, el, az]);
  const mask = useMask(layers.has('shadow') ? maskRef : null, region.tile.size, origin);
  const note = data?.annotations?.shadow?.masks.find((m) => m.path === maskRef?.path);

  const available = useMemo((): ExploreLayer[] => {
    const a = data?.annotations;
    const out: ExploreLayer[] = masks.length ? ['shadow'] : [];
    if (a?.rim_drops?.drops.length) out.push('rim');
    if (a?.texture?.texture_empty_cells) out.push('texture');
    if (data?.slopeClasses) out.push('slope');
    if (a?.safest_patch) out.push('safe');
    return out;
  }, [data, masks.length]);
  useEffect((): void => onAvailable(available), [available, onAvailable]);

  // One sun direction; the profile's figure is averaged over all directions, so show both.
  const maskNote = maskRef
    ? note
      ? singleSunShadow(
          note.frac,
          maskRef.el,
          `from ${AZ_WORD[maskRef.az] ?? `${maskRef.az}°`}`,
          avgShadowAt(maskRef.el, region.hazards.shadow.metrics, region.extras),
        )
      : `Shadow with the sun from ${AZ_WORD[maskRef.az] ?? `${maskRef.az}°`} at ${maskRef.el}°`
    : null;
  const steep = data?.annotations?.steep_mask_summary;
  const tags = useMemo((): Tag3D[] => (data ? buildTags(data, layers, maskNote) : []), [data, layers, maskNote]);
  const tagEls = useRef<Map<string, HTMLSpanElement>>(new Map());

  return (
    <div className="x3d">
      <div className="x3d-canvas">
        {error ? (
          <div className="loading">Could not load this region: {error}</div>
        ) : !data ? (
          <Loading label={`Loading ${region.name} in 3D…`} />
        ) : (
          <SafeCanvas
            name={`Explore ${region.name} in 3D`}
            resetKey={region.id}
            dpr={[1, 1.75]}
            camera={{ position: [0, 21, 13], fov: 38, near: 0.05, far: 200 }}
            gl={{ antialias: true }}
          >
            <Scene d={data} layers={layers} mask={mask} tags={tags} tagEls={tagEls} />
          </SafeCanvas>
        )}
        <div className="x3d-tags" aria-hidden="true">
          {tags.map((t: Tag3D) => (
            <span
              key={t.key}
              className="x3d-tag"
              data-hz={t.hazard ?? undefined}
              ref={(el: HTMLSpanElement | null): void => {
                if (el) tagEls.current.set(t.key, el);
                else tagEls.current.delete(t.key);
              }}
            >
              {t.hazard && <HazardGlyph hazard={t.hazard} />}
              {t.text}
            </span>
          ))}
        </div>
        <div className="x3d-top">
          <span className="twin-tag">
            <strong>{region.name}</strong> <span className="muted">15 × 15 km · height ×{EXAG} · drag to orbit</span>
          </span>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            ← Back to the map
          </button>
        </div>
        {layers.has('slope') && steep && (
          <div className="x3d-legend">
            <span className="caption">Slope classes · illustrative thresholds</span>
            <span className="need-scale">
              {steep.class_names.map((name: string, i: number) => (
                <span key={name} className="need-step">
                  <span
                    className="swatch-key"
                    style={{ background: `rgb(${SLOPE_COLOURS[i]?.join(',') ?? '0,0,0'})` }}
                    aria-hidden="true"
                  />
                  {name.replace(' deg', '°').replace('deg', '°')}
                </span>
              ))}
            </span>
          </div>
        )}
      </div>
      <div className="x3d-controls">
        <div className="x3d-layers" role="group" aria-label="Layers">
          {(['shadow', 'rim', 'texture', 'slope', 'safe'] as ExploreLayer[])
            .filter((l: ExploreLayer): boolean => available.includes(l))
            .map((l: ExploreLayer) => (
              <button key={l} type="button" className="btn btn-sm" aria-pressed={layers.has(l)} onClick={(): void => onToggle(l)}>
                {LAYER_GLYPH[l] && <HazardGlyph hazard={LAYER_GLYPH[l] ?? 'slope'} />}
                {LAYER_LABEL[l]}
              </button>
            ))}
        </div>
        {layers.has('shadow') && elevations.length > 0 && (
          <div className="x3d-sun">
            <span className="field-label sun-label" id="x3d-el">
              <SunGlyph /> Sun elevation
            </span>
            <div className="seg" role="group" aria-labelledby="x3d-el">
              {elevations.map((e: number) => (
                <button key={e} type="button" aria-pressed={e === el} onClick={(): void => setEl(e)}>
                  {e}°
                </button>
              ))}
            </div>
            <label className="field-label sun-label x3d-az">
              <SunGlyph /> Sun direction
              <input
                className="range range-sun"
                type="range"
                min={0}
                max={Math.max(azimuths.length - 1, 0)}
                step={1}
                value={azIdx}
                onChange={(e): void => setAzIdx(Number(e.target.value))}
                aria-valuetext={`from ${AZ_WORD[az] ?? `${az}°`}`}
              />
              <span className="field-value">{az}°</span>
            </label>
          </div>
        )}
        {!data?.annotations && data && (
          <p className="caption">Rim, texture and slope layers appear when this region’s annotation file is available.</p>
        )}
      </div>
    </div>
  );
}
