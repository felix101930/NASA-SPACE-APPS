// Optional blocks of method.json written by the final Earth run (documented sites, NASADEM cross-check,
// independent hold-out AUC, feature-selection note, zoom-in counts). Each one is read defensively: older
// or sample files simply lack them, and the explainer then leaves that line out.
import { isObj, type MethodFile } from '../types/contract';

export interface DocumentedSite {
  name: string;
  /** Rank this documented site would take among the screened candidates in its best search (1 = first). */
  rank: number;
}

export interface MethodExtras {
  coveragePctBare: number | null;
  /** Known-vs-decoy AUC with the original known analogs (the set used to choose features). */
  aucOriginal: number | null;
  /** AUC on documented agency sites never used for any choice, and how many there are. */
  aucIndependent: number | null;
  nIndependent: number | null;
  /** The crater-bowl (shape) term: AUC with and without it, parsed from feature_selection_note. */
  shapeAucWith: number | null;
  shapeAucWithout: number | null;
  documented: { nSites: number; nTop3: number | null; sites: DocumentedSite[] } | null;
  nasadem: { shadowR: number | null; jumpR: number | null; slopeR: number | null; top3Unchanged: number | null; top3Overlap: number | null; nSites: number | null } | null;
  /** Zoom-in: how many top squares moved to a better position (only if method.json carries it). */
  refine: { nMoved: number; nOriginals: number | null } | null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** "Mount Etna (ROBEX 2017 / ARCHES 2022)" -> "Mount Etna". */
export function shortSiteName(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/, '').trim() || name;
}

export function parseMethodExtras(m: MethodFile): MethodExtras {
  const raw: unknown = m;
  const root = isObj(raw) ? raw : {};
  const screen = isObj(root.screen) ? root.screen : {};
  const val = isObj(root.validation) ? root.validation : {};
  const indep = isObj(val.independent) ? val.independent : {};

  let shapeAucWith: number | null = null;
  let shapeAucWithout: number | null = null;
  if (typeof val.feature_selection_note === 'string') {
    const hit = /(\d\.\d+)\s*->\s*(\d\.\d+)/.exec(val.feature_selection_note);
    if (hit) {
      shapeAucWithout = Number(hit[1]);
      shapeAucWith = Number(hit[2]);
    }
  }

  let documented: MethodExtras['documented'] = null;
  if (isObj(root.documented) && isObj(root.documented.sites)) {
    const sites: DocumentedSite[] = [];
    for (const s of Object.values(root.documented.sites)) {
      if (!isObj(s) || typeof s.name !== 'string') continue;
      const rank = num(s.best_rank_vs_screen);
      if (rank !== null) sites.push({ name: shortSiteName(s.name), rank });
    }
    sites.sort((a: DocumentedSite, b: DocumentedSite): number => a.rank - b.rank || a.name.localeCompare(b.name));
    documented = { nSites: num(root.documented.n_sites) ?? sites.length, nTop3: num(root.documented.n_in_top3_any_search), sites };
  }

  let nasadem: MethodExtras['nasadem'] = null;
  if (isObj(root.nasadem_check) && isObj(root.nasadem_check.per_metric_r)) {
    const r = root.nasadem_check.per_metric_r;
    nasadem = {
      shadowR: num(r.shadow_frac_el3),
      jumpR: num(r.jump1km_p95_m),
      slopeR: num(r.slope_p90_deg),
      top3Unchanged: num(root.nasadem_check.top3_unchanged_frac),
      top3Overlap: num(root.nasadem_check.top3_overlap_mean),
      nSites: num(root.nasadem_check.n_sites),
    };
  }

  let refine: MethodExtras['refine'] = null;
  if (isObj(root.refine)) {
    const nMoved = num(root.refine.n_moved);
    if (nMoved !== null) refine = { nMoved, nOriginals: num(root.refine.n_originals) };
  }

  return {
    coveragePctBare: num(screen.coverage_pct_bare),
    aucOriginal: num(val.auc),
    aucIndependent: num(indep.auc),
    nIndependent: num(indep.n_positive),
    shapeAucWith,
    shapeAucWithout,
    documented,
    nasadem,
    refine,
  };
}
