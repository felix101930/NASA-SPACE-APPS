// Types mirroring docs/data-contract.md, plus runtime guards used when parsing fetched JSON.
// The guards check the structure the UI depends on; optional/extra fields are tolerated.

export type HazardId = 'shadow' | 'rim' | 'texture';
export const HAZARD_IDS: readonly HazardId[] = ['shadow', 'rim', 'texture'];
export type Level = 'low' | 'med' | 'high';
export type Light = 'green' | 'amber' | 'red';

export interface Source {
  name: string;
  url: string;
  licence: string;
  citation: string;
}

export interface Meta {
  generated_utc: string;
  pipeline_version: string;
  sources: Source[];
}

export interface TileRef {
  path: string;
  size: number;
  res_m: number;
  crs: string;
  origin_x: number;
  origin_y: number;
}

export interface ShadowMask {
  el: number;
  az: number;
  path: string;
}

export interface HazardEntry {
  score: number;
  level: Level;
  metrics: Record<string, number>;
}

export interface SlopeEntry {
  metrics: {
    slope_p50_deg: number;
    slope_p90_deg: number;
    rms_dev_m: Record<string, number>;
  };
}

export interface Region {
  id: string;
  name: string;
  lat: number;
  lon: number;
  x_m: number;
  y_m: number;
  /** 'pgda_site_tile' | 'traced_approx' (older files used 'pgda_roi'). */
  coord_quality: 'pgda_site_tile' | 'traced_approx' | 'pgda_roi' | string;
  coord_source: string;
  coord_method?: string;
  sun: { el_min: number; el_max: number; note: string };
  tile: TileRef;
  hillshade: string;
  shadow_masks: ShadowMask[];
  /** e.g. "PNG 255 = cast shadow, 0 = lit, 128 = no data; az clockwise from grid +y". */
  shadow_mask_note?: string;
  /** Extra pipeline metrics not in the core contract. */
  extras?: Record<string, number>;
  hazards: {
    shadow: HazardEntry;
    rim: HazardEntry;
    texture: HazardEntry;
    slope: SlopeEntry;
  };
  uncertainty: { dem_err_p50_m: number; notes: string };
  /** Optional extra from the pipeline: PGDA long-term illumination for context. */
  illumination?: { pgda_avg_visibility?: number; ours_avg_visibility?: number; note?: string; pgda_url?: string };
}

export interface RegionsFile {
  meta: Meta;
  regions: Region[];
}

export interface Citation {
  claim: string;
  url: string;
}

export interface EarthSite {
  id: string;
  name: string;
  country: string;
  lat: number;
  lon: number;
  category: string;
  known_analog: boolean;
  role: 'candidate' | 'heldout_positive' | 'decoy' | string;
  bare_frac: number;
  worldcover_note: string;
  rock: { lith: string; anorthosite: boolean; source: string };
  tile: TileRef;
  hillshade: string;
  metrics: Record<string, number | Record<string, number>>;
  image_tile_url: string | null;
  citations: Citation[];
}

export interface EarthSitesFile {
  meta: Meta;
  sites: EarthSite[];
}

export interface LightRow {
  metric: string;
  moon: number;
  moon_iqr: [number, number];
  earth: number;
  gap_text: string;
  light: Light;
}

export interface RehearsalWindow {
  start_utc: string;
  end_utc: string;
  sun_el: number;
  sun_az: number;
  el_kind: string;
}

export interface Match {
  region_id: string;
  hazard: HazardId;
  rank: number;
  site_id: string;
  distance: number;
  lights: LightRow[];
  matches_text: string[];
  mismatches_text: string[];
  cannot_test: string[];
  windows: RehearsalWindow[];
}

export interface MatchesFile {
  meta: Meta;
  matches: Match[];
}

export interface RankingRow {
  region_id: string;
  rank: number;
  rehearsability: number;
  per_hazard_best_distance: Record<HazardId, number>;
  reason: string;
}

export interface Validation {
  shadow_vs_pgda: { pearson_r: number; mae: number; bias: number; n_px: number; note: string };
  known_vs_decoy_auc: number;
  weight_stability_jaccard: number;
  classifier_two_sample: { per_region_auc: Record<string, number>; top_features: string[] };
  synthetic_tests: { name: string; passed: boolean }[];
  where_it_fails: string[];
}

export interface SummaryFile {
  meta: Meta;
  ranking: RankingRow[];
  validation: Validation;
}

export interface TransectItem {
  i: number;
  site_id: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  lat0: number;
  lon0: number;
  lat1: number;
  lon1: number;
  length_m: number;
  climb_m: number;
  max_slope_deg: number;
}

export interface TransectsFile {
  meta: Meta;
  n: number;
  points: number;
  items: TransectItem[];
}

export interface PresetBest {
  i: number;
  dtw: number;
}

export interface PresetRoute {
  region_id: string;
  name: string;
  moon_xy: [number, number][];
  best: PresetBest[];
}

/** Optional (not in the contract yet): a wide hillshade of the south pole for the overview screen. */
export interface OverviewFile {
  hillshade: string;
  /** [xmin, xmax, ymin, ymax] in south-polar stereographic metres. */
  extent_m: [number, number, number, number];
  note?: string;
}

// ---------------------------------------------------------------------------------------------
// Runtime guards
// ---------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isNum(v: unknown): v is number {
  return typeof v === 'number';
}
function isStr(v: unknown): v is string {
  return typeof v === 'string';
}
function isArr(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

function isSource(v: unknown): v is Source {
  return isObj(v) && isStr(v.name);
}

export function isMeta(v: unknown): v is Meta {
  return isObj(v) && isArr(v.sources) && v.sources.every(isSource);
}

function isTileRef(v: unknown): v is TileRef {
  return isObj(v) && isStr(v.path) && isNum(v.size) && isNum(v.res_m) && isNum(v.origin_x) && isNum(v.origin_y);
}

function isHazardEntry(v: unknown): v is HazardEntry {
  return isObj(v) && isNum(v.score) && isStr(v.level) && isObj(v.metrics);
}

function isRegion(v: unknown): v is Region {
  if (!isObj(v)) return false;
  const h = v.hazards;
  return (
    isStr(v.id) &&
    isStr(v.name) &&
    isNum(v.x_m) &&
    isNum(v.y_m) &&
    isStr(v.coord_quality) &&
    isObj(v.sun) &&
    isTileRef(v.tile) &&
    isStr(v.hillshade) &&
    isArr(v.shadow_masks) &&
    isObj(h) &&
    isHazardEntry(h.shadow) &&
    isHazardEntry(h.rim) &&
    isHazardEntry(h.texture) &&
    isObj(h.slope) &&
    isObj((h.slope as Obj).metrics)
  );
}

export function isRegionsFile(v: unknown): v is RegionsFile {
  return isObj(v) && isMeta(v.meta) && isArr(v.regions) && v.regions.every(isRegion);
}

function isEarthSite(v: unknown): v is EarthSite {
  return (
    isObj(v) &&
    isStr(v.id) &&
    isStr(v.name) &&
    isNum(v.lat) &&
    isNum(v.lon) &&
    isTileRef(v.tile) &&
    isObj(v.metrics) &&
    isObj(v.rock)
  );
}

export function isEarthSitesFile(v: unknown): v is EarthSitesFile {
  return isObj(v) && isMeta(v.meta) && isArr(v.sites) && v.sites.every(isEarthSite);
}

function isLightRow(v: unknown): v is LightRow {
  return isObj(v) && isStr(v.metric) && isNum(v.moon) && isNum(v.earth) && isStr(v.light);
}

function isWindow(v: unknown): v is RehearsalWindow {
  return isObj(v) && isStr(v.start_utc) && isStr(v.end_utc) && isNum(v.sun_el) && isNum(v.sun_az);
}

function isMatch(v: unknown): v is Match {
  return (
    isObj(v) &&
    isStr(v.region_id) &&
    isStr(v.hazard) &&
    isNum(v.rank) &&
    isStr(v.site_id) &&
    isArr(v.lights) &&
    v.lights.every(isLightRow) &&
    isArr(v.cannot_test) &&
    isArr(v.windows) &&
    v.windows.every(isWindow)
  );
}

export function isMatchesFile(v: unknown): v is MatchesFile {
  return isObj(v) && isMeta(v.meta) && isArr(v.matches) && v.matches.every(isMatch);
}

export function isSummaryFile(v: unknown): v is SummaryFile {
  if (!isObj(v) || !isMeta(v.meta) || !isArr(v.ranking) || !isObj(v.validation)) return false;
  const okRows = v.ranking.every((r: unknown) => isObj(r) && isStr(r.region_id) && isNum(r.rank));
  return okRows;
}

export function isTransectsFile(v: unknown): v is TransectsFile {
  return (
    isObj(v) &&
    isNum(v.n) &&
    isNum(v.points) &&
    isArr(v.items) &&
    v.items.every((t: unknown) => isObj(t) && isNum(t.i) && isStr(t.site_id) && isNum(t.length_m))
  );
}

export function isPresetsFile(v: unknown): v is PresetRoute[] {
  return (
    isArr(v) &&
    v.every((p: unknown) => isObj(p) && isStr(p.region_id) && isStr(p.name) && isArr(p.moon_xy) && isArr(p.best))
  );
}

export function isOverviewFile(v: unknown): v is OverviewFile {
  return isObj(v) && isStr(v.hillshade) && isArr(v.extent_m) && v.extent_m.length === 4 && v.extent_m.every(isNum);
}
