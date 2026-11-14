// "Plan a Moon walk near you": pick a neighbourhood (map click or the Select) and get its nearest suitable route,
// the Moon region it climbs like, and the bus or train stop it starts from.
import { useMemo, type JSX } from 'react';
import { InfoTip } from '../../components/InfoTip';
import { Select, type SelectOption } from '../../components/Select';
import { SlopeChart } from '../../components/SlopeChart';
import type { CalgaryPreset, CalgaryWalk, EquityEvent, OverlaysGeo } from '../../types/alberta';
import { minutesWalk, publicRoutes, routeNumber, titleCase, WALK_M_PER_MIN, type PlannerIndex, type PlanOption } from './planner';

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
    const status = reached ? (reached.has(r.ctuid) ? ' · reached' : ' · not yet reached') : '';
    opts.push({
      value: `${r.ctuid}|${r.name}`,
      label: n > 1 ? `${r.name} · area ${k} of ${n}` : r.name,
      hint: `${r.category ?? 'Unrecorded'} need${status}`,
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
      {category} need
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
  topEvents: EquityEvent[];
  selectValue: string;
  onSelect: (value: string) => void;
  onEvent: (rank: number) => void;
  ctuid: string | null;
  plan: PlanOption[];
  optionIdx: number;
  onNext: () => void;
  onShow: () => void;
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
        <h3 id="cg-plan-h">Plan a Moon walk near you</h3>
        <InfoTip label="What counts as a Moon walk" title="What counts as a Moon walk" align="end">
          <div className="infotip-body">
            <p>
              A City pathway route that <strong>starts within 400 m of an active bus or train stop</strong> and whose slope profile matches one of 18
              Moon routes (NASA LOLA) with under 1° typical mismatch.
            </p>
            <p>
              Need comes from the <strong>Calgary Equity Index 2024</strong> (access to amenities; higher = greater need). We use it to prioritise
              free outreach, not to rank neighbourhoods.
            </p>
            <p className="caption">
              Minutes assume {WALK_M_PER_MIN} m per minute (4.8 km/h). Distances are straight-line. Not an accessibility rating.
            </p>
          </div>
        </InfoTip>
      </div>
      <Select
        className="field"
        labelClassName="field-label"
        label="Neighbourhood"
        value={p.selectValue}
        options={options}
        onChange={p.onSelect}
      />
      {!p.ctuid && (
        <div className="cg-plan-empty">
          <p className="caption">Type to search, or tap the map. Or start with a top spot:</p>
          <div className="chip-row">
            {p.topEvents.map((e: EquityEvent) => (
              <button key={e.rank} type="button" className="chip chip-button" onClick={(): void => p.onEvent(e.rank)}>
                <span className="cg-chip-n" aria-hidden="true">
                  {e.rank}
                </span>
                {e.communities || e.place}
              </button>
            ))}
          </div>
        </div>
      )}
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
                  {isReached ? 'Reached' : 'Not yet reached'}
                </span>
              )}
            </div>
            <p className="caption">Need for access to amenities (Calgary Equity Index 2024)</p>
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
              <div className="cg-plan-moon">
                <span>
                  Climbs like <strong>{preset.region_name}</strong> <span className="muted">· Moon, {preset.kind} route</span>
                </span>
                <InfoTip label="How close is the match?" title="How close is the match?" align="end">
                  <div className="infotip-body">
                    <p>
                      Typical slope mismatch <strong>{dtw.toFixed(2)}°</strong> against the Moon’s {preset.region_name} {preset.kind} route (
                      {(preset.length_m / 1000).toFixed(1)} km).
                    </p>
                    <p>The slope profile matches at about 20–30 m scale. Steep Moon routes have no city equivalent.</p>
                  </div>
                </InfoTip>
              </div>
              <SlopeChart
                title="Slope along the route"
                moon={preset.slope_deg}
                earth={earth}
                moonLabel={`Moon · ${preset.region_name}`}
                earthLabel={`Calgary · ${place}`}
              />
              <div className="cg-plan-actions">
                <button type="button" className="btn btn-primary" onClick={p.onShow}>
                  Show on map
                </button>
                {p.plan.length > 1 && (
                  <button type="button" className="btn" onClick={p.onNext}>
                    Next route <span className="muted">· {p.optionIdx + 1} of {p.plan.length}</span>
                  </button>
                )}
              </div>
            </div>
          ) : (
            <p className="muted">No suitable route found in our sample.</p>
          )}
        </div>
      )}
    </section>
  );
}
