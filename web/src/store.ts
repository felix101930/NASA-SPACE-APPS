import { create } from 'zustand';
import type {
  EarthSite,
  EarthSitesFile,
  HazardId,
  Match,
  MatchesFile,
  Meta,
  MethodFile,
  OverviewFile,
  Region,
  RegionsFile,
  SummaryFile,
  TransectItem,
} from './types/contract';
import type { Origin } from './data/loader';

export type ScreenId = 'story' | 'moon' | 'region' | 'terrain' | 'walk' | 'summary' | 'alberta';

export const SCREENS: { id: ScreenId; label: string; short: string }[] = [
  { id: 'story', label: 'Why it matters', short: 'Failures' },
  { id: 'moon', label: 'Moon danger profiles', short: 'Moon' },
  { id: 'region', label: 'Earth matches', short: 'Earth' },
  { id: 'terrain', label: '3D side by side', short: '3D' },
  { id: 'walk', label: 'Astronaut walk', short: 'Walk' },
  { id: 'summary', label: 'Summary & validation', short: 'Summary' },
  { id: 'alberta', label: 'Alberta & Calgary', short: 'Alberta' },
];

export interface CoreData {
  regions: Region[];
  regionsOrigin: Origin;
  sites: EarthSite[];
  sitesOrigin: Origin;
  siteById: Map<string, EarthSite>;
  matches: Match[];
  matchesOrigin: Origin;
  summary: SummaryFile | null;
  summaryOrigin: Origin | null;
  method: { file: MethodFile; origin: Origin } | null;
  /**
   * Origin shared by the dependent set {earth_sites, matches, summary, method}. A real file is never joined
   * with a sample one: the set is 'data' only when every member exists in data/, otherwise all come from mock/.
   */
  setOrigin: Origin;
  overview: { file: OverviewFile; origin: Origin } | null;
  metas: { file: string; meta: Meta }[];
}

export function buildCore(
  regions: { value: RegionsFile; origin: Origin },
  sites: { value: EarthSitesFile; origin: Origin },
  matches: { value: MatchesFile; origin: Origin },
  summary: { value: SummaryFile; origin: Origin } | null,
  overview: { value: OverviewFile; origin: Origin } | null,
  method: { value: MethodFile; origin: Origin } | null,
  setOrigin: Origin,
): CoreData {
  const metas: { file: string; meta: Meta }[] = [
    { file: 'regions.json', meta: regions.value.meta },
    { file: 'earth_sites.json', meta: sites.value.meta },
    { file: 'matches.json', meta: matches.value.meta },
  ];
  if (summary) metas.push({ file: 'summary.json', meta: summary.value.meta });
  return {
    regions: regions.value.regions,
    regionsOrigin: regions.origin,
    sites: sites.value.sites,
    sitesOrigin: sites.origin,
    siteById: new Map(sites.value.sites.map((s: EarthSite): [string, EarthSite] => [s.id, s])),
    matches: matches.value.matches,
    matchesOrigin: matches.origin,
    summary: summary?.value ?? null,
    summaryOrigin: summary?.origin ?? null,
    method: method ? { file: method.value, origin: method.origin } : null,
    setOrigin,
    overview: overview ? { file: overview.value, origin: overview.origin } : null,
    metas,
  };
}

export type ShadowMode = 'realtime' | 'precomputed';

export interface WalkResultRow {
  i: number;
  dtw: number;
}

export interface WalkState {
  regionId: string;
  /** Route vertices in the region's map coordinates (south-polar stereographic metres). */
  route: [number, number][];
  moonSlopes: number[];
  results: WalkResultRow[];
  bestSlopes: number[] | null;
  bestItem: TransectItem | null;
}

interface AppState {
  screen: ScreenId;
  core: CoreData | null;
  loadError: string | null;
  mockFiles: string[];
  regionId: string;
  hazard: HazardId;
  siteId: string | null;
  exaggeration: number;
  sunEl: number;
  sunAz: number;
  shadowMode: ShadowMode;
  walk: WalkState | null;
  setScreen: (s: ScreenId) => void;
  setCore: (c: CoreData) => void;
  setLoadError: (e: string) => void;
  addMockFile: (p: string) => void;
  setRegion: (id: string) => void;
  setHazard: (h: HazardId) => void;
  setSite: (id: string | null) => void;
  setExaggeration: (v: number) => void;
  setSun: (el: number, az: number) => void;
  setShadowMode: (m: ShadowMode) => void;
  setWalk: (w: WalkState | null) => void;
}

function initialScreen(): ScreenId {
  const h = window.location.hash.replace('#/', '');
  return SCREENS.some((s: { id: ScreenId }): boolean => s.id === h) ? (h as ScreenId) : 'story';
}

export const useApp = create<AppState>()((set) => ({
  screen: initialScreen(),
  core: null,
  loadError: null,
  mockFiles: [],
  regionId: 'malapert_massif',
  hazard: 'shadow',
  siteId: null,
  exaggeration: 2,
  sunEl: 3,
  sunAz: 90,
  shadowMode: 'realtime',
  walk: null,
  setScreen: (screen: ScreenId): void => {
    if (window.location.hash !== `#/${screen}`) window.history.replaceState(null, '', `#/${screen}`);
    set({ screen });
  },
  setCore: (core: CoreData): void => {
    set((s: AppState) => ({
      core,
      regionId: core.regions.some((r: Region): boolean => r.id === s.regionId) ? s.regionId : (core.regions[0]?.id ?? s.regionId),
    }));
  },
  setLoadError: (loadError: string): void => set({ loadError }),
  addMockFile: (p: string): void => set((s: AppState) => (s.mockFiles.includes(p) ? s : { mockFiles: [...s.mockFiles, p] })),
  setRegion: (regionId: string): void => set({ regionId, siteId: null }),
  setHazard: (hazard: HazardId): void => set({ hazard, siteId: null }),
  setSite: (siteId: string | null): void => set({ siteId }),
  setExaggeration: (exaggeration: number): void => set({ exaggeration }),
  setSun: (sunEl: number, sunAz: number): void => set({ sunEl, sunAz }),
  setShadowMode: (shadowMode: ShadowMode): void => set({ shadowMode }),
  setWalk: (walk: WalkState | null): void => set({ walk }),
}));

export function useRegion(): Region | null {
  const core = useApp((s: AppState) => s.core);
  const id = useApp((s: AppState) => s.regionId);
  return core?.regions.find((r: Region): boolean => r.id === id) ?? null;
}

export function matchesFor(core: CoreData, regionId: string, hazard: HazardId): Match[] {
  return core.matches
    .filter((m: Match): boolean => m.region_id === regionId && m.hazard === hazard)
    .sort((a: Match, b: Match): number => a.rank - b.rank);
}
