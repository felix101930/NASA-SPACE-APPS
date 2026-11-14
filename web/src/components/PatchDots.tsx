// Patchiness strip: the 25 block values (3 km patches of the 15 km square) on the Moon and on Earth,
// on one shared axis, with each whole-square value marked and the Moon's middle 50% (IQR) shaded.
// Data: matches.json lights[].moon_blocks / earth_blocks (pipeline/match/patchiness.py).
import { useMemo, type JSX } from 'react';
import type { HazardId } from '../types/contract';
import '../styles/patchdots.css';

export type Patchiness = 'similar' | 'smoother' | 'patchier';

export interface PatchDotsProps {
  label: string;
  unit: string;
  moonBlocks: number[];
  earthBlocks: number[];
  moonValue: number;
  earthValue: number;
  format?: (v: number) => string;
  /** Colours the Moon dots with the hazard hue; neutral when omitted. */
  hazard?: HazardId;
  /** Verdict from the pipeline (lights[].patchiness); computed from the blocks when omitted. */
  patchiness?: Patchiness | null;
}

interface Dot {
  key: number;
  x: number;
  lane: number;
}

/** Same thresholds as pipeline/match/patchiness.py (illustrative). */
const SIMILAR_LO = 0.67;
const SIMILAR_HI = 1.5;
/** Dots closer than this share of the axis are spread onto separate lanes. */
const COLLIDE = 0.018;
const LANE_PX = 5;
const LANES: readonly number[] = [0, -1, 1, -2, 2];

const NUMBER = new Intl.NumberFormat('en', { maximumSignificantDigits: 3 });

function defaultFormat(v: number): string {
  return NUMBER.format(v);
}

function withUnit(text: string, unit: string): string {
  if (!unit) return text;
  return unit === '%' || unit === '°' ? `${text}${unit}` : `${text} ${unit}`;
}

function finiteOnly(v: number[]): number[] {
  return v.filter((x: number): boolean => Number.isFinite(x));
}

/** Linear-interpolated percentile (numpy default), p in 0..100. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = ((sorted.length - 1) * p) / 100;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function iqrOf(values: number[]): [number, number] {
  const s = [...values].sort((a: number, b: number): number => a - b);
  return [percentile(s, 25), percentile(s, 75)];
}

function classify(earthSpread: number, moonSpread: number): Patchiness {
  if (!(moonSpread > 0)) return earthSpread > 0 ? 'patchier' : 'similar';
  const r = earthSpread / moonSpread;
  if (r < SIMILAR_LO) return 'smoother';
  return r > SIMILAR_HI ? 'patchier' : 'similar';
}

const VERDICT_TEXT: Record<Patchiness, string> = {
  similar: 'similar variation',
  smoother: 'Earth varies less',
  patchier: 'Earth varies more',
};

/** Axis domain over every value shown, padded; never zero-width. */
function domainOf(values: number[]): [number, number] {
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (hi - lo < 1e-12) {
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) * 0.05 : 1;
    lo -= pad;
    hi += pad;
  }
  const pad = (hi - lo) * 0.04;
  return [lo - pad, hi + pad];
}

/** Fraction 0..1 along the axis. */
function scaler(domain: [number, number]): (v: number) => number {
  const [lo, hi] = domain;
  return (v: number): number => Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
}

/** Simple 1-D swarm: walk the sorted dots and move a dot to the first lane that is free near it. */
function layoutDots(values: number[], x: (v: number) => number): Dot[] {
  const order = values.map((v: number, i: number): Dot => ({ key: i, x: x(v), lane: 0 }));
  order.sort((a: Dot, b: Dot): number => a.x - b.x);
  const lastX = new Map<number, number>();
  for (const d of order) {
    const free = LANES.find((ln: number): boolean => {
      const prev = lastX.get(ln);
      return prev === undefined || d.x - prev >= COLLIDE;
    });
    d.lane = free ?? 0;
    lastX.set(d.lane, d.x);
  }
  return order;
}

interface View {
  domain: [number, number];
  x: (v: number) => number;
  moonDots: Dot[];
  earthDots: Dot[];
  moonIqr: [number, number] | null;
  verdict: Patchiness | null;
  moonRange: readonly [number, number] | null;
  earthRange: readonly [number, number] | null;
}

function pct(f: number): string {
  return `${(f * 100).toFixed(2)}%`;
}

export function PatchDots({
  label,
  unit,
  moonBlocks,
  earthBlocks,
  moonValue,
  earthValue,
  format = defaultFormat,
  hazard,
  patchiness,
}: PatchDotsProps): JSX.Element {
  const view = useMemo((): View => {
    const moon = finiteOnly(moonBlocks);
    const earth = finiteOnly(earthBlocks);
    const wholes = [moonValue, earthValue].filter((v: number): boolean => Number.isFinite(v));
    const domain = domainOf([...moon, ...earth, ...wholes]);
    const x = scaler(domain);
    const moonIqr = moon.length >= 4 ? iqrOf(moon) : null;
    const earthIqr = earth.length >= 4 ? iqrOf(earth) : null;
    const verdict: Patchiness | null =
      patchiness ?? (moonIqr && earthIqr ? classify(earthIqr[1] - earthIqr[0], moonIqr[1] - moonIqr[0]) : null);
    return {
      domain,
      x,
      moonDots: layoutDots(moon, x),
      earthDots: layoutDots(earth, x),
      moonIqr,
      verdict,
      moonRange: moon.length ? ([Math.min(...moon), Math.max(...moon)] as const) : null,
      earthRange: earth.length ? ([Math.min(...earth), Math.max(...earth)] as const) : null,
    };
  }, [moonBlocks, earthBlocks, moonValue, earthValue, patchiness]);

  const fmtU = (v: number): string => withUnit(format(v), unit);
  const span = (r: readonly [number, number] | null): string =>
    r ? withUnit(`${format(r[0])}–${format(r[1])}`, unit) : 'unavailable';
  const aria =
    `${label}: Earth's patches span ${span(view.earthRange)}, Moon's ${span(view.moonRange)}` +
    (view.verdict ? `; ${VERDICT_TEXT[view.verdict]}.` : '.');

  const band = view.moonIqr ? { left: view.x(view.moonIqr[0]), right: view.x(view.moonIqr[1]) } : null;
  const hzClass = hazard ? ` patchdots--${hazard}` : '';

  const row = (who: 'moon' | 'earth', dots: Dot[], whole: number): JSX.Element => (
    <div className={`patchdots__row patchdots__row--${who}`}>
      <span className="patchdots__rowname">{who === 'moon' ? "Moon's 25 patches" : "Earth's 25 patches"}</span>
      <div className="patchdots__track">
        {band && (
          <span
            className="patchdots__band"
            style={{ left: pct(band.left), width: pct(Math.max(band.right - band.left, 0.002)) }}
          />
        )}
        {dots.map(
          (d: Dot): JSX.Element => (
            <span
              key={d.key}
              className="patchdots__dot"
              style={{ left: pct(d.x), transform: `translate(-50%, calc(-50% + ${d.lane * LANE_PX}px))` }}
            />
          ),
        )}
        {Number.isFinite(whole) && <span className="patchdots__whole" style={{ left: pct(view.x(whole)) }} />}
      </div>
    </div>
  );

  return (
    <figure className={`patchdots${hzClass}`} role="img" aria-label={aria}>
      <figcaption className="patchdots__head" aria-hidden="true">
        <span className="patchdots__label">{label}</span>
        <span className="patchdots__key">
          <span className="patchdots__key-whole" /> whole square
          <span className="patchdots__key-band" /> Moon middle 50%
          {view.verdict && <strong className="patchdots__verdict">{VERDICT_TEXT[view.verdict]}</strong>}
        </span>
      </figcaption>
      <div className="patchdots__plot" aria-hidden="true">
        {row('moon', view.moonDots, moonValue)}
        {row('earth', view.earthDots, earthValue)}
        <div className="patchdots__axis">
          <span />
          <span className="patchdots__ends">
            <span>{fmtU(view.domain[0])}</span>
            <span>{fmtU(view.domain[1])}</span>
          </span>
        </div>
      </div>
    </figure>
  );
}
