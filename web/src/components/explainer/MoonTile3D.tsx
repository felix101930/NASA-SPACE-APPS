// Step 1 of the explainer: one real Moon tile in 3D, with an overlay for each danger we measure.
// Loaded lazily so three.js stays out of the Story screen's first load.
import { useEffect, useMemo, useState, type JSX } from 'react';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { LoadedTile } from '../../data/tiles';
import { computeShadowMask, hillshade, type Grid } from '../../lib/terrain';
import { useTerrainGeometry } from '../terrainGeometry';
import { HazardGlyph, SunGlyph } from '../Glyphs';
import { SafeCanvas } from '../SafeCanvas';

export type Overlay = 'slope' | 'shadow' | 'rim' | 'texture';

const SUN_EL = 3;
const SUN_AZ = 90;
const EXAG = 2;

interface RimLine {
  /** Profile end points in pixel coords, 3 km long, the 1 km jump in the middle third. */
  a: [number, number];
  b: [number, number];
  drop: number;
  profile: number[];
}

interface Analysis {
  base: Uint8ClampedArray;
  slope: Float32Array;
  shadow: Uint8Array;
  shadowFrac: number;
  dots: [number, number][];
  emptyFrac: number;
  rim: RimLine;
}

function downsample2(g: Grid): Grid {
  const n = Math.floor(g.size / 2);
  const out = new Float32Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const i = 2 * r * g.size + 2 * c;
      out[r * n + c] = (g.data[i] + g.data[i + 1] + g.data[i + g.size] + g.data[i + g.size + 1]) / 4;
    }
  }
  return { data: out, size: n, res: g.res * 2 };
}

function analyse(g: Grid): Analysis {
  const n = g.size;
  const d = g.data;
  const at = (r: number, c: number): number => d[Math.min(Math.max(r, 0), n - 1) * n + Math.min(Math.max(c, 0), n - 1)];
  const base = hillshade(g, 315, 30);

  const slope = new Float32Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const dzdx = (at(r, c + 1) - at(r, c - 1)) / (2 * g.res);
      const dzdy = (at(r - 1, c) - at(r + 1, c)) / (2 * g.res);
      slope[r * n + c] = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
    }
  }

  // Shadow at a 3° sun from the east, on a 2x coarser grid (fast), sampled back up.
  const g2 = downsample2(g);
  const m2 = computeShadowMask(g2, SUN_EL, SUN_AZ, g2.size);
  const shadow = new Uint8Array(n * n);
  let sh = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const v = m2[Math.min(g2.size - 1, r >> 1) * g2.size + Math.min(g2.size - 1, c >> 1)];
      shadow[r * n + c] = v;
      sh += v;
    }
  }

  // Trackable points: strongest edge per small cell on a low-sun hillshade (a simple stand-in for FAST corners).
  const low = hillshade(g, SUN_AZ, SUN_EL);
  const cell = 16;
  const dots: [number, number][] = [];
  let cells = 0;
  let empty = 0;
  for (let r0 = 1; r0 < n - cell; r0 += cell) {
    for (let c0 = 1; c0 < n - cell; c0 += cell) {
      cells++;
      let best = 0;
      let br = 0;
      let bc = 0;
      for (let r = r0; r < r0 + cell; r++) {
        for (let c = c0; c < c0 + cell; c++) {
          const gx = low[r * n + c + 1] - low[r * n + c - 1];
          const gy = low[(r + 1) * n + c] - low[(r - 1) * n + c];
          const m = gx * gx + gy * gy;
          if (m > best) {
            best = m;
            br = r;
            bc = c;
          }
        }
      }
      if (best > 400) dots.push([bc, br]);
      else empty++;
    }
  }

  // A step-shaped height jump: big over 1 km, flatter on either side (a rim, not a long hillside).
  const L = Math.round(1000 / g.res);
  let rimBest = { drop: 0, score: -Infinity, r: n / 2, c: n / 2, dr: 0, dc: 1 };
  const dirs: [number, number][] = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];
  for (let r = L; r < n - 2 * L; r += 8) {
    for (let c = L + 1; c < n - 2 * L; c += 8) {
      for (const [dr, dc] of dirs) {
        const len = dr && dc ? L / Math.SQRT2 : L;
        const r1 = Math.round(r + dr * len);
        const c1 = Math.round(c + dc * len);
        if (r1 < 0 || r1 >= n || c1 < 0 || c1 >= n) continue;
        const h1 = at(r, c);
        const h2 = at(r1, c1);
        const h0 = at(Math.round(r - dr * len), Math.round(c - dc * len));
        const h3 = at(Math.round(r + dr * 2 * len), Math.round(c + dc * 2 * len));
        const drop = Math.abs(h2 - h1);
        const score = drop - 0.8 * (Math.abs(h1 - h0) + Math.abs(h3 - h2));
        if (score > rimBest.score) rimBest = { drop, score, r, c, dr, dc };
      }
    }
  }
  const len = rimBest.dr && rimBest.dc ? L / Math.SQRT2 : L;
  const clampPx = (v: number): number => Math.min(Math.max(v, 0), n - 1);
  const a: [number, number] = [clampPx(rimBest.c - rimBest.dc * len), clampPx(rimBest.r - rimBest.dr * len)];
  const b: [number, number] = [clampPx(rimBest.c + rimBest.dc * 2 * len), clampPx(rimBest.r + rimBest.dr * 2 * len)];
  const profile: number[] = [];
  for (let i = 0; i <= 90; i++) {
    const t = i / 90;
    profile.push(at(Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[0] + (b[0] - a[0]) * t)));
  }

  return {
    base,
    slope,
    shadow,
    shadowFrac: sh / (n * n),
    dots,
    emptyFrac: cells ? empty / cells : 0,
    rim: { a, b, drop: rimBest.drop, profile },
  };
}

const SLOPE_STOPS: [number, [number, number, number]][] = [
  [0, [29, 32, 38]],
  [10, [74, 71, 64]],
  [20, [138, 133, 123]],
  [30, [237, 234, 228]],
];

function slopeColour(s: number): [number, number, number] {
  for (let i = 1; i < SLOPE_STOPS.length; i++) {
    const [s1, c1] = SLOPE_STOPS[i];
    const [s0, c0] = SLOPE_STOPS[i - 1];
    if (s <= s1) {
      const t = (s - s0) / (s1 - s0);
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
    }
  }
  return SLOPE_STOPS[SLOPE_STOPS.length - 1][1];
}

function paint(an: Analysis, n: number, overlay: Overlay): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = n;
  cv.height = n;
  const ctx = cv.getContext('2d');
  if (ctx) {
    const im = ctx.createImageData(n, n);
    const px = im.data;
    for (let i = 0; i < n * n; i++) {
      const b = an.base[i];
      let r = b;
      let g = b;
      let bl = b;
      if (overlay === 'slope') {
        const [sr, sg, sb] = slopeColour(an.slope[i]);
        r = sr * 0.8 + b * 0.2;
        g = sg * 0.8 + b * 0.2;
        bl = sb * 0.8 + b * 0.2;
      } else if (overlay === 'shadow') {
        if (an.shadow[i]) {
          r = b * 0.12 + 124 * 0.5;
          g = b * 0.12 + 196 * 0.5;
          bl = b * 0.12 + 242 * 0.5;
        }
      } else {
        const k = overlay === 'texture' ? 0.5 : 0.65;
        r = b * k;
        g = b * k;
        bl = b * k;
      }
      px[i * 4] = r;
      px[i * 4 + 1] = g;
      px[i * 4 + 2] = bl;
      px[i * 4 + 3] = 255;
    }
    ctx.putImageData(im, 0, 0);
    if (overlay === 'rim') {
      ctx.strokeStyle = '#0a0b0e';
      ctx.lineWidth = 9;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(an.rim.a[0], an.rim.a[1]);
      ctx.lineTo(an.rim.b[0], an.rim.b[1]);
      ctx.stroke();
      ctx.strokeStyle = '#f07b4a';
      ctx.lineWidth = 5;
      ctx.stroke();
    }
    if (overlay === 'texture') {
      ctx.fillStyle = '#d98cc4';
      for (const [c, r] of an.dots) {
        ctx.beginPath();
        ctx.arc(c, r, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function TileMesh({ tile, map }: { tile: LoadedTile; map: THREE.Texture }): JSX.Element {
  const geom = useTerrainGeometry(tile, EXAG);
  return (
    <mesh geometry={geom}>
      <meshBasicMaterial map={map} />
    </mesh>
  );
}

function RimProfile({ rim }: { rim: RimLine }): JSX.Element {
  const w = 240;
  const h = 96;
  const min = Math.min(...rim.profile);
  const max = Math.max(...rim.profile);
  const span = Math.max(max - min, 1);
  const pts = rim.profile.map(
    (v: number, i: number): string =>
      `${((i / (rim.profile.length - 1)) * w).toFixed(1)},${(h - 8 - ((v - min) / span) * (h - 24)).toFixed(1)}`,
  );
  return (
    <svg
      className="rim-profile"
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={`Height along the orange line: about ${Math.round(rim.drop)} metres of change within 1 kilometre`}
    >
      <rect x={w / 3} y="0" width={w / 3} height={h} fill="rgba(240,123,74,0.10)" />
      <polyline points={`0,${h} ${pts.join(' ')} ${w},${h}`} fill="rgba(240,123,74,0.18)" stroke="none" />
      <polyline points={pts.join(' ')} fill="none" stroke="#f07b4a" strokeWidth="2" />
      <text x={w / 3 + 6} y="14" fill="#edeae4" fontSize="12" fontFamily="IBM Plex Sans">
        {Math.round(rim.drop)} m in 1 km
      </text>
    </svg>
  );
}

const OVERLAY_TEXT: Record<Overlay, string> = {
  slope: 'Steepness: brighter is steeper (30° and more is white).',
  shadow: 'Blue: ground in shadow when the sun sits 3° above the horizon.',
  rim: 'Orange line: a sudden drop at a crater rim, the kind of cliff that confused Hakuto-R.',
  texture: 'Pink dots: points a navigation camera could lock on to. Empty patches are hard to track.',
};

export default function MoonTile3D({ tile, overlay, regionName }: { tile: LoadedTile; overlay: Overlay; regionName: string }): JSX.Element {
  const an = useMemo((): Analysis => analyse(tile.filled), [tile]);
  const n = tile.filled.size;
  const [textures, setTextures] = useState<Partial<Record<Overlay, THREE.CanvasTexture>>>({});
  const tex = textures[overlay];
  useEffect((): void => {
    if (!textures[overlay]) setTextures((t) => ({ ...t, [overlay]: paint(an, n, overlay) }));
  }, [an, n, overlay, textures]);
  useEffect(
    (): (() => void) => (): void => {
      Object.values(textures).forEach((t: THREE.CanvasTexture | undefined): void => t?.dispose());
    },
    // dispose everything when the tile changes or the component unmounts
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [an],
  );
  const reduce = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  return (
    <div className="ex-3d">
      <SafeCanvas
        name="3D Moon tile"
        resetKey={regionName}
        dpr={[1, 1.75]}
        camera={{ position: [0, 13, 15], fov: 38, near: 0.05, far: 200 }}
        gl={{ antialias: true }}
      >
        <color attach="background" args={['#1a1d23']} />
        {tex && <TileMesh tile={tile} map={tex} />}
        <OrbitControls enableZoom={false} enablePan={false} autoRotate={!reduce} autoRotateSpeed={0.5} maxPolarAngle={Math.PI / 2.1} />
      </SafeCanvas>
      <div className="ex-3d-tag">
        <strong>{regionName}</strong> <span className="muted">Moon · 15 × 15 km · height ×{EXAG}</span>
      </div>
      <div className="ex-3d-legend">
        <span className="ex-legend-title">
          <HazardGlyph hazard={overlay} />
          {OVERLAY_TEXT[overlay]}
        </span>
        {overlay === 'slope' && (
          <span className="slope-ramp" aria-hidden="true">
            <span>flat</span>
            <span className="slope-ramp-bar" />
            <span>30°+</span>
          </span>
        )}
        {overlay === 'shadow' && (
          <span className="caption ex-sun">
            <SunGlyph /> Sun from the east · {Math.round(an.shadowFrac * 100)}% of this tile in shadow
          </span>
        )}
        {overlay === 'texture' && (
          <span className="caption">{Math.round(an.emptyFrac * 100)}% of small patches have no trackable point</span>
        )}
        {overlay === 'rim' && <RimProfile rim={an.rim} />}
      </div>
    </div>
  );
}
