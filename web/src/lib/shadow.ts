// Shadow shares come in two kinds, and the app must say which one it shows:
//  - profile/table values (shadow_frac_el1/3/5/7) are AVERAGED over all sun directions;
//  - 3D, Explore and explainer readouts are for ONE sun direction.
// These helpers label a single-direction figure and pair it with the averaged one when it exists.

const DIR_WORDS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

/** Compass word for an azimuth in degrees ("east"). */
export function dirWord(az: number): string {
  return DIR_WORDS[Math.round((((az % 360) + 360) % 360) / 45) % 8];
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function elText(el: number): string {
  return `${Number.isInteger(el) ? el.toFixed(0) : el.toFixed(1)}°`;
}

/**
 * Direction-averaged shadow share at sun elevation `el` from metric records (shadow_frac_el1/3/5/7), checked in
 * order. Null when that elevation isn't stored (e.g. 1.5°): we don't interpolate a figure we never measured.
 */
export function avgShadowAt(el: number, ...records: (Record<string, unknown> | null | undefined)[]): number | null {
  if (Math.abs(el - Math.round(el)) > 0.01) return null;
  const key = `shadow_frac_el${Math.round(el)}`;
  for (const r of records) {
    const v = r?.[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/** "(50% averaged over all sun directions)", or '' when no averaged value exists. */
export function avgNote(avg: number | null): string {
  return avg === null ? '' : `(${pct(avg)} averaged over all sun directions)`;
}

/**
 * "79% dark with the sun from the east at 3° (50% averaged over all sun directions)".
 * `from` is the direction phrase, e.g. "from the east" or "from the right of the tile".
 */
export function singleSunShadow(frac: number, el: number, from: string, avg: number | null): string {
  const note = avgNote(avg);
  return `${pct(frac)} dark with the sun ${from} at ${elText(el)}${note ? ` ${note}` : ''}`;
}
