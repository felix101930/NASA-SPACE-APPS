// Slope profile overlay (Moon solid, Earth dashed), shared by the Walk and Calgary screens.
import { useMemo, type JSX } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

interface Row {
  pct: number;
  moon: number;
  earth: number | null;
}

interface SlopeChartProps {
  title: string;
  moon: number[];
  earth: number[] | null;
  moonLabel: string;
  earthLabel: string | null;
}

export function SlopeChart({ title, moon, earth, moonLabel, earthLabel }: SlopeChartProps): JSX.Element {
  const data = useMemo((): Row[] => {
    const n = moon.length;
    return moon.map((v: number, i: number): Row => ({
      pct: Math.round((i / Math.max(n - 1, 1)) * 100),
      moon: Number(v.toFixed(2)),
      earth: earth && Number.isFinite(earth[i]) ? Number(earth[i].toFixed(2)) : null,
    }));
  }, [moon, earth]);
  return (
    <div>
      <div className="chart-head">
        <h3>{title}</h3>
        <span className="chart-legend">
          <span className="legend-item">
            <span className="legend-line" aria-hidden="true" />
            {moonLabel}
          </span>
          {earthLabel && (
            <span className="legend-item">
              <span className="legend-line legend-line-dashed" aria-hidden="true" />
              {earthLabel}
            </span>
          )}
        </span>
      </div>
      <div className="chart-box">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
            <CartesianGrid stroke="#2c3038" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="pct"
              type="number"
              domain={[0, 100]}
              ticks={[0, 25, 50, 75, 100]}
              stroke="#8e8a83"
              tick={{ fontSize: 12 }}
              unit="%"
            />
            <YAxis stroke="#8e8a83" tick={{ fontSize: 12 }} unit="°" />
            <ReferenceLine y={0} stroke="#3d424c" />
            <Tooltip
              contentStyle={{ background: '#1a1d23', border: '1px solid #3d424c', borderRadius: 6, color: '#edeae4' }}
              labelFormatter={(v): string => `${String(v)}% along the walk`}
            />
            <Line
              type="monotone"
              dataKey="moon"
              name={moonLabel}
              stroke="#edeae4"
              strokeWidth={2.5}
              dot={false}
              isAnimationActive={false}
            />
            {earth && (
              <Line
                type="monotone"
                dataKey="earth"
                name={earthLabel ?? 'Earth'}
                stroke="#b9b5ae"
                strokeDasharray="6 4"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
