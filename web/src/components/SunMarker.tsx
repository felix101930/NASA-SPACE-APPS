// A visible sun for the 3D views: a glowing disc on the true sun direction, a faint horizon ring around the tile
// with ticks every 45°, and a dashed ray from the sun toward the tile centre (the way the light travels).
//
// Angles: `el` is the TRUE sun elevation (degrees above the horizon) and `az` the azimuth clockwise from the
// tile's top (grid +y = scene −z; right = +x). The marker is never exaggerated: a 1° sun sits 1° above the ring.
// Scenes that raise their light to cancel vertical exaggeration (3D side by side) must pass the true elevation
// here and use the SAME azimuth for the light, so shadows always point straight away from this marker.
//
// Everything lives in the scene (it orbits with the terrain). No drei <Html>: text tags are DOM overlays placed
// by each view's own projector, using sunPosition() for the anchor.
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useFrame, type RootState } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import * as THREE from 'three';
import '../styles/sun.css';

/** --sun and --sun-hover from styles.css (canvas materials cannot read CSS variables). */
const SUN = '#f3b54a';
const SUN_CORE = '#ffc766';
/** --text, used faintly for the horizon ring. */
const RING = '#edeae4';

/** Radius of the sun's circle, as a multiple of the tile width (the tile's corners sit at 0.71×). */
export const SUN_RING_FACTOR = 0.76;

export interface SunGeometry {
  /** Ring / sun radius in scene units. */
  radius: number;
  /** Height of the horizon plane in scene units (the tile's lowest point). */
  baseY: number;
}

export function sunGeometry(extent: number, baseY: number): SunGeometry {
  return { radius: Math.max(1, extent * SUN_RING_FACTOR), baseY: Number.isFinite(baseY) ? baseY : 0 };
}

/** Scene position of the sun at true elevation `el` and azimuth `az` (both degrees). */
export function sunPosition(el: number, az: number, g: SunGeometry): [number, number, number] {
  const e = (el * Math.PI) / 180;
  const a = (az * Math.PI) / 180;
  return [Math.sin(a) * Math.cos(e) * g.radius, g.baseY + Math.sin(e) * g.radius, -Math.cos(a) * Math.cos(e) * g.radius];
}

function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduce, setReduce] = useState<boolean>((): boolean => window.matchMedia(query).matches);
  useEffect((): (() => void) => {
    const mq = window.matchMedia(query);
    const on = (e: MediaQueryListEvent): void => setReduce(e.matches);
    mq.addEventListener('change', on);
    return (): void => mq.removeEventListener('change', on);
  }, []);
  return reduce;
}

/** Radial gradient sprite texture (white; tinted by the material colour). */
function glowTexture(stops: [number, number][]): THREE.CanvasTexture {
  const n = 128;
  const cv = document.createElement('canvas');
  cv.width = n;
  cv.height = n;
  const ctx = cv.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    for (const [at, alpha] of stops) g.addColorStop(at, `rgba(255,255,255,${alpha})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, n, n);
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function circlePoints(radius: number, y: number, steps: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    out.push([Math.sin(a) * radius, y, -Math.cos(a) * radius]);
  }
  return out;
}

interface Tick {
  key: number;
  pts: [number, number, number][];
  main: boolean;
}

export interface SunMarkerProps {
  /** True sun elevation in degrees (not raised for exaggeration). */
  el: number;
  /** Azimuth in degrees, clockwise from the tile's top. */
  az: number;
  /** Tile width in scene units. */
  extent: number;
  /** Height of the tile's lowest point in scene units (horizon plane). */
  baseY: number;
}

export function SunMarker({ el, az, extent, baseY }: SunMarkerProps): JSX.Element {
  const reduce = usePrefersReducedMotion();
  const geo = useMemo((): SunGeometry => sunGeometry(extent, baseY), [extent, baseY]);
  const pos = useMemo((): [number, number, number] => sunPosition(el, az, geo), [el, az, geo]);
  const discTex = useMemo((): THREE.CanvasTexture => glowTexture([[0, 1], [0.55, 1], [0.7, 0.35], [1, 0]]), []);
  const haloTex = useMemo((): THREE.CanvasTexture => glowTexture([[0, 0.55], [0.3, 0.28], [0.65, 0.08], [1, 0]]), []);
  useEffect((): (() => void) => (): void => {
    discTex.dispose();
    haloTex.dispose();
  }, [discTex, haloTex]);

  const halo = useRef<THREE.Sprite>(null);
  const haloSize = geo.radius * 0.2;
  const discSize = geo.radius * 0.07;
  useFrame(({ clock }: RootState): void => {
    const h = halo.current;
    if (!h) return;
    const k = reduce ? 1 : 1 + 0.07 * Math.sin(clock.getElapsedTime() * 1.6);
    h.scale.set(haloSize * k, haloSize * k, 1);
  });

  const ring = useMemo((): [number, number, number][] => circlePoints(geo.radius, geo.baseY, 160), [geo]);
  const ticks = useMemo(
    (): Tick[] =>
      [0, 45, 90, 135, 180, 225, 270, 315].map((deg: number): Tick => {
        const a = (deg * Math.PI) / 180;
        const r0 = geo.radius;
        const r1 = geo.radius * (deg === 0 ? 1.09 : 1.045);
        return {
          key: deg,
          main: deg === 0,
          pts: [
            [Math.sin(a) * r0, geo.baseY, -Math.cos(a) * r0],
            [Math.sin(a) * r1, geo.baseY, -Math.cos(a) * r1],
          ],
        };
      }),
    [geo],
  );
  // Foot of the sun on the ring, then the light's path toward the tile centre.
  const ray = useMemo((): [number, number, number][] => [pos, [0, geo.baseY, 0]], [pos, geo]);
  const foot = useMemo((): [number, number, number][] => {
    const a = (az * Math.PI) / 180;
    return [
      [Math.sin(a) * geo.radius, geo.baseY, -Math.cos(a) * geo.radius],
      pos,
    ];
  }, [az, geo, pos]);

  return (
    <group>
      <Line points={ring} color={RING} lineWidth={1} transparent opacity={0.28} />
      {ticks.map((t: Tick) => (
        <Line key={t.key} points={t.pts} color={RING} lineWidth={t.main ? 2 : 1.25} transparent opacity={t.main ? 0.7 : 0.45} />
      ))}
      <Line points={foot} color={SUN} lineWidth={1.5} transparent opacity={0.8} />
      <Line points={ray} color={SUN} lineWidth={1.5} dashed dashSize={0.35} gapSize={0.25} transparent opacity={0.85} />
      <sprite ref={halo} position={pos} scale={[haloSize, haloSize, 1]} renderOrder={10}>
        <spriteMaterial map={haloTex} color={SUN} transparent depthWrite={false} depthTest={false} blending={THREE.AdditiveBlending} />
      </sprite>
      <sprite position={pos} scale={[discSize, discSize, 1]} renderOrder={11}>
        <spriteMaterial map={discTex} color={SUN_CORE} transparent depthWrite={false} depthTest={false} />
      </sprite>
    </group>
  );
}
