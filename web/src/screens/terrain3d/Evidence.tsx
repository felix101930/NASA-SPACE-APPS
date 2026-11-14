// Below the 3D panes: the numbers behind the match, what doesn't match, what can't be tested, and when to go.
import type { JSX } from 'react';
import { Fit, SunGlyph, VerdictGlyph, type VerdictKind } from '../../components/Glyphs';
import type { LightRow, Match, RehearsalWindow } from '../../types/contract';
import {
  compass,
  fmtMinutes,
  fmtValue,
  lightLabel,
  lightUsedToRank,
  windowDate,
  windowMinutes,
  windowPartOfDay,
  windowTime,
} from './copy';

// ------------------------------------------------------------------------------------------------
// Evidence table
// ------------------------------------------------------------------------------------------------

interface Scale {
  lo: number;
  hi: number;
}

function rowScale(l: LightRow): Scale {
  const vals = [l.moon, l.earth, l.moon_iqr[0], l.moon_iqr[1]].filter((v: number): boolean => Number.isFinite(v));
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const span = hi - lo || Math.abs(hi) || 1;
  lo -= span * 0.18;
  hi += span * 0.18;
  return { lo, hi };
}

function at(s: Scale, v: number): number {
  return Math.min(100, Math.max(0, ((v - s.lo) / (s.hi - s.lo)) * 100));
}

function Band({ l }: { l: LightRow }): JSX.Element {
  const s = rowScale(l);
  const b0 = at(s, Math.min(l.moon_iqr[0], l.moon_iqr[1]));
  const b1 = at(s, Math.max(l.moon_iqr[0], l.moon_iqr[1]));
  return (
    <div
      className="t3-band"
      role="img"
      aria-label={`Moon typical range ${fmtValue(l.metric, l.moon_iqr[0])} to ${fmtValue(l.metric, l.moon_iqr[1])}; Earth ${fmtValue(l.metric, l.earth)}`}
    >
      <span className="t3-band-axis" />
      <span className="t3-band-range" style={{ left: `${b0}%`, width: `${Math.max(1, b1 - b0)}%` }} />
      <span className="t3-band-moon" style={{ left: `${at(s, l.moon)}%` }} />
      <span className="t3-band-earth" style={{ left: `${at(s, l.earth)}%` }} />
    </div>
  );
}

export function EvidenceTable({ match, regionName, placeLabel }: { match: Match; regionName: string; placeLabel: string }): JSX.Element {
  const rows = [...match.lights].sort((a: LightRow, b: LightRow): number => Number(lightUsedToRank(b)) - Number(lightUsedToRank(a)));
  return (
    <section className="t3-section" aria-labelledby="t3-evidence-h">
      <div className="t3-section-head">
        <h2 id="t3-evidence-h">The numbers behind the match</h2>
        <div className="t3-legend" aria-hidden="true">
          <span>
            <i className="t3-key-range" /> Moon’s typical spread
          </span>
          <span>
            <i className="t3-key-moon" /> Moon
          </span>
          <span>
            <i className="t3-key-earth" /> Earth
          </span>
        </div>
      </div>
      <div className="t3-table-wrap">
        <table className="t3-table">
          <thead>
            <tr>
              <th scope="col">Measure</th>
              <th scope="col" className="r">
                {regionName}
              </th>
              <th scope="col" className="t3-col-band">
                Where Earth lands
              </th>
              <th scope="col">
                <span className="t3-trunc" title={placeLabel}>
                  {placeLabel}
                </span>
              </th>
              <th scope="col">Fit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l: LightRow) => {
              const used = lightUsedToRank(l);
              return (
                <tr key={l.metric} data-used={used}>
                  <th scope="row">
                    <span className="t3-measure">{lightLabel(l)}</span>
                    {!used && <span className="t3-context">context, not used to rank</span>}
                  </th>
                  <td className="r t3-num">
                    {fmtValue(l.metric, l.moon)}
                    <span className="t3-iqr">
                      typical {fmtValue(l.metric, l.moon_iqr[0])}–{fmtValue(l.metric, l.moon_iqr[1])}
                    </span>
                  </td>
                  <td className="t3-col-band">
                    <Band l={l} />
                  </td>
                  <td className="t3-num t3-num-earth">
                    {fmtValue(l.metric, l.earth)}
                    {l.gap_text && <span className="t3-iqr">{l.gap_text}</span>}
                  </td>
                  <td>
                    <Fit fit={l.light} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="t3-footnote">
        “Close” means the Earth value sits inside the Moon’s typical spread (the Moon value ± half its interquartile range across the
        tile); “Partial” is within twice that; “Far” is beyond it.
      </p>
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
          {items.map((t: string) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      ) : (
        <p className="t3-note-empty">{empty}</p>
      )}
    </section>
  );
}

export function NotesBoxes({ match }: { match: Match }): JSX.Element {
  return (
    <div className="t3-notes">
      <NoteBox kind="match" title="Lines up" items={match.matches_text} empty="Nothing listed." />
      <NoteBox kind="mismatch" title="Doesn’t match" items={match.mismatches_text} empty="No mismatches listed for this pick." />
      <NoteBox kind="cannot" title="Can’t test here" items={match.cannot_test} empty="Nothing listed." />
    </div>
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
}: {
  windows: RehearsalWindow[];
  placeLabel: string;
  activeIndex: number | null;
  onPick: (i: number) => void;
}): JSX.Element {
  return (
    <section className="t3-section" aria-labelledby="t3-windows-h">
      <div className="t3-section-head t3-section-head-col">
        <h2 id="t3-windows-h">When to go</h2>
        <p className="t3-section-sub">
          Times when the sun at {placeLabel} sits as low as it does at the lunar south pole. Pick one to light both views with that sun.
        </p>
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
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
