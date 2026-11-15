// Earth matches: the Moon region and the Earth site as 25 patches each, side by side on one colour scale, with
// the Moon's typical range (middle half of its patches) and where the Earth square's whole value falls.
import { useState, type JSX } from 'react';
import { headlineLight } from './PatchFor';
import { PatchGrid, PatchLegend } from './PatchGrid';
import { fmtPatch, fmtPatchRange, middleHalf, patchPair, placeInRange, type PatchUnit, type RangePlace } from '../lib/patchScale';
import type { LightRow, Match, Patchiness } from '../types/contract';
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

const PLACE_TEXT: Record<RangePlace, string> = {
  inside: '✓ Fits in',
  above: '↑ Above the Moon’s typical range',
  below: '↓ Below the Moon’s typical range',
};

const PATCHINESS_TEXT: Record<Patchiness, string> = {
  similar: 'varies about as much as the Moon',
  smoother: 'varies less than the Moon (smoother)',
  patchier: 'varies more than the Moon (patchier)',
};

/** What a share measures, so the gap reads in words ("4% more of the ground in shadow"). */
const SHARE_NOUN: Record<string, string> = {
  empty_cell_frac_el3: 'of the 1 km squares featureless',
  frac_track_over_500m: 'of the 1 km squares over 500 m',
};

/** Earth minus Moon on the whole square, in plain words and the metric's own unit. */
function gapWords(metric: string, unit: PatchUnit, diff: number): string {
  if (!Number.isFinite(diff)) return '—';
  const more = diff > 0;
  const a = Math.abs(diff);
  if (unit === 'share') {
    const v = a * 100;
    const n = v < 1 ? v.toFixed(1) : String(Math.round(v));
    if (Number(n) === 0) return 'Same';
    return `Earth ${n}% ${more ? 'more' : 'less'} ${SHARE_NOUN[metric] ?? 'of the ground in shadow'}`;
  }
  if (unit === 'm') return Math.round(a) === 0 ? 'Same' : `Earth ${Math.round(a)} m ${more ? 'bigger' : 'smaller'} jumps`;
  if (unit === 'deg') return a < 0.05 ? 'Same' : `Earth ${a.toFixed(1)}° ${more ? 'steeper' : 'gentler'}`;
  return a < 0.05 ? 'Same' : `Earth ${a.toFixed(1)} ${more ? 'more' : 'fewer'} keypoints per km²`;
}

export function PatchPair({ match, moonName, earthName }: { match: Match; moonName: string; earthName: string }): JSX.Element | null {
  const options = match.lights.filter((l: LightRow): boolean => patchPair(l) !== null);
  const [metric, setMetric] = useState<string | null>(headlineLight(match)?.metric ?? options[0]?.metric ?? null);
  const light = options.find((l: LightRow): boolean => l.metric === metric) ?? options[0] ?? null;
  const pair = patchPair(light);
  if (!pair) return null;
  const place = placeInRange(pair.earthWhole, pair.range, pair.unit);
  const earthRange: [number, number] | null = middleHalf(pair.earth);
  const patchy: Patchiness | null = light?.patchiness ?? null;
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
        <table className="pgsum" aria-label="Moon and Earth summary">
          <thead>
            <tr>
              <th scope="col"><span className="sr-only">Row</span></th>
              <th scope="col">Moon</th>
              <th scope="col">Earth</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Whole square</th>
              <td>{fmtPatch(pair.moonWhole, pair.unit)}</td>
              <td>{fmtPatch(pair.earthWhole, pair.unit)}</td>
            </tr>
            <tr className="pgsum__note">
              <td colSpan={3}>{gapWords(pair.metric, pair.unit, pair.earthWhole - pair.moonWhole)}</td>
            </tr>
            <tr>
              <th scope="row">
                Typical patch
                <small>(middle half of the 25 patches)</small>
              </th>
              <td>{fmtPatchRange(pair.range, pair.unit)}</td>
              <td>{earthRange ? fmtPatchRange(earthRange, pair.unit) : '—'}</td>
            </tr>
            <tr>
              <th scope="row">Verdict</th>
              <td colSpan={2} data-place={place}>
                <strong>{PLACE_TEXT[place]}</strong>
                {patchy ? ` · ${PATCHINESS_TEXT[patchy]}` : ''}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="pgrid-legend-row">
        <span className="pgpair__measure">{pair.label}</span>{' '}
        <PatchLegend scaleMin={pair.scaleMin} scaleMax={pair.scaleMax} unit={pair.unit} hazard={match.hazard} ringed />
      </div>
    </section>
  );
}
