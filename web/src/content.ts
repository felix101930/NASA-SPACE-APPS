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
  shadow_frac_el1: { label: 'Shadowed area, sun at 1°', unit: '%', fmt: pct, help: 'Share of the 15 × 15 km tile in cast shadow, averaged over all sun directions' },
  shadow_frac_el3: { label: 'Shadowed area, sun at 3°', unit: '%', fmt: pct, help: 'Share of the tile in cast shadow, averaged over all sun directions' },
  shadow_frac_el5: { label: 'Shadowed area, sun at 5°', unit: '%', fmt: pct, help: 'Share of the tile in cast shadow, averaged over all sun directions' },
  shadow_frac_timeweighted: {
    label: 'Shadowed area, time-weighted',
    unit: '%',
    fmt: pct,
    help: 'Weighted by how long the sun sits at each elevation',
  },
  jump1km_p95_m: { label: 'Height jump over 1 km (P95)', unit: 'm', fmt: m, help: '|h(x + 1 km) − h(x)| along tracks in 16 directions' },
  jump1km_p99_m: { label: 'Height jump over 1 km (P99)', unit: 'm', fmt: m, help: 'The 99th percentile of the same jumps' },
  frac_track_over_500m: {
    label: 'Track with jumps over 500 m',
    unit: '%',
    fmt: pct,
    help: 'Illustrative threshold. ispace has not published its own.',
  },
  fast_per_km2_el3: {
    label: 'Camera keypoints per km², sun 3°',
    unit: '/km²',
    fmt: (v: number): string => `${v.toFixed(1)} /km²`,
    help: 'FAST corners on a hillshade with cast shadows (proxy)',
  },
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

/**
 * One definition of a best match's overall fit, shared with pipeline/match/summary.py: distance in multiples of the
 * Moon region's normal variation (IQR); under 0.5 close, under 1.5 partial, 1.5 or more far.
 */
export const CLOSE_DISTANCE = 0.5;
export const PARTIAL_DISTANCE = 1.5;

export function distanceFit(d: number | null | undefined): Light | null {
  if (typeof d !== 'number' || !Number.isFinite(d)) return null;
  if (d < CLOSE_DISTANCE) return 'green';
  if (d < PARTIAL_DISTANCE) return 'amber';
  return 'red';
}

export interface FailureStory {
  mission: string;
  year: string;
  hazard: HazardId;
  /** 6–10 word front-of-card summary; the full fact-checked sentence is `body`. */
  summary: string;
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
    summary: 'Its software rejected a real crater-rim drop as sensor error.',
    body: 'Hakuto-R crossed a crater-rim cliff about 3 km high. Its software rejected the sudden altitude jump as a sensor error and estimated it was on the surface while still about 5 km up.',
    sourceLabel: 'ispace, 26 May 2023',
    sourceUrl: 'https://www.ispace-inc.com/2023/05/26/ispace-announces-results-of-the-hakuto-r-mission-1-lunar-landing/',
  },
  {
    mission: 'IM-2 Athena',
    year: '2025',
    hazard: 'shadow',
    summary: 'Altimeter noise, long shadows and mismatched crater images all contributed.',
    body: 'Intuitive Machines’ CEO said altimeter signal noise, long shadows from low-angle sunlight, and navigation imagery taken from 100 km that didn’t match how craters look lower down all contributed.',
    sourceLabel: 'Intuitive Machines earnings call, 13 May 2025, as reported by The Register (14 May 2025)',
    sourceUrl: 'https://www.theregister.com/2025/05/14/intuitive_machines_postmortem/',
  },
  {
    mission: 'Ingenuity, flight 72',
    year: '2024',
    hazard: 'texture',
    summary: 'Featureless sand ripples likely left navigation too little to track.',
    body: 'NASA’s most likely explanation is that a lack of surface texture over steep, relatively featureless sand ripples gave Ingenuity’s navigation system too little information to work with.',
    sourceLabel: 'NASA JPL, 11 Dec 2024',
    sourceUrl: 'https://www.jpl.nasa.gov/news/nasa-performs-first-aircraft-accident-investigation-on-another-world/',
  },
];

export const FAILURES_HEADING = 'Three missions where terrain and lighting fooled the navigation';
export const FOURTH_MEASURE = 'A fourth measure, slope, matters for walking and touchdown.';

// ---------------------------------------------------------------------------------------------
// Headline numbers and labels used by the redesigned screens
// ---------------------------------------------------------------------------------------------

export type ProfileRowId = HazardId | 'slope';

export interface Headline {
  /** Metric key inside the region's hazard metrics (slope: slope.metrics). */
  key: string;
  /** Big number, e.g. "48%". */
  value: (v: number) => string;
  /** What the number is, in plain words. */
  unit: string;
}

export const HEADLINE: Record<ProfileRowId, Headline> = {
  shadow: { key: 'shadow_frac_el3', value: (v: number): string => `${Math.round(v * 100)}%`, unit: 'of the ground in shadow at a 3° sun, averaged over all sun directions' },
  rim: { key: 'jump1km_p95_m', value: (v: number): string => `${Math.round(v)} m`, unit: 'height jump over 1 km (95th percentile)' },
  texture: {
    key: 'empty_cell_frac_el3',
    value: (v: number): string => `${Math.round(v * 100)}%`,
    unit: 'of 1 km cells with no camera feature',
  },
  slope: { key: 'slope_p90_deg', value: (v: number): string => `${v.toFixed(0)}°`, unit: 'slope at the 90th percentile' },
};

export const ROW_NAME: Record<ProfileRowId, string> = {
  shadow: 'Shadow',
  rim: 'Rim jump',
  texture: 'Texture',
  slope: 'Slope',
};

export const ROW_SUB: Record<ProfileRowId, string> = {
  shadow: 'IM-2',
  rim: 'Hakuto-R',
  texture: 'Ingenuity · IM-2',
  slope: 'Walking and touchdown',
};

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** Joins words as "a", "a and b", "a, b and c". */
export function listWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

export interface ValidationTarget {
  /** Pass when value >= min (or <= max). */
  min?: number;
  max?: number;
  text: string;
}

// Team-set targets for the validation panel. Shown on screen next to each figure so judges can see
// the bar we set ourselves; change them here (one place) if the team agrees different ones.
export const VALIDATION_TARGETS: Record<'shadow_r' | 'decoy_auc' | 'jaccard', ValidationTarget> = {
  shadow_r: { min: 0.7, text: 'target ≥ 0.70' },
  decoy_auc: { min: 0.7, text: 'target ≥ 0.70 (0.50 = chance)' },
  jaccard: { min: 0.6, text: 'target ≥ 0.60' },
};

export function meetsTarget(v: number | undefined, t: ValidationTarget): boolean | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (typeof t.min === 'number' && v < t.min) return false;
  if (typeof t.max === 'number' && v > t.max) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Story hero: the problem first (owner-approved wording; facts from docs/problem-facts.md)
// ---------------------------------------------------------------------------------------------

export const HERO = {
  headline: 'Since 2019, 12 robot landers tried to land on the Moon. Only 5 stayed upright.',
  body: 'In four of the failures, the lander misjudged or couldn’t measure its height, and twice the Moon itself fooled it: a crater rim and long low-sun shadows. Even Apollo astronauts struggled to judge distance and slope in lunar light.',
  problem:
    'The problem: landers keep failing when terrain and low sunlight fool their navigation, and there is no systematic way to find places on Earth that reproduce a specific south-pole site’s dangers, at the right sun angle, to rehearse first.',
  kicker:
    'NASA’s next crews land at the south pole, where the Sun hovers just above the horizon and shadows stretch for miles. We find the places on Earth to rehearse it first.',
} as const;

export type LandingOutcome = 'upright' | 'crashed' | 'not_upright';

export interface LandingAttempt {
  mission: string;
  /** ISO date of the landing attempt. */
  date: string;
  outcome: LandingOutcome;
  /** Outcome in the source's own terms, shown on hover or focus. */
  detail: string;
  /** Height or range measurement was involved in the failure (docs/problem-facts.md). */
  heightProblem: boolean;
  sourceLabel: string;
  sourceUrl: string;
}

export const LANDING_OUTCOME_LABEL: Record<LandingOutcome, string> = {
  upright: 'Upright',
  crashed: 'Crashed',
  not_upright: 'Landed, not upright',
};

// Do not claim: SLIM "upside-down" (JAXA: wrong attitude), IM-2 failed from lighting alone, Peregrine or Luna 25 attempted a landing.
export const LANDING_ATTEMPTS: LandingAttempt[] = [
  { mission: 'Chang’e 4', date: '2019-01-03', outcome: 'upright', detail: 'Upright', heightProblem: false, sourceLabel: 'Spaceflight Now', sourceUrl: 'https://spaceflightnow.com/2019/01/05/chinese-rover-begins-exploring-far-side-of-the-moon/' },
  { mission: 'Beresheet', date: '2019-04-11', outcome: 'crashed', detail: 'Crashed', heightProblem: false, sourceLabel: 'Spaceflight Now', sourceUrl: 'https://spaceflightnow.com/2019/04/18/errant-command-doomed-israeli-moon-lander-officials-vow-to-try-again/' },
  { mission: 'Chandrayaan-2 Vikram', date: '2019-09-06', outcome: 'crashed', detail: 'Crashed', heightProblem: false, sourceLabel: 'Scroll.in', sourceUrl: 'https://scroll.in/latest/944389/scroll_in' },
  { mission: 'Chang’e 5', date: '2020-12-01', outcome: 'upright', detail: 'Upright', heightProblem: false, sourceLabel: 'SpaceNews', sourceUrl: 'https://spacenews.com/change-5-successfully-lands-on-moon-collect-youngest-lunar-samples/' },
  { mission: 'Hakuto-R Mission 1', date: '2023-04-26', outcome: 'crashed', detail: 'Crashed', heightProblem: true, sourceLabel: 'ispace', sourceUrl: 'https://www.ispace-inc.com/2023/05/26/ispace-announces-results-of-the-hakuto-r-mission-1-lunar-landing/' },
  { mission: 'Chandrayaan-3', date: '2023-08-23', outcome: 'upright', detail: 'Upright', heightProblem: false, sourceLabel: 'ISRO', sourceUrl: 'https://www.isro.gov.in/media_isro/pdf/Monthly_summary/MonthlySummary_August2023Eng.pdf' },
  { mission: 'SLIM', date: '2024-01-20', outcome: 'not_upright', detail: 'Landed in the wrong attitude', heightProblem: false, sourceLabel: 'JAXA', sourceUrl: 'https://global.jaxa.jp/press/2024/01/20240125-1_e.html' },
  { mission: 'IM-1 Odysseus', date: '2024-02-22', outcome: 'not_upright', detail: 'Landed on its side', heightProblem: true, sourceLabel: 'SpacePolicyOnline', sourceUrl: 'https://spacepolicyonline.com/news/ims-odysseus-lunar-lander-not-upright-after-all/' },
  { mission: 'Chang’e 6', date: '2024-06-02', outcome: 'upright', detail: 'Upright', heightProblem: false, sourceLabel: 'Space.com', sourceUrl: 'https://www.space.com/china-change-6-lands-on-moon-far-side-sample-return-mission' },
  { mission: 'Blue Ghost Mission 1', date: '2025-03-02', outcome: 'upright', detail: 'Upright', heightProblem: false, sourceLabel: 'NASA', sourceUrl: 'https://www.nasa.gov/news-release/touchdown-carrying-nasa-science-fireflys-blue-ghost-lands-on-moon/' },
  { mission: 'IM-2 Athena', date: '2025-03-06', outcome: 'not_upright', detail: 'Landed on its side', heightProblem: true, sourceLabel: 'SpacePolicyOnline', sourceUrl: 'https://spacepolicyonline.com/news/im-2s-imperfect-landing-due-to-altimeter-interference-south-pole-lighting-conditions/' },
  { mission: 'Hakuto-R Mission 2', date: '2025-06-06', outcome: 'crashed', detail: 'Crashed', heightProblem: true, sourceLabel: 'ispace', sourceUrl: 'https://www.ispace-inc.com/2025/06/24/ispace-releases-technical-cause-analysis-for-hakuto-r-mission-2/' },
];

export const LANDING_COUNT_RULE =
  'Counts missions that began powered descent; Peregrine and Luna 25 never began a landing and are excluded.';
export const LANDING_HEIGHT_LABEL = 'Height misjudged or not measured';

export interface ApolloQuote {
  mission: string;
  setup: string;
  quote: string;
  sourceLabel: string;
  sourceUrl: string;
}

export const APOLLO_HEADING = 'Apollo crews saw it too';
export const APOLLO_QUOTES: ApolloQuote[] = [
  {
    mission: 'Apollo 14',
    setup: 'Walking to Cone Crater, the crew',
    quote: 'got within about 30 meters of the rim, without ever recognizing it',
    sourceLabel: 'Apollo Lunar Surface Journal (NASA)',
    sourceUrl: 'https://www.nasa.gov/history/alsj/',
  },
  {
    mission: 'Apollo 12',
    setup: 'With the Sun 7.7° up, looking away from it, it was',
    quote: 'all but impossible to see detail',
    sourceLabel: 'Apollo Lunar Surface Journal (NASA)',
    sourceUrl: 'https://www.nasa.gov/history/alsj/',
  },
];

// ---------------------------------------------------------------------------------------------
// "How we find Earth analogs": fixed rules (numbers that are data come from method.json)
// ---------------------------------------------------------------------------------------------

/** Results are kept at least this far from any known analog, so they are new places. */
export const NEW_PLACE_MIN_KM = 50;
