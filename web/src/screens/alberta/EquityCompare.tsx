// "How the Equity Index changes the plan": the top-5 event locations with the need weighting (equity.json's ranking,
// recomputed in the browser) next to the same ranking without it (transit × slope match only, same 2 km spacing).
import type { JSX } from 'react';
import { InfoTip } from '../../components/InfoTip';
import type { EventPick, TractInfo } from './planner';

const HIGHER: ReadonlySet<string> = new Set(['Highest', 'High']);

export interface EquityCompareProps {
  withNeed: EventPick[];
  withoutNeed: EventPick[];
  tracts: Map<string, TractInfo>;
  onPick: (pick: EventPick) => void;
}

/** One sentence, computed: how many picks change and whether they move to higher need. */
export function compareLine(withNeed: EventPick[], withoutNeed: EventPick[], tracts: Map<string, TractInfo>): string {
  const before = new Set(withoutNeed.map((p: EventPick): string => p.ctuid));
  const after = new Set(withNeed.map((p: EventPick): string => p.ctuid));
  const added = withNeed.filter((p: EventPick): boolean => !before.has(p.ctuid));
  const dropped = withoutNeed.filter((p: EventPick): boolean => !after.has(p.ctuid));
  const hi = (list: EventPick[]): number => list.filter((p: EventPick): boolean => HIGHER.has(tracts.get(p.ctuid)?.category ?? '')).length;
  const n = withNeed.length;
  if (!added.length) return `The Equity Index keeps the same ${n} locations.`;
  const mean = (list: EventPick[]): number => list.reduce((s: number, p: EventPick): number => s + p.need, 0) / Math.max(list.length, 1);
  const verb = mean(added) > mean(dropped) ? 'move to higher-need neighbourhoods' : 'change';
  return `With the Equity Index, ${added.length} of ${n} events ${verb} (High or Highest need: ${hi(withNeed)} of ${n}, vs ${hi(withoutNeed)} of ${n} without).`;
}

function PickList({ title, picks, tracts, onPick }: { title: string; picks: EventPick[]; tracts: Map<string, TractInfo>; onPick: (p: EventPick) => void }): JSX.Element {
  return (
    <div className="cg-cmp-col">
      <h4 className="cg-cmp-title">{title}</h4>
      <ol className="cg-cmp-list">
        {picks.map((p: EventPick) => {
          const t = tracts.get(p.ctuid);
          const name = t?.communities[0] ?? t?.label ?? p.ctuid;
          return (
            <li key={p.ctuid}>
              <button type="button" className="cg-cmp-item" onClick={(): void => onPick(p)} title={`${t?.label ?? name}: open in the planner`}>
                <span className="cg-cmp-n" aria-hidden="true">
                  {p.rank}
                </span>
                <span className="need-swatch" data-need={t?.category ?? ''} aria-hidden="true" />
                <span className="cg-cmp-name">{name}</span>
                <span className="cg-cmp-need">{t?.category ?? '—'}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function EquityCompare({ withNeed, withoutNeed, tracts, onPick }: EquityCompareProps): JSX.Element {
  return (
    <section className="cg-cmp" aria-labelledby="cg-cmp-h">
      <div className="cg-h">
        <h3 id="cg-cmp-h">How the Equity Index changes the plan</h3>
        <InfoTip label="How the two rankings differ" title="Same score, one factor apart" align="end">
          <div className="infotip-body">
            <p>
              Both lists pick one route per neighbourhood and keep starts at least 2 km apart. <strong>With</strong>: need × transit × slope match.{' '}
              <strong>Without</strong>: transit × slope match only.
            </p>
            <p>Need is the neighbourhood’s Accessibility &amp; Amenities percentile (Calgary Equity Index 2024; higher = greater need).</p>
          </div>
        </InfoTip>
      </div>
      <p className="cg-cmp-line">{compareLine(withNeed, withoutNeed, tracts)}</p>
      <div className="cg-cmp-grid">
        <PickList title="With need weighting" picks={withNeed} tracts={tracts} onPick={onPick} />
        <PickList title="Without (transit × slope)" picks={withoutNeed} tracts={tracts} onPick={onPick} />
      </div>
    </section>
  );
}
