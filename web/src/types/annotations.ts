// Types for web/public/data/moon/<region_id>_annotations.json (schema "annotations/1").
// Only the parts the Explore-in-3D view uses are typed; extra fields are tolerated.
import { isObj } from './contract';

/** [col, row] continuous pixel coords, origin = top-left corner of pixel (0,0). */
export type Px = [number, number];

export interface PxPoint {
  px: Px;
}

export interface RimDrop {
  rank: number;
  start: PxPoint;
  end: PxPoint;
  mid: PxPoint;
  abs_dh_m: number;
  label: string;
}

export interface TextureCell {
  i: number;
  j: number;
  /** [col0, row0, col1, row1] */
  bbox: { px: [number, number, number, number] };
  empty_az_frac?: number;
}

export interface ShadowMaskNote {
  el: number;
  az: number;
  path: string;
  frac: number;
  sun_from?: string;
  largest_blob?: { area_km2: number; anchor: PxPoint };
  label?: string;
}

export interface AnnotationLabel {
  hazard: 'shadow' | 'rim' | 'texture' | 'slope' | 'safe' | string;
  anchor: PxPoint;
  title: string;
  text: string;
}

export interface Annotations {
  region_id: string;
  schema: string;
  tile: { size: number; res_m: number };
  rim_drops?: { drops: RimDrop[]; p95_m?: number };
  texture?: { empty_frac: number; cell_m: number; texture_empty_cells: TextureCell[] };
  steep_mask_summary?: {
    class_edges_deg: number[];
    class_names: string[];
    class_fracs: number[];
    thresholds_note?: string;
    class_png?: { path: string; size: number; block_px: number };
  };
  shadow?: { masks: ShadowMaskNote[] };
  safest_patch?: { area_km2: number; bbox: { px: [number, number, number, number] }; anchor: PxPoint; label: string };
  labels?: AnnotationLabel[];
}

export function isAnnotations(v: unknown): v is Annotations {
  return (
    isObj(v) && typeof v.region_id === 'string' && typeof v.schema === 'string' && v.schema.startsWith('annotations/') && isObj(v.tile)
  );
}
