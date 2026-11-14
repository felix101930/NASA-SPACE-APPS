import { useState, type JSX } from 'react';
import { HAZARDS, LEVEL_LABEL, metricInfo } from '../content';
import type { HazardId, Region } from '../types/contract';

export const HZ_VAR: Record<HazardId | 'slope', string> = {
  shadow: 'var(--hz-shadow)',
  rim: 'var(--hz-rim)',
  texture: 'var(--hz-texture)',
  slope: 'var(--hz-slope)',
};

type RowId = HazardId | 'slope';

function MetricRows({ rows }: { rows: [string, string][] }): JSX.Element {
  return (
    <table className="metric-table">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <td>{k}</td>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function CoordBadge({ region }: { region: Region }): JSX.Element {
  const title = [region.coord_source, region.coord_method].filter(Boolean).join('\n');
  if (region.coord_quality === 'traced_approx') {
    return (
      <span className="chip chip-warn" title={title}>
        Approximate, traced from NASA map
      </span>
    );
  }
  return (
    <span className="chip chip-ok" title={title}>
      {region.coord_quality === 'pgda_roi' ? 'PGDA ROI outline' : 'PGDA site tile'}
    </span>
  );
}

export function DangerProfile({ region }: { region: Region }): JSX.Element {
  const [open, setOpen] = useState<RowId | null>(null);
  const [pinned, setPinned] = useState<RowId | null>(null);
  const shown = open ?? pinned;
  const slope = region.hazards.slope.metrics;

  const rows: { id: RowId; label: string; sub: string; value: number; valueText: string; raw: [string, string][] }[] = [
    ...(['shadow', 'rim', 'texture'] as HazardId[]).map((h: HazardId) => {
      const e = region.hazards[h];
      return {
        id: h as RowId,
        label: HAZARDS[h].short,
        sub: HAZARDS[h].mission,
        value: e.score,
        valueText: LEVEL_LABEL[e.level] ?? e.level,
        raw: Object.entries(e.metrics).map(([k, v]: [string, number]): [string, string] => [metricInfo(k).label, metricInfo(k).fmt(v)]),
      };
    }),
    {
      id: 'slope',
      label: 'Slope',
      sub: 'walking & touchdown',
      value: Math.min(1, slope.slope_p90_deg / 35),
      valueText: `${slope.slope_p90_deg.toFixed(0)}° P90`,
      raw: [
        ['Median slope', `${slope.slope_p50_deg.toFixed(1)}°`],
        ['Slope, 90th percentile', `${slope.slope_p90_deg.toFixed(1)}°`],
        ...Object.entries(slope.rms_dev_m).map(([k, v]: [string, number]): [string, string] => [`RMS height change over ${k} m`, `${Number(v).toFixed(1)} m`]),
      ],
    },
  ];

  return (
    <div>
      <div className="label" style={{ marginBottom: 6 }}>
        Danger profile <span className="faint" style={{ textTransform: 'none', letterSpacing: 0 }}>· bar = rank among the 9 regions; hover for raw values</span>
      </div>
      {rows.map((r) => (
        <div key={r.id}>
          <div
            className="danger-row"
            tabIndex={0}
            role="button"
            aria-expanded={shown === r.id}
            data-open={shown === r.id}
            onMouseEnter={(): void => setOpen(r.id)}
            onMouseLeave={(): void => setOpen(null)}
            onFocus={(): void => setOpen(r.id)}
            onBlur={(): void => setOpen(null)}
            onClick={(): void => setPinned(pinned === r.id ? null : r.id)}
            onKeyDown={(e): void => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setPinned(pinned === r.id ? null : r.id);
              }
            }}
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500 }}>
                <span className="hz-dot" style={{ background: HZ_VAR[r.id] }} aria-hidden="true" />
                {r.label}
              </div>
              <div className="faint" style={{ fontSize: 12, marginLeft: 16 }}>
                {r.sub}
              </div>
            </div>
            <div className="bar-track" aria-hidden="true">
              <div className="bar-fill" style={{ width: `${Math.max(3, r.value * 100)}%`, background: HZ_VAR[r.id] }} />
            </div>
            <div className="num" style={{ fontSize: 13, textAlign: 'right' }}>
              {r.valueText}
            </div>
          </div>
          {shown === r.id && (
            <div style={{ padding: '2px 8px 12px 24px' }}>
              <MetricRows rows={r.raw} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
