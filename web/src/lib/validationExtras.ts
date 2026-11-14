// Optional validation fields written by newer pipeline runs (PGDA RMSE / R² / offset-removed MAE, bootstrap
// reappearance). Read defensively: older or sample summary files simply lack them.
import { isObj } from '../types/contract';

export interface PgdaExtras {
  rmse: number | null;
  r2: number | null;
  maeOffsetRemoved: number | null;
  nRegions: number | null;
}

export interface BootstrapExtras {
  reappearance: number;
  nBoot: number | null;
  sampleFrac: number | null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function parsePgdaExtras(validation: unknown): PgdaExtras {
  const v = isObj(validation) && isObj(validation.shadow_vs_pgda) ? validation.shadow_vs_pgda : {};
  return { rmse: num(v.rmse), r2: num(v.r2), maeOffsetRemoved: num(v.mae_offset_removed), nRegions: num(v.n_regions) };
}

export function parseBootstrap(validation: unknown): BootstrapExtras | null {
  const b = isObj(validation) && isObj(validation.bootstrap) ? validation.bootstrap : null;
  if (!b) return null;
  const r = num(b.final_top3_mean_reappearance_frac);
  if (r === null) return null;
  return { reappearance: r, nBoot: num(b.n_boot), sampleFrac: num(b.sample_frac) };
}

/** Walk hidden-copy test: share of routes where the matcher finds the hidden copy first (and DTW, for contrast). */
export function parseWalkTest(validation: unknown): { top1: number; dtwTop1: number | null } | null {
  const w = isObj(validation) && isObj(validation.walk_findback) ? validation.walk_findback : null;
  const top1 = w ? num(w.top1) : null;
  return w && top1 !== null ? { top1, dtwTop1: num(w.dtw_top1) } : null;
}
