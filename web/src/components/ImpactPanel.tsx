// "Why it matters": four figures (dollars at stake, a field-week estimate, travel CO2e saved, open-ground sites),
// each with an "i" popover holding the formula and sources. Data: data/impact.json (python -m pipeline.impact).
// No props. Renders nothing while loading or if impact.json is missing, so it is safe to place anywhere.
import { useEffect, useState, type JSX } from 'react';
import { loadJsonFrom, type Loaded } from '../data/loader';
import { InfoTip } from './InfoTip';
import '../styles/impact.css';

type ImpactKind = 'sourced' | 'computed' | 'estimate';

interface ImpactSource {
  name: string;
  url: string;
}

interface ImpactStat {
  id: string;
  kind: ImpactKind;
  value: number;
  prefix: string;
  unit: string;
  label: string;
  how: string[];
  formula: string;
  sources: ImpactSource[];
}

interface ImpactFile {
  headline: ImpactStat[];
}

const KIND_LABEL: Record<ImpactKind, string> = {
  sourced: 'From the source',
  computed: 'Computed from our matches',
  estimate: 'Estimate',
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStrArr(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x: unknown): boolean => typeof x === 'string');
}

function isSource(v: unknown): v is ImpactSource {
  return isObj(v) && typeof v.name === 'string' && typeof v.url === 'string';
}

function isKind(v: unknown): v is ImpactKind {
  return v === 'sourced' || v === 'computed' || v === 'estimate';
}

function isStat(v: unknown): v is ImpactStat {
  return (
    isObj(v) &&
    typeof v.id === 'string' &&
    isKind(v.kind) &&
    typeof v.value === 'number' &&
    Number.isFinite(v.value) &&
    typeof v.prefix === 'string' &&
    typeof v.unit === 'string' &&
    typeof v.label === 'string' &&
    isStrArr(v.how) &&
    typeof v.formula === 'string' &&
    Array.isArray(v.sources) &&
    v.sources.every(isSource)
  );
}

function isImpactFile(v: unknown): v is ImpactFile {
  return isObj(v) && Array.isArray(v.headline) && v.headline.length > 0 && v.headline.every(isStat);
}

const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

function Stat({ s, alignEnd }: { s: ImpactStat; alignEnd: boolean }): JSX.Element {
  const figure = `${s.prefix}${nf.format(s.value)}`;
  return (
    <li className={`impact-stat impact-${s.kind}`}>
      <p className="impact-figure">
        <span className="impact-num">{figure}</span>
        <span className="impact-unit">{s.unit}</span>
      </p>
      <div className="impact-row">
        <span className="impact-label">{s.label}</span>
        <InfoTip label={`How we got ${figure} ${s.unit}`} title="How we got this" align={alignEnd ? 'end' : 'start'}>
          <p className="impact-kind-line">{KIND_LABEL[s.kind]}</p>
          {s.how.map((h: string) => (
            <p key={h}>{h}</p>
          ))}
          <p>
            <code className="impact-formula">{s.formula}</code>
          </p>
          <ul className="impact-sources">
            {s.sources.map((src: ImpactSource) => (
              <li key={src.url}>
                <a href={src.url} target="_blank" rel="noreferrer">
                  {src.name}
                </a>
              </li>
            ))}
          </ul>
        </InfoTip>
      </div>
      {s.kind === 'estimate' && <span className="impact-tag">Estimate</span>}
    </li>
  );
}

export function ImpactPanel(): JSX.Element | null {
  const [stats, setStats] = useState<ImpactStat[] | null>(null);

  useEffect((): (() => void) => {
    let alive = true;
    loadJsonFrom('impact.json', isImpactFile, 'data')
      .then((res: Loaded<ImpactFile> | null): void => {
        if (alive && res) setStats(res.value.headline);
      })
      .catch((): void => {
        /* optional panel: stay hidden */
      });
    return (): void => {
      alive = false;
    };
  }, []);

  if (!stats) return null;
  return (
    <section className="impact" aria-labelledby="impact-title">
      <h2 id="impact-title" className="impact-title">
        Why it matters
      </h2>
      <ul className="impact-grid">
        {stats.map((s: ImpactStat, i: number) => (
          <Stat key={s.id} s={s} alignEnd={i % 2 === 1} />
        ))}
      </ul>
    </section>
  );
}
