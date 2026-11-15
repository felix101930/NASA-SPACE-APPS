// The "25 patches" colour scale and formatting, shared by the 2D PatchGrid and the 3D patch overlay so the
// same value gets the same colour everywhere.
//
// Block order (pipeline/match/moon_ref.py _blocks + patchiness.py): index k = row * 5 + col, row 0 = the
// tile's top row (Moon: grid +y, not north; Earth: north), col 0 = the left edge. Each block is 100 × 100 px
// of the 30 m tile = 3 × 3 km. Shares are 0–1, rim jumps in metres, keypoints per km², slopes in degrees.
import { metricInfo } from '../content';
import type { HazardId, LightRow } from '../types/contract';

export const PATCH_N = 5;
export const PATCH_COUNT = PATCH_N * PATCH_N;

export type PatchUnit = 'share' | 'm' | 'per_km2' | 'deg';

export type RGB = readonly [number, number, number];

/** Low end of every ramp: a step above the card surface, so the lowest patch still reads as a patch. */
const RAMP_LOW: RGB = [0x26, 0x2a, 0x32];
/** High end per hazard (the --hz-* tokens); neutral text tone when no hazard is given. */
const RAMP_HIGH: Record<HazardId | 'neutral', RGB> = {
  shadow: [0x7c, 0xc4, 0xf2],
  rim: [0xf0, 0x7b, 0x4a],
  texture: [0xd9, 0x8c, 0xc4],
  neutral: [0xed, 0xea, 0xe4],
};

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
}

/**
 * One sequential, single-hue ramp: dark (low) to the hazard hue (high), mixed in linear light so luminance rises
 * steadily. Lightness alone carries the order, which keeps it readable for every kind of colour vision.
 */
export function patchRGB(t: number, hazard?: HazardId): RGB {
  const u = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  const hi = RAMP_HIGH[hazard ?? 'neutral'];
  const mix = (i: 0 | 1 | 2): number => linearToSrgb(srgbToLinear(RAMP_LOW[i]) * (1 - u) + srgbToLinear(hi[i]) * u);
  return [mix(0), mix(1), mix(2)];
}

export function patchColor(t: number, hazard?: HazardId): string {
  const [r, g, b] = patchRGB(t, hazard);
  return `rgb(${r} ${g} ${b})`;
}

/** Relative luminance 0–1 (WCAG), to pick dark or light value text on a cell. */
export function luminance(rgb: RGB): number {
  return 0.2126 * srgbToLinear(rgb[0]) + 0.7152 * srgbToLinear(rgb[1]) + 0.0722 * srgbToLinear(rgb[2]);
}

/** Position 0–1 of v on the shared scale (mid-scale when the scale has no width). */
export function scaleT(v: number, min: number, max: number): number {
  if (!(max - min > 1e-12)) return 0.5;
  return (v - min) / (max - min);
}

export function unitOf(metric: string): PatchUnit {
  const u = metricInfo(metric).unit;
  if (u === '%') return 'share';
  if (u === 'm') return 'm';
  if (u === '°') return 'deg';
  return 'per_km2';
}

/** Value as shown on screen, e.g. 0.481 -> "48%", 312.4 -> "312 m". `bare` drops the unit (inside cells). */
export function fmtPatch(v: number, unit: PatchUnit, bare: boolean = false): string {
  if (!Number.isFinite(v)) return '—';
  if (unit === 'share') {
    const p = v * 100;
    const s = Math.abs(p) < 10 && p !== 0 ? p.toFixed(1) : Math.round(p).toString();
    return `${s}%`;
  }
  if (unit === 'm') return bare ? Math.round(v).toLocaleString('en-US') : `${Math.round(v).toLocaleString('en-US')} m`;
  if (unit === 'deg') return `${v.toFixed(Math.abs(v) < 10 ? 1 : 0)}°`;
  const s = v.toFixed(Math.abs(v) < 10 ? 1 : 0);
  return bare ? s : `${s} /km²`;
}

/** The number as displayed by fmtPatch (shares as 0–1), so range checks agree with what the reader sees. */
export function shownValue(v: number, unit: PatchUnit): number {
  if (!Number.isFinite(v)) return v;
  if (unit === 'share') {
    const p = v * 100;
    return (Math.abs(p) < 10 ? Math.round(p * 10) / 10 : Math.round(p)) / 100;
  }
  if (unit === 'm') return Math.round(v);
  const d = Math.abs(v) < 10 ? 10 : 1;
  return Math.round(v * d) / d;
}

/** "59–80%", "214–260 m": a range with the unit once. */
export function fmtPatchRange(r: readonly [number, number], unit: PatchUnit): string {
  if (unit === 'share') return `${fmtPatch(r[0], unit).replace('%', '')}–${fmtPatch(r[1], unit)}`;
  if (unit === 'deg') return `${fmtPatch(r[0], unit).replace('°', '')}–${fmtPatch(r[1], unit)}`;
  return `${fmtPatch(r[0], unit, true)}–${fmtPatch(r[1], unit)}`;
}

/** Linear-interpolated percentile (numpy default), p in 0..100. */
function percentile(sorted: number[], p: number): number {
  const pos = ((sorted.length - 1) * p) / 100;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** The middle half (p25–p75) of the patch values; null with fewer than 4 finite values. */
export function middleHalf(values: readonly (number | null)[]): [number, number] | null {
  const v = values.filter((x: number | null): x is number => typeof x === 'number' && Number.isFinite(x));
  if (v.length < 4) return null;
  v.sort((a: number, b: number): number => a - b);
  return [percentile(v, 25), percentile(v, 75)];
}

/** 25 numbers (non-finite as NaN) or null when the row has no usable patch values. */
export function patchValues(v: readonly (number | null)[] | null | undefined): number[] | null {
  if (!v || v.length !== PATCH_COUNT) return null;
  const out = v.map((x: number | null): number => (typeof x === 'number' && Number.isFinite(x) ? x : Number.NaN));
  return out.filter(Number.isFinite).length >= 4 ? out : null;
}

export interface PatchPair {
  metric: string;
  label: string;
  unit: PatchUnit;
  moon: number[];
  earth: number[];
  /** Middle half of the Moon's 25 patches. */
  range: [number, number];
  /** Shared colour scale over both worlds' patches. */
  scaleMin: number;
  scaleMax: number;
  /** Whole-square values. */
  moonWhole: number;
  earthWhole: number;
}

/** Both worlds' patches for one light row on one shared scale, or null when either side is missing. */
export function patchPair(light: LightRow | null | undefined): PatchPair | null {
  if (!light) return null;
  const moon = patchValues(light.moon_blocks);
  const earth = patchValues(light.earth_blocks);
  if (!moon || !earth) return null;
  const range = middleHalf(moon);
  if (!range) return null;
  const all = [...moon, ...earth].filter(Number.isFinite);
  return {
    metric: light.metric,
    label: metricInfo(light.metric).label,
    unit: unitOf(light.metric),
    moon,
    earth,
    range,
    scaleMin: Math.min(...all),
    scaleMax: Math.max(...all),
    moonWhole: light.moon,
    earthWhole: light.earth,
  };
}

export type RangePlace = 'inside' | 'above' | 'below';

/** Where v sits against r, judged on the values as displayed (so "54%" is never outside "47–54%"). */
export function placeInRange(v: number, r: readonly [number, number], unit: PatchUnit): RangePlace {
  const x = shownValue(v, unit);
  if (x < shownValue(r[0], unit)) return 'below';
  return x > shownValue(r[1], unit) ? 'above' : 'inside';
}
