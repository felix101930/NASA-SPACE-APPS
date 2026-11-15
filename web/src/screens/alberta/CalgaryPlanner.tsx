// "Find a Moon walk near you": pick a neighbourhood (map click, a pin or the Select) and get its nearest suitable route,
// the Moon route it copies (side by side), and the bus or train stop it starts from.
import { useMemo, type JSX } from 'react';
import { InfoTip } from '../../components/InfoTip';
import { Select, type SelectOption } from '../../components/Select';
import type { CalgaryPreset, CalgaryWalk, OverlaysGeo } from '../../types/alberta';
import { MoonTwin } from './MoonTwin';
import { minutesWalk, publicRoutes, routeNumber, titleCase, WALK_M_PER_MIN, type PlannerIndex, type PlanOption } from './planner';
import { accessPhrase } from './shared';

const NONE = '';

export function placeOf(w: CalgaryWalk): string {
  const park = w.park?.split(';')[0].trim();
  if (park) return park;
  const c = w.tract?.communities?.split(',')[0]?.trim();
  return c ? `Pathway in ${titleCase(c)}` : w.id;
}

/** One option per (community, tract); a community split across tracts is numbered so every label is unique. */
export function neighbourhoodOptions(overlays: OverlaysGeo, reached: Set<string> | null): SelectOption<string>[] {
  const rows: { name: string; ctuid: string; category: string | null }[] = [];
  for (const f of overlays.features) {
    const p = f.properties;
    const names = p.communities
      .split(',')
      .map((s: string): string => s.trim())
      .filter((s: string): boolean => s.length > 0 && !/^\d{2}[A-Z]$/.test(s))
      .map(titleCase);
    const category = typeof p.access_category === 'string' ? p.access_category : null;
    if (!names.length) rows.push({ name: `Census tract ${p.name}`, ctuid: p.ctuid, category });
    names.forEach((name: string): void => {
      rows.push({ name, ctuid: p.ctuid, category });
    });
  }
  rows.sort((a, b): number => a.name.localeCompare(b.name) || a.ctuid.localeCompare(b.ctuid));
  const count = new Map<string, number>();
  rows.forEach((r): void => {
    count.set(r.name, (count.get(r.name) ?? 0) + 1);
  });
  const seen = new Map<string, number>();
  const opts: SelectOption<string>[] = [{ value: NONE, label: 'Choose a neighbourhood', disabled: true }];
  rows.forEach((r): void => {
    const n = count.get(r.name) ?? 1;
    const k = (seen.get(r.name) ?? 0) + 1;
    seen.set(r.name, k);
    const status = reached ? (reached.has(r.ctuid) ? ' · Moon walk near a bus stop' : ' · no Moon walk near a stop yet') : '';
    opts.push({
      value: `${r.ctuid}|${r.name}`,
      label: n > 1 ? `${r.name} · area ${k} of ${n}` : r.name,
      hint: `${accessPhrase(r.category)}${status}`,
    });
  });
  return opts;
}

export function ctuidOfOption(value: string): string | null {
  const i = value.indexOf('|');
  return i > 0 ? value.slice(0, i) : null;
}

function NeedChip({ category }: { category: string | null }): JSX.Element | null {
  if (!category) return null;
  return (
    <span className="chip need-chip" data-need={category}>
      <span className="need-swatch" data-need={category} aria-hidden="true" />
      {accessPhrase(category)}
    </span>
  );
}

export interface CalgaryPlannerProps {
  overlays: OverlaysGeo;
  walks: CalgaryWalk[];
  rows: Float32Array;
  pts: number;
  presets: CalgaryPreset[];
  index: PlannerIndex | null;
  selectValue: string;
  onSelect: (value: string) => void;
  ctuid: string | null;
  plan: PlanOption[];
  optionIdx: number;
  onNext: () => void;
  onShow: () => void;
  /** The route is already fully on the map at a useful zoom: the zoom button is not needed. */
  routeInView: boolean;
}

export function CalgaryPlanner(p: CalgaryPlannerProps): JSX.Element {
  const reached = useMemo((): Set<string> | null => (p.index ? new Set(p.index.suitableByTract.keys()) : null), [p.index]);
  const options = useMemo((): SelectOption<string>[] => neighbourhoodOptions(p.overlays, reached), [p.overlays, reached]);
  const tract = p.ctuid ? (p.index?.tracts.get(p.ctuid) ?? null) : null;
  const opt = p.plan[p.optionIdx] ?? null;
  const walk = opt ? p.walks[opt.walkIndex] : null;
  const preset = opt && p.index ? (p.presets[p.index.bestPreset[opt.walkIndex]] ?? null) : null;
  const dtw = opt && p.index ? p.index.bestDtw[opt.walkIndex] : null;
  const earth = useMemo(
    (): number[] | null => (walk ? Array.from(p.rows.subarray(walk.row * p.pts, (walk.row + 1) * p.pts)) : null),
    [walk, p.rows, p.pts],
  );
  const isReached = p.ctuid && reached ? reached.has(p.ctuid) : null;
  const routes = walk ? publicRoutes(walk).map(routeNumber) : [];
  const place = walk ? placeOf(walk) : '';

  return (
    <section className="cg-plan" aria-labelledby="cg-plan-h">
      <div className="cg-h">
        <h3 id="cg-plan-h">Find a Moon walk near you</h3>
        <InfoTip label="What counts as a Moon walk" title="What counts as a Moon walk" align="end">
          <div className="infotip-body">
            <p>
              A City pathway route that <strong>starts within 400 m of an active bus or train stop</strong> and has the same ups and downs as
              one of 18 Moon routes (NASA LOLA): under 1° typical slope mismatch.
            </p>
            <p className="caption">
              Minutes assume {WALK_M_PER_MIN} m per minute (4.8 km/h). Distances are straight-line. Not an accessibility rating.
            </p>
          </div>
        </InfoTip>
      </div>
      <Select className="field" labelClassName="field-label" label="Neighbourhood" value={p.selectValue} options={options} onChange={p.onSelect} />
      {!p.ctuid && <p className="caption cg-plan-hint">Type to search, or tap a pin or a neighbourhood on the map.</p>}
      {p.ctuid && !p.index && (
        <p className="caption" role="status">
          Matching 2,762 routes to the Moon…
        </p>
      )}
      {p.ctuid && p.index && (
        <div className="cg-plan-card" aria-live="polite">
          <div className="cg-plan-head">
            <h4 className="cg-plan-name">{tract?.label ?? p.ctuid}</h4>
            <div className="chip-row">
              <NeedChip category={tract?.category ?? null} />
              {isReached !== null && (
                <span className="chip cg-reach" data-reached={isReached}>
                  {isReached ? 'Has a Moon walk near a bus stop' : 'No Moon walk near a bus stop yet'}
                </span>
              )}
            </div>
          </div>

          {walk && opt && preset && dtw !== null ? (
            <div className="cg-plan-route">
              <p className="cg-plan-where">
                {opt.inTract ? 'Moon walk here' : `Nearest Moon walk · ${(opt.distFromTractM / 1000).toFixed(1)} km away`}
              </p>
              <p className="cg-plan-park">{place}</p>
              <dl className="cg-facts">
                <div>
                  <dt>Length</dt>
                  <dd>{(walk.length_m / 1000).toFixed(1)} km</dd>
                </div>
                <div>
                  <dt>Climb</dt>
                  <dd>{Math.round(walk.climb_m)} m</dd>
                </div>
                {walk.near_stop && (
                  <div>
                    <dt>Walk from stop</dt>
                    <dd>
                      {Math.round(walk.near_stop.dist_m)} m · {minutesWalk(walk.near_stop.dist_m)} min
                    </dd>
                  </div>
                )}
              </dl>
              {walk.near_stop && (
                <p className="cg-plan-stop">
                  <span className="muted">Stop</span> {walk.near_stop.name}
                  {routes.length > 0 && (
                    <span className="cg-routes" aria-label={`Routes ${routes.join(', ')}`}>
                      {routes.map((r: string) => (
                        <span key={r} className="cg-route">
                          {r}
                        </span>
                      ))}
                    </span>
                  )}
                </p>
              )}
              <div className="cg-plan-actions">
                <button
                  type="button"
                  className="btn btn-primary cg-zoom-btn"
                  aria-disabled={p.routeInView}
                  onClick={(): void => {
                    if (!p.routeInView) p.onShow();
                  }}
                >
                  {p.routeInView ? 'Route in view on the map' : 'Zoom to this route'}
                </button>
                {p.plan.length > 1 && (
                  <button type="button" className="btn" onClick={p.onNext}>
                    Next route <span className="muted">· {p.optionIdx + 1} of {p.plan.length}</span>
                  </button>
                )}
              </div>
              <div className="cg-plan-moon">
                <span>
                  Copies a Moon route on <strong>{preset.region_name}</strong>
                </span>
                <InfoTip label="How close is the match?" title="How close is the match?" align="end">
                  <div className="infotip-body">
                    <p>
                      Typical slope mismatch <strong>{dtw.toFixed(2)}°</strong> against the Moon’s {preset.region_name} {preset.kind} route (
                      {(preset.length_m / 1000).toFixed(1)} km).
                    </p>
                    <p>The ups and downs match at about 20–30 m scale. Steep Moon routes have no city equivalent.</p>
                  </div>
                </InfoTip>
              </div>
              <MoonTwin preset={preset} walk={walk} walks={p.walks} earth={earth} place={place} />
            </div>
          ) : (
            <p className="muted">No suitable route found in our sample.</p>
          )}
        </div>
      )}
    </section>
  );
}
