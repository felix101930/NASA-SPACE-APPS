// Profile charts for the walk screen: the Moon route on its own (live while drawing) and Moon vs Earth twin.
import { useMemo, useState, type JSX } from 'react';
import { Area, AreaChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

const GRID = '#2c3038';
const AXIS = '#8e8a83';
const TOOLTIP = { background: '#1a1d23', border: '1px solid #3d424c', borderRadius: 6, color: '#edeae4', fontSize: 12 };

/** Heights rebased so the walk starts at 0 m. */
function fromStart(h: ArrayLike<number>): number[] {
  const out: number[] = [];
  const h0 = h[0] ?? 0;
  for (let i = 0; i < h.length; i++) out.push(h[i] - h0);
  return out;
}

interface MoonRow {
  km: number;
  h: number;
}

/** Height of the Moon route above its start, against distance walked. */
export function MoonProfile({ heights, lengthM }: { heights: number[]; lengthM: number }): JSX.Element {
  const data = useMemo((): MoonRow[] => {
    const h = fromStart(heights);
    const n = h.length;
    return h.map((v: number, i: number): MoonRow => ({ km: Number(((lengthM * i) / Math.max(n - 1, 1) / 1000).toFixed(3)), h: Math.round(v * 10) / 10 }));
  }, [heights, lengthM]);
  return (
    <div className="wk-moon-chart" aria-label="Height along the Moon route">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="km"
            type="number"
            domain={[0, 'dataMax']}
            stroke={AXIS}
            tick={{ fontSize: 12 }}
            tickFormatter={(v: number): string => `${v.toFixed(v < 1 && v > 0 ? 1 : 0)}`}
            unit=" km"
            tickCount={5}
          />
          <YAxis stroke={AXIS} tick={{ fontSize: 12 }} unit=" m" width={56} />
          <ReferenceLine y={0} stroke="#3d424c" />
          <Tooltip
            contentStyle={TOOLTIP}
            labelFormatter={(v): string => `${Number(v).toFixed(2)} km along`}
            formatter={(v): [string, string] => [`${Number(v).toFixed(0)} m`, 'Height above start']}
          />
          <Area type="monotone" dataKey="h" stroke="#edeae4" strokeWidth={2} fill="#edeae4" fillOpacity={0.1} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

type Mode = 'height' | 'slope';

interface TwinRow {
  t: number;
  moon: number;
  earth: number;
}

interface TwinProps {
  moonHeights: ArrayLike<number>;
  earthHeights: ArrayLike<number>;
  moonSlopes: ArrayLike<number>;
  earthSlopes: ArrayLike<number>;
  moonLabel: string;
  earthLabel: string;
}

const TICKS = [0, 50, 100];
const TICK_WORD: Record<number, string> = { 0: 'Start', 50: 'Halfway', 100: 'End' };

/** Moon route (solid) over the Earth twin (dashed), as height or slope along the walk. */
export function TwinChart({ moonHeights, earthHeights, moonSlopes, earthSlopes, moonLabel, earthLabel }: TwinProps): JSX.Element {
  const [mode, setMode] = useState<Mode>('height');
  const data = useMemo((): TwinRow[] => {
    const a = mode === 'height' ? fromStart(moonHeights) : Array.from(moonSlopes);
    const b = mode === 'height' ? fromStart(earthHeights) : Array.from(earthSlopes);
    const n = Math.min(a.length, b.length);
    const rows: TwinRow[] = [];
    for (let i = 0; i < n; i++) rows.push({ t: (i / Math.max(n - 1, 1)) * 100, moon: Math.round(a[i] * 10) / 10, earth: Math.round(b[i] * 10) / 10 });
    return rows;
  }, [mode, moonHeights, earthHeights, moonSlopes, earthSlopes]);
  const unit = mode === 'height' ? ' m' : '°';
  return (
    <div className="wk-twin-chart">
      <div className="wk-chart-head">
        <div className="wk-legend" aria-hidden="true">
          <span className="legend-item">
            <span className="legend-line" />
            {moonLabel}
          </span>
          <span className="legend-item">
            <span className="legend-line legend-line-dashed" />
            {earthLabel}
          </span>
        </div>
        <div className="seg seg-sm" role="group" aria-label="Profile to compare">
          <button type="button" aria-pressed={mode === 'height'} onClick={(): void => setMode('height')}>
            Height
          </button>
          <button type="button" aria-pressed={mode === 'slope'} onClick={(): void => setMode('slope')}>
            Slope
          </button>
        </div>
      </div>
      <p className="caption">{mode === 'height' ? 'Height above the start of each walk, in metres' : 'Slope underfoot in degrees; above 0 is uphill'}</p>
      <div className="wk-twin-box" role="img" aria-label={`${mode === 'height' ? 'Height' : 'Slope'} along the walk: ${moonLabel} against ${earthLabel}`}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              domain={[0, 100]}
              ticks={TICKS}
              stroke={AXIS}
              tick={{ fontSize: 12 }}
              tickFormatter={(v: number): string => TICK_WORD[v] ?? ''}
            />
            <YAxis stroke={AXIS} tick={{ fontSize: 12 }} unit={unit} width={60} />
            <ReferenceLine y={0} stroke="#3d424c" />
            <Tooltip
              contentStyle={TOOLTIP}
              labelFormatter={(v): string => `${Math.round(Number(v))}% of the way`}
              formatter={(v, name): [string, string] => [`${Number(v).toFixed(mode === 'height' ? 0 : 1)}${unit}`, String(name)]}
            />
            <Line type="monotone" dataKey="moon" name={moonLabel} stroke="#edeae4" strokeWidth={2.5} dot={false} isAnimationActive={false} />
            <Line
              type="monotone"
              dataKey="earth"
              name={earthLabel}
              stroke="#b9b5ae"
              strokeDasharray="6 4"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
