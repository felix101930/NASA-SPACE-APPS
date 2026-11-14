// Problem terms used across the screens. Each entry is one plain sentence, shown in an ⓘ box. Surface with <Term id="…"> next to the first use on each screen.
// Method choices (why this way, how accurate) live in lib/methodNotes.ts.

export type GlossaryId =
  | 'dangerProfile'
  | 'rimDrop'
  | 'shadowShare'
  | 'cameraTexture'
  | 'typicalSpread'
  | 'rehearsalWindow'
  | 'noveltyRule'
  | 'dsmSafe'
  | 'knownAnalog'
  | 'decoy';

export interface GlossaryEntry {
  /** Short label as it appears on screen. */
  term: string;
  /** One plain sentence: what it is (shown in the ⓘ box). */
  plain: string;
}

export const GLOSSARY: Record<GlossaryId, GlossaryEntry> = {
  dangerProfile: {
    term: 'Danger profile',
    plain: 'How strongly a Moon region shows the three hazards that fooled recent landers: shadow, rim drops and blank ground.',
  },
  rimDrop: {
    term: 'Rim drop',
    plain: 'The near-worst height change over 1 km (95th percentile), in metres; big drops make the measured altitude jump.',
  },
  shadowShare: {
    term: 'Shadow share',
    plain: 'The percentage of a 15 × 15 km area in cast shadow when the sun sits 1–5° above the horizon.',
  },
  cameraTexture: {
    term: 'Camera texture',
    plain: 'How many trackable corner points a navigation camera finds per km² on shaded ground.',
  },
  typicalSpread: {
    term: 'Typical spread',
    plain: 'The middle half of a Moon region’s own values (its IQR); a gap of 1× is one typical spread, under 0.5× counts as close.',
  },
  rehearsalWindow: {
    term: 'Rehearsal window',
    plain: 'A date and time when the sun at the Earth site sits at the same low angle as at the Moon region.',
  },
  noveltyRule: {
    term: 'Novelty rule',
    plain: 'Each suggested Earth site is at least 50 km from the others and from every analog site already in use.',
  },
  dsmSafe: {
    term: 'DSM-safe ground',
    plain: 'Ground without trees, buildings, farmland, water or ice, so the elevation data shows the real surface.',
  },
  knownAnalog: {
    term: 'Known analog',
    plain: 'A place space agencies already use to train for the Moon, such as Haughton Crater or Mount Etna.',
  },
  decoy: {
    term: 'Decoy',
    plain: 'A place that should not look like the Moon, such as farmland, forest or a dune field.',
  },
};
