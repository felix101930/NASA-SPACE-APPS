// Plain-language rewrites for strings that come from the pipeline. The technical original is kept for tooltips.

/**
 * Macrostrat lithology strings to readable text:
 * "Major:: {schist},Minor:: {psammite, pelite}" -> "schist (with minor psammite, pelite)";
 * "major:sandstone, minorclaystone,limestone" -> "sandstone (with minor claystone, limestone)";
 * trailing "; " and catalogue numbers ("lake deposits 38492") are dropped.
 */
export function fmtRock(lith: string | null | undefined): string {
  if (!lith) return '';
  const list = (s: string): string =>
    s
      .split(',')
      .map((x: string): string => x.trim())
      .filter((x: string): boolean => x.length > 0)
      .join(', ');
  let s = lith.trim();
  const braces = /^major::\s*\{([^}]*)\}\s*,?\s*(?:minor::\s*\{([^}]*)\})?$/i.exec(s);
  const plain = /^major:+\s*(.+?)\s*,\s*minor:*\s*(.+)$/i.exec(s);
  if (braces) s = braces[2] ? `${list(braces[1])} (with minor ${list(braces[2])})` : list(braces[1]);
  else if (plain) s = `${list(plain[1])} (with minor ${list(plain[2])})`;
  s = s.replace(/[;,\s]+$/, '').replace(/\s+\d{3,}$/, '');
  return s;
}

interface Rewrite {
  re: RegExp;
  to: string | ((...m: string[]) => string);
}

const REWRITES: readonly Rewrite[] = [
  { re: /Slopes are more one-directional than on the Moon \(aspect anisotropy\)/, to: 'Slopes mostly face one way, more so than on the Moon' },
  { re: /Slopes are less one-directional than on the Moon \(aspect anisotropy\)/, to: 'Slopes face more mixed directions than on the Moon' },
  { re: /\s*\(aspect anisotropy\)/g, to: '' },
  { re: /\s*\(DSM-safe\)/g, to: '' },
  { re: /Rock is (.+?) \(Macrostrat\)/, to: (_m: string, rock: string): string => `Rock is ${fmtRock(rock)} (Macrostrat)` },
];

/** Rewrites jargon in a pipeline note. Returns the plain text and, when it changed, the original for a tooltip. */
export function plainNote(text: string): { text: string; title: string | undefined } {
  let out = text;
  for (const r of REWRITES) {
    out = typeof r.to === 'string' ? out.replace(r.re, r.to) : out.replace(r.re, r.to);
  }
  return { text: out, title: out !== text ? text : undefined };
}

const FEATURE_NAMES: Record<string, string> = {
  curvature_std_per_km: 'how much the curvature varies',
  slope_p90_deg: 'share of steep ground',
  slope_p50_deg: 'typical slope',
  slope_mean_deg: 'average slope',
  roughness_m: 'bumpiness',
  jump1km_p95_m: 'height jumps over 1 km',
  relief_m: 'height range',
  shadow_frac_el3: 'shadow at a 3° sun',
  empty_cell_frac_el3: 'featureless ground',
  fast_per_km2_el3: 'camera landmarks',
  hurst: 'how roughness grows with scale',
  aspect_anisotropy: 'whether slopes mostly face one way',
};

/** Plain-language name for a classifier feature key; unknown keys fall back to their words. */
export function featureName(key: string): string {
  return FEATURE_NAMES[key] ?? key.replace(/_(m|deg|per_km)$/, '').replace(/_/g, ' ');
}
