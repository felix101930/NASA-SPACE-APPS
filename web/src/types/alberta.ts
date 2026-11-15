// Types mirroring docs/data-contract-alberta.md, plus runtime guards for the parts the UI depends on.
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { isMeta, isObj, type HazardId, type Light, type Meta, type TileRef } from './contract';

export interface AlbertaLight {
  component: string;
  label: string;
  unit: 'm' | 'frac' | 'deg' | string;
  moon: number | null;
  alberta: number | null;
  scale: number | null;
  scale_source?: string;
  term: number | null;
  light: Light;
  gap: string;
}

export interface AlbertaTopRow {
  rank: number;
  id: string;
  distance: number;
  lights: AlbertaLight[];
  metrics_30m_vs_moon?: Record<string, { moon: number | null; alberta: number | null }> | null;
}

export interface AlbertaSearch {
  region: string;
  region_name: string;
  hazard: HazardId;
  n_eligible: number;
  top: AlbertaTopRow[];
  global_screen?: {
    best_distance: number;
    best_id: string;
    best_lat: number;
    best_lon: number;
    n_eligible: number;
    alberta_best_rank_among_global: number;
    ratio_alberta_to_global: number;
    note?: string;
  };
  terrain_only_best?: {
    id: string;
    distance: number;
    name: string;
    lat: number;
    lon: number;
    dsm_pass: boolean;
    fail: string[];
    park_label: string | null;
    named_parks: string[];
    note?: string;
  };
}

export interface AlbertaBest {
  region: string;
  region_name: string;
  id: string;
  name: string;
  lat: number;
  lon: number;
  distance: number;
  park_label: string | null;
  named_parks: string[];
  global_best_distance: number | null;
}

export interface AlbertaSite {
  id: string;
  name: string;
  lat: number;
  lon: number;
  park?: {
    in_protected_area: boolean;
    named_parks: string[];
    label: string | null;
    areas?: { name: string; type: string; frac: number }[];
  };
  worldcover?: Record<string, number>;
  tile?: (TileRef & { true_north_grid_az_deg?: number }) | null;
  hillshade?: string | null;
  core_relief_m?: number;
}

export interface AlbertaFile {
  meta: Meta;
  coverage: {
    n_windows: number;
    n_pass: number;
    pct_area_pass: number;
    province_km2: number;
    fail_reason_counts: Record<string, number>;
    n_eligible: number;
  };
  best_per_hazard: Partial<Record<HazardId, AlbertaBest>>;
  searches: AlbertaSearch[];
  sites: Record<string, AlbertaSite>;
}

export interface WindowProps {
  id: string;
  name: string;
  lat: number;
  lon: number;
  pass: boolean;
  eligible: boolean;
  fail: string;
  frac_in_ab: number;
  best_distance: number | null;
  best_distance_terrain_only: number | null;
  best_hazard: string | null;
  best_region: string | null;
  in_protected_area: boolean;
  wc_tree: number;
}

export type WindowsGeo = FeatureCollection<Polygon, WindowProps> & { meta?: Meta };

export type NeedCategory = 'Lowest' | 'Low' | 'Moderate' | 'High' | 'Highest';
export const NEED_ORDER: NeedCategory[] = ['Lowest', 'Low', 'Moderate', 'High', 'Highest'];

export interface Tract {
  ctuid: string;
  name: string;
  communities: string;
  access_domain_score: number | null;
  access_category: NeedCategory | string;
  transit_score: number | null;
  walk_score: number | null;
  park_proximity: number | null;
}

export type OverlaysGeo = FeatureCollection<Polygon | MultiPolygon, Tract> & { meta?: Meta };

export interface NearStop {
  name: string;
  stop_id?: string;
  routes: string[];
  dist_m: number;
}

export interface CalgaryWalk {
  id: string;
  row: number;
  /** [lat, lon] pairs, NOT GeoJSON order. */
  coords: [number, number][];
  park: string | null;
  length_m: number;
  climb_m: number;
  descent_m: number;
  max_grade_pct: number;
  mean_abs_slope_deg: number;
  near_stop: NearStop | null;
  tract: Tract | null;
}

export interface WalksFile {
  meta: Meta & { licence_note?: string };
  bin: { path: string; shape: [number, number] };
  stats: {
    n_routes: number;
    median_length_m: number;
    median_mean_abs_slope_deg: number;
    pct_start_within_400m_of_active_stop: number;
    pct_in_park: number;
    pct_in_highest_or_high_need_tract: number;
  };
  notes: string;
  items: CalgaryWalk[];
}

export interface PresetMatchRow {
  id: string;
  row: number;
  dtw_deg: number;
  length_m: number;
  park: string | null;
  mean_abs_slope_deg: number;
  near_stop: NearStop | null;
  access_category: string | null;
  access_domain_score: number | null;
  tract: string | null;
  communities: string | null;
}

export interface CalgaryPreset {
  region: string;
  region_name: string;
  kind: 'gentle' | 'steeper';
  length_m: number;
  mean_abs_slope_deg: number;
  max_slope_deg: number;
  climb_m: number;
  slope_deg: number[];
  slope_gap_deg: number;
  match: {
    recommended: PresetMatchRow | null;
    strict_best: PresetMatchRow | null;
    tie_break_applied: boolean;
    top: PresetMatchRow[];
  };
}

export interface PresetsFile {
  meta: Meta;
  notes: string;
  presets: CalgaryPreset[];
}

export function isAlbertaFile(v: unknown): v is AlbertaFile {
  return isObj(v) && isMeta(v.meta) && isObj(v.coverage) && isObj(v.best_per_hazard) && Array.isArray(v.searches) && isObj(v.sites);
}

function isFC(v: unknown): v is { type: 'FeatureCollection'; features: unknown[] } {
  return isObj(v) && v.type === 'FeatureCollection' && Array.isArray(v.features);
}

export function isWindowsGeo(v: unknown): v is WindowsGeo {
  return (
    isFC(v) &&
    v.features.every(
      (f: unknown) => isObj(f) && isObj(f.properties) && typeof f.properties.id === 'string' && typeof f.properties.pass === 'boolean',
    )
  );
}

export function isOverlaysGeo(v: unknown): v is OverlaysGeo {
  return isFC(v) && v.features.every((f: unknown) => isObj(f) && isObj(f.properties) && typeof f.properties.ctuid === 'string');
}

export function isWalksFile(v: unknown): v is WalksFile {
  return (
    isObj(v) &&
    isObj(v.bin) &&
    Array.isArray(v.bin.shape) &&
    Array.isArray(v.items) &&
    v.items.every((it: unknown) => isObj(it) && typeof it.id === 'string' && typeof it.row === 'number' && Array.isArray(it.coords))
  );
}

export function isPresetsFile(v: unknown): v is PresetsFile {
  return (
    isObj(v) &&
    Array.isArray(v.presets) &&
    v.presets.every((p: unknown) => isObj(p) && typeof p.region === 'string' && Array.isArray(p.slope_deg) && isObj(p.match))
  );
}

// ------------------------------------------------------------------------------------------------
// calgary/equity.json (Calgary Equity Index analysis; docs/data-contract-alberta.md)
// ------------------------------------------------------------------------------------------------

export interface EquityCoverageRow {
  category: NeedCategory;
  n_tracts: number;
  n_with_any_route: number;
  n_covered: number;
  pct_covered: number | null;
  population: number;
  population_covered: number;
  pct_population_covered: number | null;
  n_suitable_routes: number;
}

export interface EquityGapSide {
  categories: NeedCategory[];
  n_tracts: number;
  n_covered: number;
  pct_covered: number;
  population: number;
  population_covered: number;
  pct_population_covered: number | null;
}

export interface EquityEvent {
  rank: number;
  ctuid: string;
  tract: string;
  communities: string;
  place: string;
  park: string | null;
  access_category: NeedCategory;
  access_domain_score: number | null;
  need_percentile: number;
  population: number | null;
  route_id: string;
  length_m: number;
  near_stop: { name: string; dist_m: number; minutes_walk: number; routes: string[]; n_school_routes: number };
  moon_match: { region: string; region_name: string; kind: 'gentle' | 'steeper'; dtw_deg: number };
  factors: { need: number; transit: number; quality: number };
  score: number;
  why: string;
}

export type UncapturedReason = 'no_route' | 'far_from_stop' | 'no_slope_match' | 'other';

export interface UncapturedTract {
  ctuid: string;
  tract: string;
  communities: string;
  population: number | null;
  access_domain_score: number | null;
  n_routes_sampled: number;
  reason: UncapturedReason;
  why: string;
  nearest_suitable: {
    route_id: string;
    place: string;
    ctuid: string | null;
    dist_km: number;
    stop_name: string | null;
    stop_dist_m: number;
  } | null;
}

export interface EquityFile {
  meta: Meta & { method?: Record<string, string>; cei_source?: string; cei_quote?: string };
  headline: string;
  summary: {
    n_tracts: number;
    n_routes: number;
    n_routes_near_stop: number;
    n_routes_moon_match: number;
    n_routes_suitable: number;
    n_tracts_covered: number;
    n_suitable_matching_a_steeper_moon_route: number;
  };
  coverage: EquityCoverageRow[];
  coverage_total_equity: EquityCoverageRow[];
  gap: {
    high_need: EquityGapSide;
    low_need: EquityGapSide;
    gap_pct_points: number;
    direction: 'higher' | 'lower' | 'about the same';
    statement: string;
  };
  top_events: EquityEvent[];
  uncaptured_highest: { n: number; reasons: Record<string, number>; tracts: UncapturedTract[] };
}

function isCoverageRow(v: unknown): v is EquityCoverageRow {
  return isObj(v) && typeof v.category === 'string' && typeof v.n_tracts === 'number' && typeof v.n_covered === 'number';
}

export function isEquityFile(v: unknown): v is EquityFile {
  return (
    isObj(v) &&
    isMeta(v.meta) &&
    typeof v.headline === 'string' &&
    Array.isArray(v.coverage) &&
    v.coverage.every(isCoverageRow) &&
    Array.isArray(v.coverage_total_equity) &&
    v.coverage_total_equity.every(isCoverageRow) &&
    isObj(v.gap) &&
    Array.isArray(v.top_events) &&
    v.top_events.every(
      (e: unknown): boolean => isObj(e) && typeof e.route_id === 'string' && typeof e.rank === 'number' && isObj(e.near_stop),
    ) &&
    isObj(v.uncaptured_highest) &&
    Array.isArray(v.uncaptured_highest.tracts)
  );
}

// ------------------------------------------------------------------ alberta/standing.json (pipeline/match/alberta_standing.py)

/** One Alberta site scored with the final-round (30 m) matcher for one region x danger. */
export interface StandingRow {
  site_id: string;
  region_id: string;
  hazard: HazardId;
  /** Hazard distance in Moon-region IQR units (< 0.5 close, < 1.5 partial). */
  distance: number | null;
  /** 1 + number of sites measured in detail that are strictly closer. */
  rank_measured: number | null;
  n_measured: number;
  /** The same among the sites that won a top-3 slot. */
  rank_picks: number | null;
  n_picks: number;
  /** Distance of the world's #1 match for the same region x danger (matches.json). */
  world_best_distance: number | null;
}

export interface StandingFile {
  meta: Meta;
  n_measured_sites: number;
  n_pick_sites: number;
  rows: StandingRow[];
}

const isNumOrNull = (v: unknown): v is number | null => v === null || typeof v === 'number';

function isStandingRow(v: unknown): v is StandingRow {
  return (
    isObj(v) &&
    typeof v.site_id === 'string' &&
    typeof v.region_id === 'string' &&
    typeof v.hazard === 'string' &&
    isNumOrNull(v.distance) &&
    isNumOrNull(v.rank_measured) &&
    typeof v.n_measured === 'number' &&
    isNumOrNull(v.rank_picks) &&
    typeof v.n_picks === 'number' &&
    isNumOrNull(v.world_best_distance)
  );
}

export function isStandingFile(v: unknown): v is StandingFile {
  return (
    isObj(v) &&
    isMeta(v.meta) &&
    typeof v.n_measured_sites === 'number' &&
    typeof v.n_pick_sites === 'number' &&
    Array.isArray(v.rows) &&
    v.rows.every(isStandingRow)
  );
}
