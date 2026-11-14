// Below the 3D panes: the basic numbers behind the match, what doesn't match, what can't be tested, and when to go.
import type { JSX } from 'react';
import { headlineLight, PatchFor } from '../../components/PatchFor';
import { SunGlyph, VerdictGlyph, type VerdictKind } from '../../components/Glyphs';
import { InfoTip } from '../../components/InfoTip';
import { Why } from '../../components/Term';
import { isObj, type LightRow, type Match, type Region, type RehearsalWindow } from '../../types/contract';
import { plainNote } from '../../lib/plain';
import { fmtNum, fmtStat } from '../../lib/units';
import { compass, fmtMinutes, fmtValue, lightLabel, lightUsedToRank, lowSunWindow, verdictLight, windowDate, windowMinutes, windowPartOfDay, windowTime } from './copy';

// ------------------------------------------------------------------------------------------------
// "How sure?" inputs
// ------------------------------------------------------------------------------------------------

/** Per-metric NASADEM agreement r from method.json (nasadem_check.per_metric[m].r, else per_metric_r[m]). */
export function nasademAgreement(method: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObj(method) || !isObj(method.nasadem_check)) return out;
  const nc = method.nasadem_check;
  if (isObj(nc.per_metric_r)) {
    for (const [k, v] of Object.entries(nc.per_metric_r)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  if (isObj(nc.per_metric)) {
    for (const [k, v] of Object.entries(nc.per_metric)) if (isObj(v) && typeof v.r === 'number' && Number.isFinite(v.r)) out[k] = v.r;
  }
  return out;
}

/** "A second elevation dataset agrees r 0.96–1.00 on shadow, drop and slope; texture is less certain (r 0.62)." */
function agreementLine(agreement: Record<string, number>): string | null {
  const solid = Object.entries(agreement)
    .filter(([k]: [string, number]): boolean => k.startsWith('shadow') || k.startsWith('jump') || k.startsWith('slope'))
    .map(([, v]: [string, number]): number => v);
  if (!solid.length) return null;
  const lo = Math.min(...solid);
  const hi = Math.max(...solid);
  const tex = agreement.fast_per_km2_el3;
  const range = lo === hi ? fmtStat(lo) : `${fmtStat(lo)}–${fmtStat(hi)}`;
  return `A second elevation dataset agrees r ${range} on shadow, drop and slope${
    typeof tex === 'number' ? `; texture is less certain (r ${fmtStat(tex)})` : ''
  }.`;
}

// ------------------------------------------------------------------------------------------------
// Basic numbers: Moon · Earth · difference in units
// ------------------------------------------------------------------------------------------------

const MAX_ROWS = 3;

/** Earth minus Moon in the metric's own unit, from the values as shown (so 45% vs 44% reads "1 pt lower"). */
export function diffText(l: LightRow): string {
  const d = l.earth - l.moon;
  if (!Number.isFinite(d)) return '–';
  const word = (v: number): string => (v > 0 ? 'higher' : 'lower');
  const m = l.metric;
  let amount: string;
  let rounded: number;
  if (m.startsWith('shadow_frac') || m === 'empty_cell_frac_el3') {
    rounded = Math.round(l.earth * 100) - Math.round(l.moon * 100);
    amount = `${fmtNum(Math.abs(rounded))} ${Math.abs(rounded) === 1 ? 'pt' : 'pts'}`;
  } else if (m === 'frac_track_over_500m') {
    rounded = Math.round(d * 1000) / 10;
    amount = `${fmtNum(Math.abs(rounded), 1)} pts`;
  } else if (m.startsWith('jump')) {
    rounded = Math.round(l.earth) - Math.round(l.moon);
    amount = `${fmtNum(Math.abs(rounded))} m`;
  } else if (m.startsWith('slope')) {
    rounded = Math.round(l.earth) - Math.round(l.moon);
    amount = `${fmtNum(Math.abs(rounded))}°`;
  } else if (m === 'fast_per_km2_el3') {
    rounded = Math.round(d * 10) / 10;
    amount = `${fmtNum(Math.abs(rounded), 1)} /km²`;
  } else {
    rounded = Math.round(d * 100) / 100;
    amount = fmtNum(Math.abs(rounded), 2);
  }
  return rounded === 0 ? 'same' : `${amount} ${word(rounded)}`;
}

export interface EvidenceProps {
  match: Match;
  region: Region;
  placeLabel: string;
  /** Per-metric NASADEM agreement r (method.json). */
  agreement: Record<string, number>;
}

export function EvidenceTable({ match, region, placeLabel, agreement }: EvidenceProps): JSX.Element {
  // Up to 3 rows, always including the measure quoted in the headline; ranked measures first, original order kept.
  const pool = [...match.lights].sort((a: LightRow, b: LightRow): number => Number(lightUsedToRank(b)) - Number(lightUsedToRank(a)));
  const head = verdictLight(match);
  const picked = head ? [head, ...pool.filter((l: LightRow): boolean => l !== head)].slice(0, MAX_ROWS) : pool.slice(0, MAX_ROWS);
  const rows = pool.filter((l: LightRow): boolean => picked.includes(l));
  const err = region.uncertainty?.dem_err_p50_m;
  const heights = typeof err === 'number' && Number.isFinite(err) ? `Moon heights ±${fmtNum(err, 1)} m, slopes ±2° (NASA LOLA error).` : 'Moon slopes ±2° (NASA LOLA error).';
  const agree = agreementLine(agreement);
  return (
    <section className="t3-section" aria-labelledby="t3-evidence-h">
      <div className="t3-section-head why-row">
        <h2 id="t3-evidence-h">The basic numbers</h2>
        <InfoTip label="How sure are these numbers?" title="How sure?">
          <p>{heights}</p>
          {agree && <p>{agree}</p>}
        </InfoTip>
      </div>
      <div className="t3-table-wrap">
        <table className="t3-table t3-table-basic">
          <thead>
            <tr>
              <th scope="col">Measure</th>
              <th scope="col" className="r">
                {region.name}
              </th>
              <th scope="col" className="r">
                <span className="t3-trunc" title={placeLabel}>
                  {placeLabel}
                </span>
              </th>
              <th scope="col" className="r">
                Earth vs Moon
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l: LightRow) => (
              <tr key={l.metric}>
                <th scope="row">
                  <span className="t3-measure">{lightLabel(l)}</span>
                </th>
                <td className="r t3-num">{fmtValue(l.metric, l.moon)}</td>
                <td className="r t3-num t3-num-earth">{fmtValue(l.metric, l.earth)}</td>
                <td className="r t3-diff">{diffText(l)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PatchFor light={headlineLight(match)} hazard={match.hazard} />
      {match.patchiness_summary?.text && <p className="t3-patch-line">{match.patchiness_summary.text}</p>}
    </section>
  );
}

// ------------------------------------------------------------------------------------------------
// Notes boxes
// ------------------------------------------------------------------------------------------------

function NoteBox({ kind, title, items, empty }: { kind: VerdictKind; title: string; items: string[]; empty: string }): JSX.Element {
  return (
    <section className="t3-note" data-kind={kind}>
      <h3>
        <VerdictGlyph kind={kind} />
        {title}
      </h3>
      {items.length ? (
        <ul>
          {items.map((t: string) => {
            const n = plainNote(t);
            return (
              <li key={t} title={n.title}>
                {n.text}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="t3-note-empty">{empty}</p>
      )}
    </section>
  );
}

export function NotesBoxes({ match }: { match: Match }): JSX.Element {
  return (
    <details className="t3-section t3-notes-more">
      <summary className="t3-dates-summary">
        <h2>Match notes</h2>
        <span className="t3-section-sub">
          {match.matches_text.length} line up · {match.mismatches_text.length} don’t · {match.cannot_test.length} untestable
        </span>
      </summary>
      <div className="t3-notes">
        <NoteBox kind="match" title="Lines up" items={match.matches_text} empty="Nothing listed." />
        <NoteBox kind="mismatch" title="Doesn’t match" items={match.mismatches_text} empty="No mismatches listed for this pick." />
        <NoteBox kind="cannot" title="Can’t test here" items={match.cannot_test} empty="Nothing listed." />
      </div>
    </details>
  );
}

// ------------------------------------------------------------------------------------------------
// When to go
// ------------------------------------------------------------------------------------------------

export function WindowsList({
  windows,
  placeLabel,
  activeIndex,
  onPick,
  open,
  onOpenChange,
}: {
  windows: RehearsalWindow[];
  placeLabel: string;
  activeIndex: number | null;
  onPick: (i: number) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  return (
    <details
      id="t3-all-dates"
      className="t3-section t3-dates"
      open={open}
      onToggle={(e): void => onOpenChange(e.currentTarget.open)}
    >
      <summary className="t3-dates-summary">
        <h2>All rehearsal dates</h2>
        <span className="t3-section-sub">
          {windows.length ? `${windows.length} in the next year` : 'none in the next year'}
        </span>
      </summary>
      <div className="why-row t3-section-sub">
        <span>Times when the sun at {placeLabel} sits as low as at the lunar south pole. Pick one to light both views.</span>
        <Why id="refraction" />
      </div>
      {windows.length === 0 ? (
        <p className="t3-note-empty">No low-sun windows were found for this site in the search period.</p>
      ) : (
        <ul className="t3-windows">
          {windows.map((w: RehearsalWindow, i: number) => {
            const mins = windowMinutes(w);
            const part = windowPartOfDay(w);
            return (
              <li key={`${w.start_utc}-${i}`}>
                <button type="button" className="t3-window" aria-pressed={activeIndex === i} onClick={(): void => onPick(i)}>
                  <span className="t3-window-date">{windowDate(w)}</span>
                  <span className="t3-window-time">
                    {windowTime(w)}
                    {part ? ` · ${part}` : ''}
                  </span>
                  <span className="t3-window-sun">
                    <SunGlyph size={14} />
                    {w.sun_el.toFixed(1)}° high, from the {compass(w.sun_az)}
                    {mins !== null ? ` · ${fmtMinutes(mins)}` : ''}
                    {lowSunWindow(w) ? ' · below 1°: refraction-sensitive' : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </details>
  );
}
