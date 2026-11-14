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
