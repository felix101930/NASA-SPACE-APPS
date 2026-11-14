import type { HazardId, Level, Light } from './types/contract';

export interface HazardInfo {
  id: HazardId;
  name: string;
  short: string;
  lesson: string;
  mission: string;
}

export const HAZARDS: Record<HazardId, HazardInfo> = {
  shadow: {
    id: 'shadow',
    name: 'Long low-sun shadows',
    short: 'Shadow',
    mission: 'IM-2',
    lesson: 'Low sun turns much of the ground black. Can the cameras and altimeter cope?',
  },
  rim: {
    id: 'rim',
    name: 'Crater-rim height jumps',
    short: 'Rim jump',
    mission: 'Hakuto-R',
    lesson: 'A cliff makes the measured altitude jump. Will the software trust its sensor?',
  },
  texture: {
    id: 'texture',
    name: 'Too little texture for cameras',
    short: 'Texture',
    mission: 'Ingenuity · IM-2',
    lesson: 'Smooth, featureless ground gives visual navigation nothing to lock on to.',
  },
};

export interface MetricInfo {
  label: string;
  unit: string;
  /** Format a raw value for display. */
  fmt: (v: number) => string;
  help: string;
}

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const m = (v: number): string => `${v.toFixed(0)} m`;

export const METRICS: Record<string, MetricInfo> = {
  shadow_frac_el1: { label: 'Shadowed area, sun at 1°', unit: '%', fmt: pct, help: 'Share of the 15 × 15 km tile in cast shadow' },
  shadow_frac_el3: { label: 'Shadowed area, sun at 3°', unit: '%', fmt: pct, help: 'Share of the tile in cast shadow' },
  shadow_frac_el5: { label: 'Shadowed area, sun at 5°', unit: '%', fmt: pct, help: 'Share of the tile in cast shadow' },
  shadow_frac_timeweighted: { label: 'Shadowed area, time-weighted', unit: '%', fmt: pct, help: 'Weighted by how long the sun sits at each elevation' },
  jump1km_p95_m: { label: 'Height jump over 1 km (P95)', unit: 'm', fmt: m, help: '|h(x + 1 km) − h(x)| along tracks in 16 directions' },
  jump1km_p99_m: { label: 'Height jump over 1 km (P99)', unit: 'm', fmt: m, help: 'The 99th percentile of the same jumps' },
  frac_track_over_500m: { label: 'Track with jumps over 500 m', unit: '%', fmt: pct, help: 'Illustrative threshold. ispace has not published its own.' },
  fast_per_km2_el3: { label: 'Camera keypoints per km², sun 3°', unit: '/km²', fmt: (v: number): string => `${v.toFixed(1)} /km²`, help: 'FAST corners on a hillshade with cast shadows (proxy)' },
  empty_cell_frac_el3: { label: 'Featureless 1 km cells, sun 3°', unit: '%', fmt: pct, help: 'Cells with no keypoint at all' },
  slope_p50_deg: { label: 'Median slope', unit: '°', fmt: (v: number): string => `${v.toFixed(1)}°`, help: 'At 30 m baseline' },
  slope_p90_deg: { label: 'Slope, 90th percentile', unit: '°', fmt: (v: number): string => `${v.toFixed(1)}°`, help: 'At 30 m baseline' },
};

export function metricInfo(key: string): MetricInfo {
  return (
    METRICS[key] ?? {
      label: key.replace(/_/g, ' '),
      unit: '',
      fmt: (v: number): string => (Math.abs(v) < 10 ? v.toFixed(3) : v.toFixed(1)),
      help: '',
    }
  );
}

export const LEVEL_LABEL: Record<Level, string> = { low: 'Low', med: 'Medium', high: 'High' };

export const LIGHT_LABEL: Record<Light, string> = { green: 'Close', amber: 'Partial', red: 'Far' };

export interface FailureStory {
  mission: string;
  year: string;
  hazard: HazardId;
  body: string;
  sourceLabel: string;
  sourceUrl: string;
}

// Wording restricted to the team's approved phrasings (see docs/research-synthesis.md).
export const FAILURES: FailureStory[] = [
  {
    mission: 'Hakuto-R Mission 1',
    year: '2023',
    hazard: 'rim',
    body: 'The lander passed over a crater-rim cliff ~3 km high. Its software rejected the altitude jump as sensor error and believed it had landed while ~5 km up.',
    sourceLabel: 'ispace, 26 May 2023',
    sourceUrl: 'https://www.ispace-inc.com/2023/05/26/ispace-announces-results-of-the-hakuto-r-mission-1-lunar-landing/',
  },
  {
    mission: 'IM-2 Athena',
    year: '2025',
    hazard: 'shadow',
    body: 'Intuitive Machines said on its May 2025 earnings call that altimeter noise and long low-sun shadows contributed; its optical navigation’s reference imagery didn’t capture how craters look at low altitude.',
    sourceLabel: 'Intuitive Machines earnings call, May 2025, as reported by The Register (14 May 2025)',
    sourceUrl: '',
  },
  {
    mission: 'Ingenuity, flight 72',
    year: '2024',
    hazard: 'texture',
    body: 'NASA’s investigation: “Lack of surface texture gave the navigation system too little information to work with”, over steep, relatively featureless sand ripples.',
    sourceLabel: 'NASA JPL, 11 Dec 2024',
    sourceUrl: 'https://www.jpl.nasa.gov/news/nasa-performs-first-aircraft-accident-investigation-on-another-world/',
  },
];
