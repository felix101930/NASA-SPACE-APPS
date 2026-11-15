// Where the 5 suggested events go: equity.json's ranking (using the City's Equity Index, recomputed in the browser) next
// to the same ranking without it (closest to transit and best slope match only, same 2 km spacing).
import type { JSX } from 'react';
import { InfoTip } from '../../components/InfoTip';
import type { EventPick, TractInfo } from './planner';
import { accessPhrase, HARDEST } from './shared';

export interface EquityCompareProps {
  withNeed: EventPick[];
  withoutNeed: EventPick[];
  tracts: Map<string, TractInfo>;
  onPick: (pick: EventPick) => void;
}

export interface EquityResult {
  n: number;
  /** Picks in the two hardest-to-reach groups (High or Highest), with and without the Equity Index. */
  withIndex: number;
  withoutIndex: number;
}

export function equityResult(withNeed: EventPick[], withoutNeed: EventPick[], tracts: Map<string, TractInfo>): EquityResult {
  const hard = (list: EventPick[]): number => list.filter((p: EventPick): boolean => HARDEST.has(tracts.get(p.ctuid)?.category ?? '')).length;
  return { n: withNeed.length, withIndex: hard(withNeed), withoutIndex: hard(withoutNeed) };
}

const SHORT: Record<string, string> = { Highest: 'Hardest', High: 'Hard', Moderate: 'Middling', Low: 'Easier', Lowest: 'Easiest' };

function PickList({ title, picks, tracts, onPick }: { title: string; picks: EventPick[]; tracts: Map<string, TractInfo>; onPick: (p: EventPick) => void }): JSX.Element {
  return (
    <div className="cg-cmp-col">
      <h4 className="cg-cmp-title">{title}</h4>
      <ol className="cg-cmp-list">
        {picks.map((p: EventPick) => {
          const t = tracts.get(p.ctuid);
          const name = t?.communities[0] ?? t?.label ?? p.ctuid;
          const cat = t?.category ?? '';
          return (
            <li key={p.ctuid}>
              <button
                type="button"
                className="cg-cmp-item"
                onClick={(): void => onPick(p)}
                title={`${t?.label ?? name}: ${accessPhrase(cat).toLowerCase()}. Show on the map.`}
              >
                <span className="cg-cmp-n" aria-hidden="true">
                  {p.rank}
                </span>
                <span className="need-swatch" data-need={cat} aria-hidden="true" />
                <span className="cg-cmp-name">{name}</span>
                <span className="cg-cmp-need">{SHORT[cat] ?? '—'}</span>
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
        <h4 id="cg-cmp-h" className="cg-sub">
          Where the 5 events would go
        </h4>
        <InfoTip label="How the two lists differ" title="Same score, one factor apart" align="end">
          <div className="infotip-body">
            <p>
              Both lists pick one route per neighbourhood and keep starts at least 2 km apart. <strong>Using the Equity Index</strong>: how hard
              amenities are to reach, closeness to transit and slope match, multiplied together. <strong>Without</strong>: closeness to transit
              and slope match only.
            </p>
            <p>“How hard amenities are to reach” is the neighbourhood’s Accessibility &amp; Amenities percentile (Calgary Equity Index 2024).</p>
          </div>
        </InfoTip>
      </div>
      <div className="cg-cmp-grid">
        <PickList title="Using the City’s Equity Index" picks={withNeed} tracts={tracts} onPick={onPick} />
        <PickList title="Closest to transit and best slope match only" picks={withoutNeed} tracts={tracts} onPick={onPick} />
      </div>
      <p className="caption">Last column: how hard amenities are to reach.</p>
    </section>
  );
}
