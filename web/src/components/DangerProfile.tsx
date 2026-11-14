import { useState, type JSX } from 'react';
import { HEADLINE, LEVEL_LABEL, ROW_NAME, ROW_SUB, metricInfo, ordinal, type ProfileRowId } from '../content';
import type { HazardId, Level, Region } from '../types/contract';
import { ChevronGlyph, HazardGlyph } from './Glyphs';

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

export function DangerProfile({ region, regions }: { region: Region; regions: Region[] }): JSX.Element {
  const [open, setOpen] = useState<ProfileRowId | null>(null);

  return (
    <div className="profile">
      <div className="profile-head">
        <h3>Danger profile</h3>
        <span className="caption">Dots: the 9 regions from least to most dangerous</span>
      </div>
      <ul className="profile-rows">
        {ROWS.map((id: ProfileRowId) => {
          const info = rankOf(regions, region, id);
          const level = rowLevel(region, id, info.rank, info.n);
          const v = headlineValue(region, id);
          const isOpen = open === id;
          const levelWord = LEVEL_LABEL[level] ?? level;
          return (
            <li key={id} className="profile-row" data-open={isOpen}>
              <button
                type="button"
                className="profile-row-btn"
                aria-expanded={isOpen}
                aria-controls={`raw-${id}`}
                onClick={(): void => setOpen(isOpen ? null : id)}
              >
                <span className="profile-name">
                  <HazardGlyph hazard={id} />
                  <span className="profile-name-text">{ROW_NAME[id]}</span>
                  <span className="caption">{ROW_SUB[id]}</span>
                </span>
                <span className="profile-level">
                  <strong>{levelWord}</strong>
                  <span className="caption">
                    {ordinal(info.rank)} of {info.n}
                  </span>
                </span>
                <span className="profile-value">
                  <span className="profile-big">{typeof v === 'number' ? HEADLINE[id].value(v) : '—'}</span>
                  <span className="caption">{HEADLINE[id].unit}</span>
                </span>
                <span className="profile-strip">
                  <RankStrip
                    info={info}
                    regionId={region.id}
                    hazard={id}
                    label={`${ROW_NAME[id]}: ${levelWord}, ${ordinal(info.rank)} least dangerous of ${info.n} regions`}
                  />
                  <ChevronGlyph open={isOpen} />
                </span>
              </button>
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
