// PatchDots for one matches.json light row (the 25 block values on each world), or nothing when the pipeline
// has no blocks for it. Shares (unit '%') are drawn as percentages; other units as they are.
import type { JSX } from 'react';
import { metricInfo } from '../content';
import type { HazardId, LightRow, Match } from '../types/contract';
import { PatchDots } from './PatchDots';

/** Headline measure per hazard (same as patchiness_summary.metric). */
const HEADLINE: Record<HazardId, string> = { shadow: 'shadow_frac_el3', rim: 'jump1km_p95_m', texture: 'empty_cell_frac_el3' };

function finite(v: (number | null)[] | null | undefined): number[] {
  return (v ?? []).filter((x: number | null): x is number => typeof x === 'number' && Number.isFinite(x));
}

/** The match's headline light row: patchiness_summary.metric when present, else the hazard's headline metric. */
export function headlineLight(match: Match): LightRow | null {
  const key = match.patchiness_summary?.metric ?? HEADLINE[match.hazard];
  return match.lights.find((l: LightRow): boolean => l.metric === key) ?? null;
}

export function PatchFor({ light, hazard }: { light: LightRow | null; hazard: HazardId }): JSX.Element | null {
  if (!light) return null;
  const moon = finite(light.moon_blocks);
  const earth = finite(light.earth_blocks);
  if (moon.length < 2 || earth.length < 2) return null;
  const mi = metricInfo(light.metric);
  const share = mi.unit === '%';
  const scale = share ? 100 : 1;
  return (
    <PatchDots
      label={mi.label}
      unit={mi.unit}
      moonBlocks={moon.map((v: number): number => v * scale)}
      earthBlocks={earth.map((v: number): number => v * scale)}
      moonValue={light.moon * scale}
      earthValue={light.earth * scale}
      format={(v: number): string => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1))}
      hazard={hazard}
      patchiness={light.patchiness ?? null}
    />
  );
}
