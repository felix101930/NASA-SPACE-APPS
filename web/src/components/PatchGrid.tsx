// "25 patches": a 15 km square drawn as its 5 × 5 patches of 3 km, each coloured by its value on a scale shared
// with the other world, so colours compare directly. Cells outside the Moon's typical range (the middle half of
// its patches) can be ringed. Block order: row-major from the tile's top-left (lib/patchScale.ts).
import { useState, type JSX, type KeyboardEvent } from 'react';
import type { HazardId } from '../types/contract';
import {
  fmtPatch,
  fmtPatchRange,
  luminance,
  PATCH_N,
  patchColor,
  placeInRange,
  patchRGB,
  scaleT,
  type PatchUnit,
} from '../lib/patchScale';
import '../styles/patchgrid.css';

export interface PatchGridProps {
  /** 25 values, row-major from the tile's top-left; NaN = no data. */
  values: number[];
  unit: PatchUnit;
  /** Moon's typical range (p25–p75 of its patches). */
  range?: [number, number];
  /** Colour scale, shared between the Moon and Earth grids. */
  scaleMin: number;
  scaleMax: number;
  label: string;
  /** Ring the cells outside `range`. */
  highlightOutside?: boolean;
  size?: 'sm' | 'md';
  /** Ramp hue; neutral when omitted. */
  hazard?: HazardId;
  /** What "up" is on this tile, e.g. "north" or "grid up". */
  up?: string;
}

const INK_DARK = '#14100a';
const INK_LIGHT = '#edeae4';
const ARROWS: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };

function isOutside(v: number, range: [number, number] | undefined, unit: PatchUnit): boolean {
  return range !== undefined && Number.isFinite(v) && placeInRange(v, range, unit) !== 'inside';
}

function cellName(k: number): string {
  return `row ${Math.floor(k / PATCH_N) + 1}, column ${(k % PATCH_N) + 1}`;
}

export function PatchGrid({
  values,
  unit,
  range,
  scaleMin,
  scaleMax,
  label,
  highlightOutside = false,
  size = 'sm',
  hazard,
  up,
}: PatchGridProps): JSX.Element {
  const [active, setActive] = useState<number | null>(null);
  const finite = values.filter(Number.isFinite);
  const nOut = values.filter((v: number): boolean => isOutside(v, range, unit)).length;
  const lo = finite.length ? Math.min(...finite) : Number.NaN;
  const hi = finite.length ? Math.max(...finite) : Number.NaN;
  const summary =
    `${label}: 25 patches of 3 km, from ${fmtPatch(lo, unit)} to ${fmtPatch(hi, unit)}` +
    (range ? `; ${nOut} of 25 outside the Moon’s typical ${fmtPatchRange(range, unit)}.` : '.');

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const d = ARROWS[e.key];
    if (!d) return;
    e.preventDefault();
    const k = active ?? 0;
    const r = Math.min(PATCH_N - 1, Math.max(0, Math.floor(k / PATCH_N) + d[0]));
    const c = Math.min(PATCH_N - 1, Math.max(0, (k % PATCH_N) + d[1]));
    setActive(active === null ? 0 : r * PATCH_N + c);
  };

  const activeV = active !== null ? values[active] : Number.NaN;
  const md = size === 'md';
  return (
    <figure className={`pgrid pgrid--${size}`}>
      <figcaption className="pgrid__label" title={label}>
        {label}
      </figcaption>
      <div
        className="pgrid__cells"
        role="img"
        aria-label={summary}
        tabIndex={0}
        onKeyDown={onKey}
        onFocus={(): void => setActive((a: number | null): number => a ?? 0)}
        onBlur={(): void => setActive(null)}
        onMouseLeave={(): void => setActive(null)}
      >
        {values.map((v: number, k: number) => {
          const ok = Number.isFinite(v);
          const rgb = patchRGB(scaleT(v, scaleMin, scaleMax), hazard);
          return (
            <span
              key={k}
              className="pgrid__cell"
              data-out={(highlightOutside && isOutside(v, range, unit)) || undefined}
              data-active={active === k || undefined}
              data-empty={!ok || undefined}
              style={ok ? { background: patchColor(scaleT(v, scaleMin, scaleMax), hazard), color: luminance(rgb) > 0.32 ? INK_DARK : INK_LIGHT } : undefined}
              onMouseEnter={(): void => setActive(k)}
            >
              {md && ok ? fmtPatch(v, unit, true) : null}
            </span>
          );
        })}
      </div>
      <div className="pgrid__foot" aria-hidden="true">
        {up && <span className="pgrid__up">↑ {up}</span>}
        <span className="pgrid__read">{active !== null ? `${cellName(active)}: ${fmtPatch(activeV, unit)}` : ''}</span>
      </div>
      <table className="sr-only">
        <caption>{label}, 25 patches of 3 km (rows top to bottom, columns left to right)</caption>
        <tbody>
          {Array.from({ length: PATCH_N }, (_: unknown, r: number) => (
            <tr key={r}>
              {values.slice(r * PATCH_N, (r + 1) * PATCH_N).map((v: number, c: number) => (
                <td key={c}>
                  {fmtPatch(v, unit)}
                  {isOutside(v, range, unit) ? ' (outside typical)' : ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** The shared scale: low → high ramp with its end values, and the ring key when cells are ringed. */
export function PatchLegend({
  scaleMin,
  scaleMax,
  unit,
  hazard,
  ringed = false,
}: {
  scaleMin: number;
  scaleMax: number;
  unit: PatchUnit;
  hazard?: HazardId;
  ringed?: boolean;
}): JSX.Element {
  const stops = [0, 0.25, 0.5, 0.75, 1].map((t: number): string => `${patchColor(t, hazard)} ${t * 100}%`).join(', ');
  return (
    <span className="pgrid-legend">
      <span className="pgrid-legend__end">{fmtPatch(scaleMin, unit)}</span>
      <span className="pgrid-legend__ramp" style={{ background: `linear-gradient(90deg, ${stops})` }} aria-hidden="true" />
      <span className="pgrid-legend__end">{fmtPatch(scaleMax, unit)}</span>
      {ringed && (
        <span className="pgrid-legend__ring">
          <span className="pgrid-legend__swatch" aria-hidden="true" />
          outside the Moon’s typical
        </span>
      )}
    </span>
  );
}
