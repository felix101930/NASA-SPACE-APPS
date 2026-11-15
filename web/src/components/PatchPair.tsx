// Earth matches: the Moon region and the Earth site as 25 patches each, side by side on one colour scale, with
// the Moon's typical range (middle half of its patches) and where the Earth square's whole value falls.
import { useState, type JSX } from 'react';
import { headlineLight } from './PatchFor';
import { PatchGrid, PatchLegend } from './PatchGrid';
import { fmtPatch, fmtPatchRange, patchPair, placeInRange, type RangePlace } from '../lib/patchScale';
import type { LightRow, Match } from '../types/contract';
import '../styles/patchgrid.css';

/** Short names for the measure picker; the full label is the tooltip and the legend. */
const SHORT: Record<string, string> = {
  shadow_frac_el1: 'Sun 1°',
  shadow_frac_el3: 'Sun 3°',
  shadow_frac_el5: 'Sun 5°',
  shadow_frac_timeweighted: 'Low-sun day',
  jump1km_p95_m: 'Jumps P95',
  jump1km_p99_m: 'Jumps P99',
  frac_track_over_500m: 'Over 500 m',
  slope_p50_deg: 'Slope',
  fast_per_km2_el3: 'Keypoints',
  empty_cell_frac_el3: 'Featureless',
};

const PLACE_TEXT: Record<RangePlace, string> = { inside: '✓ inside', above: '↑ above', below: '↓ below' };

export function PatchPair({ match, moonName, earthName }: { match: Match; moonName: string; earthName: string }): JSX.Element | null {
  const options = match.lights.filter((l: LightRow): boolean => patchPair(l) !== null);
  const [metric, setMetric] = useState<string | null>(headlineLight(match)?.metric ?? options[0]?.metric ?? null);
  const light = options.find((l: LightRow): boolean => l.metric === metric) ?? options[0] ?? null;
  const pair = patchPair(light);
  if (!pair) return null;
  const place = placeInRange(pair.earthWhole, pair.range, pair.unit);
  return (
    <section className="pgpair" aria-label="Patch by patch">
      <h4 className="section-label">Patch by patch</h4>
      <p className="pgpair__cap">We split each 15 km square into 25 patches of 3 km. ‘Typical’ = the middle half of the Moon’s patches.</p>
      {options.length > 1 && (
        <div className="seg pgpair__measures" role="group" aria-label="Measure">
          {options.map((l: LightRow) => (
            <button key={l.metric} type="button" aria-pressed={l.metric === pair.metric} title={patchPair(l)?.label} onClick={(): void => setMetric(l.metric)}>
              {SHORT[l.metric] ?? l.metric}
            </button>
          ))}
        </div>
      )}
      <div className="pgpair__grids">
        <PatchGrid
          label={`Moon · ${moonName}`}
          values={pair.moon}
          unit={pair.unit}
          range={pair.range}
          scaleMin={pair.scaleMin}
          scaleMax={pair.scaleMax}
          hazard={match.hazard}
          highlightOutside
          size="md"
          up="grid up"
        />
        <PatchGrid
          label={`Earth · ${earthName}`}
          values={pair.earth}
          unit={pair.unit}
          range={pair.range}
          scaleMin={pair.scaleMin}
          scaleMax={pair.scaleMax}
          hazard={match.hazard}
          highlightOutside
          size="md"
          up="north"
        />
      </div>
      <div className="pgrid-legend-row">
        <span className="pgpair__measure">{pair.label}</span>{' '}
        <PatchLegend scaleMin={pair.scaleMin} scaleMax={pair.scaleMax} unit={pair.unit} hazard={match.hazard} ringed />
      </div>
      <p className="pgpair__result">
        Moon’s typical patches: <strong>{fmtPatchRange(pair.range, pair.unit)}</strong> · Earth (whole square):{' '}
        <strong>{fmtPatch(pair.earthWhole, pair.unit)}</strong>{' '}
        <span className="pgpair__place" data-place={place}>
          {PLACE_TEXT[place]}
        </span>
      </p>
    </section>
  );
}
