// Method choices for the ⓘ boxes: the question a judge would ask, why the choice fits the problem, and how
// accurate it is. Source of truth: docs/method-decisions.md (every number comes from our own runs).
// Keep each line short: two lines of popover, not a paragraph.

export type MethodNoteId =
  | 'distribution'
  | 'rimP95'
  | 'drop1km'
  | 'shadowFar'
  | 'sunAngles'
  | 'grid30'
  | 'texture'
  | 'dsmFilter'
  | 'iqr'
  | 'noBowls'
  | 'sample'
  | 'nasadem'
  | 'analogs'
  | 'walkMatcher'
  | 'regions'
  | 'moonDem'
  | 'refraction'
  | 'bootstrap'
  | 'stability'
  | 'synthetic';

export interface MethodNote {
  /** The question the box answers, e.g. "Why the 95th percentile, not the maximum?" */
  q: string;
  /** Why it fits the problem (problem terms). */
  why: string;
  /** How accurate it is (our evidence). */
  accuracy: string;
}

export const METHOD_NOTES: Record<MethodNoteId, MethodNote> = {
  distribution: {
    q: 'Why compare the whole spread, not the average?',
    why: 'A lander is lost on the one steep patch, not the average slope.',
    accuracy: 'Every measure is compared as a full distribution (101 quantiles), so the extremes count.',
  },
  rimP95: {
    q: 'Why the 95th percentile, not the maximum?',
    why: 'Hakuto-R was fooled by a big real drop, so near-worst cases matter; the single maximum is often one bad pixel.',
    accuracy: 'Height error ±0.3–0.5 m against drops of 300–570 m; a synthetic step test recovers the exact height.',
  },
  drop1km: {
    q: 'Why measure drops over 1 km?',
    why: 'That is the scale at which a descending lander’s altitude reading jumps.',
    accuracy: '1 km spans 50 pixels on the Moon and 33 on Earth, so the result barely depends on resolution.',
  },
  shadowFar: {
    q: 'Why include terrain up to 150 km away?',
    why: 'With the sun 1–3° up, distant peaks shadow the site (IM-2’s situation); 15 km makes sites 5–7 points too bright.',
    accuracy: 'Matches NASA’s independent sunlight map with r = 0.98 over 375,000 pixels.',
  },
  sunAngles: {
    q: 'Why a sun at 1°, 3° and 5°?',
    why: 'At the south pole the sun never climbs higher; a normal sun angle would not reproduce the hazard.',
    accuracy: 'Computed per region from latitude. On Earth, refraction (~0.3–0.6°) is applied; windows below 1° are flagged.',
  },
  grid30: {
    q: 'Why put both worlds on a 30 m grid?',
    why: 'A fair comparison needs equal detail; the Moon’s 20 m data would look 2× more trackable (36 vs 19 points/km²).',
    accuracy: 'Same code and same resolution on both worlds.',
  },
  texture: {
    q: 'Why count camera points on shaded ground with real shadows?',
    why: 'Low sun hides features; ignoring shadows overcounts trackable points about 4× (159 → 36 /km²).',
    accuracy: 'Our least certain measure: two elevation datasets agree only r = 0.62 on it.',
  },
  dsmFilter: {
    q: 'Why filter out trees, buildings, farmland and water?',
    why: 'Earth elevation data includes treetops and roofs, which fake the terrain; “bare ground only” removed 9 of 13 known analogs.',
    accuracy: '8 of 13 known analogs pass the filter; all 9 decoys still fail.',
  },
  iqr: {
    q: 'Why count differences in the Moon region’s typical spread?',
    why: 'It puts metres, degrees and percentages on one scale, so no unit dominates.',
    accuracy: 'The spread (IQR) uses the middle 50% of values, so outlier pixels don’t skew it. Under 0.5× = close, 0.5–1.5× = partial.',
  },
  noBowls: {
    q: 'Why no crater-bowl count?',
    why: 'Forest canopy and farmland mimic bowl shapes in elevation data. Tested, not assumed.',
    accuracy: 'Including it lowered known-vs-decoy separation from 0.80 to 0.70.',
  },
  sample: {
    q: 'Why a sample of Earth, not all of it?',
    why: 'Fingerprinting every square on Earth isn’t feasible; we screened ~12,000 bare-land squares (~15% of bare land).',
    accuracy: 'The final top-3 sites reappear in 81% of reruns on a fresh sample (3 reruns).',
  },
  nasadem: {
    q: 'Why a second elevation dataset?',
    why: 'Results shouldn’t depend on one dataset; NASA NASADEM is an independent cross-check.',
    accuracy: 'Shadow, drop and slope agree r = 0.96–1.00; texture only r = 0.62, so the exact top 3 can shift (overlap 0.51).',
  },
  analogs: {
    q: 'Why test with known analogs and decoys?',
    why: 'A working method should rank Moon-training sites above farmland and forest.',
    accuracy: 'Score 0.80 on the 13 analogs used to tune it; 0.87 on 7 independent sites never used (0.50 = chance).',
  },
  walkMatcher: {
    q: 'Why compare height + slope, not time-warping (DTW)?',
    why: 'We hid a distorted copy of each Moon route among 22,000 Earth paths and checked which method finds it.',
    accuracy: 'Height + slope finds the copy first 77% of the time; DTW only 38%.',
  },
  regions: {
    q: 'Are the region locations right?',
    why: 'A shifted region would describe the wrong terrain.',
    accuracy: 'All 9 lie within 0.2 km of the USGS official extents.',
  },
  moonDem: {
    q: 'How exact are the Moon heights?',
    why: 'Every Moon measure comes from NASA LOLA elevation data, which has its own error.',
    accuracy: 'Height ±0.3–0.5 m, slope ±1.5–2.5° (Barker et al. 2021/2023).',
  },
  refraction: {
    q: 'Why flag sun angles under 1°?',
    why: 'Earth’s air bends low sunlight by ~0.3–0.6°, so the real sun can sit higher or lower than computed.',
    accuracy: 'Refraction is applied; windows below 1° are flagged as less certain.',
  },
  bootstrap: {
    q: 'Would a different sample give different sites?',
    why: 'We only screened part of Earth, so we reran the search on fresh random samples.',
    accuracy: 'On average 81% of each top 3 came back (3 reruns on a fresh 80% sample).',
  },
  stability: {
    q: 'Do the results depend on our weights?',
    why: 'The three dangers are combined with weights we chose; small changes shouldn’t reshuffle the answer.',
    accuracy: 'With weights nudged ±20%, the top 3 stay mostly the same (Jaccard overlap, 1 = identical).',
  },
  synthetic: {
    q: 'Does the code measure what it claims?',
    why: 'Made-up terrains with a known answer (a step, a cone, a flat plain) catch measurement bugs.',
    accuracy: 'Each test runs through the same code as the real data.',
  },
};
