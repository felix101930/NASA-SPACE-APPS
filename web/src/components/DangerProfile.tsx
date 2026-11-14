import { useState, type JSX, type MouseEvent, type ReactNode } from 'react';
import { HEADLINE, LEVEL_LABEL, ROW_NAME, ROW_SUB, metricInfo, ordinal, type ProfileRowId } from '../content';
import type { HazardId, Level, Region } from '../types/contract';
import { ChevronGlyph, HazardGlyph } from './Glyphs';
import { InfoTip } from './InfoTip';
import { Term, Why, WhyBody } from './Term';
import { fmtPm } from '../lib/units';
import '../styles/clarity-moon.css';

const ROWS: ProfileRowId[] = ['shadow', 'rim', 'texture', 'slope'];

export function CoordBadge({ region }: { region: Region }): JSX.Element {
  const title = [region.coord_source, region.coord_method].filter(Boolean).join('\n');
  if (region.coord_quality === 'traced_approx') {
    return (
      <span className="chip chip-dashed" title={title}>
        Approximate location, traced from NASA map
      </span>
    );
  }
  return (
    <span className="chip" title={title}>
      {region.coord_quality === 'pgda_roi' ? 'PGDA ROI outline' : 'PGDA site tile'}
    </span>
  );
}

export function formatLatLon(lat: number, lon: number): string {
  const ns = `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'}`;
  const ew = `${Math.abs(lon).toFixed(1)}°${lon < 0 ? 'W' : 'E'}`;
  return `${ns} ${ew}`;
}

/** Danger score used for ranking: the pipeline's score for hazards, P90 slope for slope. */
export function rowScore(r: Region, id: ProfileRowId): number {
  return id === 'slope' ? r.hazards.slope.metrics.slope_p90_deg : r.hazards[id].score;
}

/** Level word: the pipeline's tercile for hazards; the same tercile rule applied to the slope rank. */
export function rowLevel(r: Region, id: ProfileRowId, rank: number, n: number): Level {
  if (id !== 'slope') return r.hazards[id].level;
  const t = rank / n;
  return t <= 1 / 3 ? 'low' : t <= 2 / 3 ? 'med' : 'high';
}

export interface RankInfo {
  /** 1 = least dangerous. */
  rank: number;
  n: number;
  /** Region ids ordered from least to most dangerous. */
  order: string[];
}

export function rankOf(regions: Region[], region: Region, id: ProfileRowId): RankInfo {
  const order = [...regions].sort((a: Region, b: Region): number => rowScore(a, id) - rowScore(b, id) || a.name.localeCompare(b.name));
  const idx = order.findIndex((r: Region): boolean => r.id === region.id);
  return { rank: idx + 1, n: order.length, order: order.map((r: Region): string => r.id) };
}

function headlineValue(region: Region, id: ProfileRowId): number | undefined {
  const k = HEADLINE[id].key;
  if (id === 'slope') return region.hazards.slope.metrics.slope_p90_deg;
  return region.hazards[id].metrics[k];
}

function rawRows(region: Region, id: ProfileRowId): [string, string][] {
  if (id === 'slope') {
    const s = region.hazards.slope.metrics;
    return [
      ['Median slope', `${s.slope_p50_deg.toFixed(1)}°`],
      ['Slope, 90th percentile', `${s.slope_p90_deg.toFixed(1)}°`],
      ...Object.entries(s.rms_dev_m).map(([k, v]: [string, number]): [string, string] => [
        `RMS height change over ${k} m`,
        `${Number(v).toFixed(1)} m`,
      ]),
    ];
  }
  return Object.entries(region.hazards[id].metrics).map(([k, v]: [string, number]): [string, string] => [
    metricInfo(k).label,
    metricInfo(k).fmt(v),
  ]);
}

/** Nine dots, least to most dangerous; this region's dot is filled in the hazard hue. */
export function RankStrip({
  info,
  regionId,
  hazard,
  label,
}: {
  info: RankInfo;
  regionId: string;
  hazard: ProfileRowId;
  label: string;
}): JSX.Element {
  return (
    <span className="rank-strip" data-hz={hazard} role="img" aria-label={label}>
      {info.order.map((id: string) => (
        <span key={id} className="rank-dot" data-on={id === regionId} />
      ))}
    </span>
  );
}

/** Shorter unit captions than content.ts HEADLINE (same facts, fewer words). */
const UNIT_SHORT: Record<ProfileRowId, string> = {
  shadow: 'in shadow, 3° sun',
  rim: 'over 1 km (95th pct)',
  texture: 'of 1 km cells blank',
  slope: '90th percentile',
};

function stop(e: MouseEvent): void {
  e.stopPropagation();
}

/** Keeps an ⓘ inside a clickable row from also toggling the row. */
function Quiet({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span className="quiet-tip" onClick={stop}>
      {children}
    </span>
  );
}

function nameTerm(id: ProfileRowId): JSX.Element {
  const label = <span className="profile-name-text">{ROW_NAME[id]}</span>;
  if (id === 'shadow') return <Term id="shadowShare">{label}</Term>;
  if (id === 'rim') return <Term id="rimDrop">{label}</Term>;
  if (id === 'texture') return <Term id="cameraTexture">{label}</Term>;
  return label;
}

function valueWhy(region: Region, id: ProfileRowId): JSX.Element {
  if (id === 'shadow') return <Why id="shadowFar" />;
  if (id === 'texture') return <Why id="texture" />;
  const err = id === 'rim' ? fmtPm(region.uncertainty.dem_err_p50_m, 'm') : '±1.5–2.5°';
  return (
    <InfoTip label={id === 'rim' ? 'Why the 95th percentile, and how exact is the Moon height?' : 'How exact is the Moon slope?'}>
      {id === 'rim' && <WhyBody id="rimP95" />}
      <p>
        <strong>Moon data error:</strong> {err} {id === 'rim' ? '(median height error of the LOLA elevation model)' : '(LOLA slope error)'}.
      </p>
      {id === 'slope' && <WhyBody id="moonDem" />}
    </InfoTip>
  );
}

interface DangerProfileProps {
  region: Region;
  regions: Region[];
  /** Rows whose 3D layer is currently on (Explore in 3D). Optional. */
  activeLayers?: ReadonlySet<string>;
  /** Called when a row is clicked, e.g. to turn its 3D layer on. Optional. */
  onRowActivate?: (id: ProfileRowId) => void;
}

export function DangerProfile({ region, regions, activeLayers, onRowActivate }: DangerProfileProps): JSX.Element {
  const [open, setOpen] = useState<ProfileRowId | null>(null);

  return (
    <div className="profile">
      <div className="profile-head">
        <h3>
          <Term id="dangerProfile">Danger profile</Term>
        </h3>
        <span className="why-row caption">
          Rank of 9 (1st = least)
          <InfoTip label="What do the dots and the rank show?" title="Rank among the 9 regions" align="end">
            <p>
              The nine dots are the nine candidate regions, ordered from least to most dangerous for that danger. The filled dot is this
              region. “4th of 9” means three regions are less dangerous and five are more.
            </p>
          </InfoTip>
        </span>
      </div>
      <ul className="profile-rows">
        {ROWS.map((id: ProfileRowId) => {
          const info = rankOf(regions, region, id);
          const level = rowLevel(region, id, info.rank, info.n);
          const v = headlineValue(region, id);
          const isOpen = open === id;
          const levelWord = LEVEL_LABEL[level] ?? level;
          return (
            <li key={id} className="profile-row" data-open={isOpen} data-layer={activeLayers?.has(id) ?? false}>
              <div
                className="profile-row-btn"
                onClick={(): void => {
                  setOpen(isOpen ? null : id);
                  onRowActivate?.(id);
                }}
              >
                <span className="profile-name">
                  <HazardGlyph hazard={id} />
                  <Quiet>{nameTerm(id)}</Quiet>
                  <span className="caption" title={ROW_SUB[id]}>
                    {ROW_SUB[id].split(' · ')[0].replace('Walking and touchdown', 'Walking')}
                  </span>
                  {activeLayers?.has(id) && <span className="chip layer-on">On in 3D</span>}
                </span>
                <span className="profile-level">
                  <strong>{levelWord}</strong>
                  <span className="caption" title="Rank among the 9 regions, 1st = least dangerous">
                    {ordinal(info.rank)} of {info.n}
                  </span>
                </span>
                <span className="profile-value">
                  <span className="profile-big">{typeof v === 'number' ? HEADLINE[id].value(v) : '—'}</span>
                  <span className="caption">{UNIT_SHORT[id]}</span>
                  <Quiet>{valueWhy(region, id)}</Quiet>
                </span>
                <span className="profile-strip">
                  <RankStrip
                    info={info}
                    regionId={region.id}
                    hazard={id}
                    label={`${ROW_NAME[id]}: ${levelWord}, ${ordinal(info.rank)} least dangerous of ${info.n} regions`}
                  />
                  <button
                    type="button"
                    className="profile-chev"
                    aria-expanded={isOpen}
                    aria-controls={`raw-${id}`}
                    aria-label={`${ROW_NAME[id]}: ${isOpen ? 'hide' : 'show'} measured values`}
                    onClick={(e: MouseEvent): void => {
                      e.stopPropagation();
                      setOpen(isOpen ? null : id);
                      onRowActivate?.(id);
                    }}
                  >
                    <ChevronGlyph open={isOpen} />
                  </button>
                </span>
              </div>
              {isOpen && (
                <table className="metric-table" id={`raw-${id}`}>
                  <tbody>
                    {rawRows(region, id).map(([k, val]: [string, string]) => (
                      <tr key={k}>
                        <td>{k}</td>
                        <td>{val}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** One plain sentence: which hazards are high, medium, low for this region. */
export function profileSentence(region: Region): string {
  const by: Record<Level, string[]> = { high: [], med: [], low: [] };
  const names: Record<HazardId, string> = { shadow: 'shadow', rim: 'rim jumps', texture: 'texture' };
  (['shadow', 'rim', 'texture'] as const).forEach((h: HazardId): void => {
    by[region.hazards[h].level]?.push(names[h]);
  });
  const parts: string[] = [];
  const join = (w: string[]): string => (w.length <= 1 ? (w[0] ?? '') : `${w.slice(0, -1).join(', ')} and ${w[w.length - 1]}`);
  if (by.high.length) parts.push(`high danger for ${join(by.high)}`);
  if (by.med.length) parts.push(`medium for ${join(by.med)}`);
  if (by.low.length) parts.push(`low for ${join(by.low)}`);
  const s = parts.join('; ');
  return s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}.` : '';
}
