// Step 2: ready-made routes first, drawing your own second, with a live height profile of the route.
import { useMemo, type JSX } from 'react';
import type { LoadedTile } from '../../data/tiles';
import { sampleProfile, type WalkProfile } from '../../lib/terrain';
import type { Region } from '../../types/contract';
import { InfoTip } from '../../components/InfoTip';
import { Why } from '../../components/Term';
import { Loading } from '../../components/Loading';
import { MoonPad } from './MoonPad';
import { MoonProfile } from './ProfileChart';
import { type ReadyRoute } from './routes';

type XY = [number, number];

interface RouteChooserProps {
  region: Region;
  tile: LoadedTile | null;
  ready: ReadyRoute[];
  activeId: string | null;
  route: XY[];
  drawing: boolean;
  hover: XY | null;
  live: WalkProfile | null;
  /** Moon height error (m) shown beside the route numbers. */
  demErrM: number;
  busy: boolean;
  dataReady: boolean;
  stretch: boolean;
  searchBlock: string | null;
  problem: string | null;
  canSearch: boolean;
  onPick: (r: ReadyRoute) => void;
  onDraw: () => void;
  onCanvasClick: (xy: XY) => void;
  onHover: (xy: XY | null) => void;
  onUndo: () => void;
  onClear: () => void;
  onSearch: () => void;
  onStretch: (v: boolean) => void;
}

/** Tiny height silhouette of a route: the shape of the walk, not a decoration. */
function Silhouette({ heights }: { heights: number[] }): JSX.Element {
  const W = 120;
  const H = 32;
  const lo = Math.min(...heights);
  const hi = Math.max(...heights);
  const span = Math.max(hi - lo, 1);
  const pts = heights.map((h: number, i: number): string => `${((i / (heights.length - 1)) * W).toFixed(1)},${(H - 2 - ((h - lo) / span) * (H - 4)).toFixed(1)}`);
  return (
    <svg className="wk-sil" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" preserveAspectRatio="none">
      <polygon points={`0,${H} ${pts.join(' ')} ${W},${H}`} className="wk-sil-fill" />
      <polyline points={pts.join(' ')} className="wk-sil-line" />
    </svg>
  );
}

export function RouteChooser(props: RouteChooserProps): JSX.Element {
  const { region, tile, ready, activeId, route, drawing, hover, live, busy, dataReady, stretch, searchBlock, problem, canSearch } = props;

  const readyProfiles = useMemo((): Map<string, WalkProfile> => {
    const m = new Map<string, WalkProfile>();
    if (!tile) return m;
    for (const r of ready) {
      const p = sampleProfile(tile.raw, tile.ref.origin_x, tile.ref.origin_y, r.moon_xy, 100);
      if (p && !p.hasNaN) m.set(r.id, p);
    }
    return m;
  }, [ready, tile]);

  const hint = !drawing
    ? ''
    : route.length === 0
      ? 'Click to place the start.'
      : route.length === 1
        ? 'Click to place the next point.'
        : 'Click to add turns, then search.';

  return (
    <section className="wk-moon" aria-labelledby="wk-route-title">
      <div className="wk-col-head">
        <h2 id="wk-route-title">Routes</h2>
      </div>

      {ready.length > 0 ? (
        <div className="wk-ready" role="group" aria-label="Ready-made routes">
          {ready.map((r: ReadyRoute) => {
            const p = readyProfiles.get(r.id);
            return (
              <button
                key={r.id}
                type="button"
                className="wk-route-card"
                title={r.blurb}
                aria-pressed={!drawing && activeId === r.id}
                disabled={!dataReady || busy}
                onClick={(): void => props.onPick(r)}
              >
                <span className="wk-route-name">{r.name}</span>
                {p && (
                  <span className="wk-route-foot">
                    <Silhouette heights={p.heights} />
                    <span className="wk-route-stats" title="Climb (m) · steepest slope (°)">
                      {Math.round(p.climb_m)} m · {Math.round(p.max_slope_deg)}°
                    </span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="wk-ready wk-ready-loading" aria-busy="true">
          <span className="caption">Finding routes on the terrain…</span>
        </div>
      )}

      <div className="wk-draw-row">
        <button type="button" className="btn" aria-pressed={drawing} onClick={props.onDraw} disabled={!tile}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 13.5l3-1 7.5-7.5-2-2L3 10.5l-1 3z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
          {drawing ? 'Drawing your own' : 'Draw your own'}
        </button>
        {drawing && (
          <>
            <button type="button" className="btn" disabled={route.length === 0} onClick={props.onUndo}>
              Undo point
            </button>
            <button type="button" className="btn" disabled={route.length === 0} onClick={props.onClear}>
              Start over
            </button>
          </>
        )}
        {(drawing || canSearch) && (
          <button type="button" className="btn btn-primary wk-search" disabled={searchBlock !== null || busy} onClick={props.onSearch}>
            {busy ? 'Searching…' : 'Find its Earth twin'}
          </button>
        )}
      </div>
      <p className="caption wk-hint" aria-live="polite" hidden={!drawing && !hint}>
        {hint}
        {(drawing || canSearch) && searchBlock && !busy ? ` · ${searchBlock}` : ''}
      </p>

      <div className="wk-pad" data-drawing={drawing}>
        {tile ? (
          <MoonPad
            region={region}
            tile={tile}
            route={route}
            drawing={drawing}
            hover={hover}
            onAdd={props.onCanvasClick}
            onHover={props.onHover}
          />
        ) : (
          <Loading label="Loading Moon terrain…" />
        )}
      </div>

      <div className="wk-live" aria-live="polite">
        {live ? (
          <>
            <div className="wk-live-sum why-row">
              <span className="caption">Moon elevation error</span>
              <InfoTip label="How exact are the Moon values?" title="Moon elevation error">
                <p>
                  Heights ±{props.demErrM.toFixed(1)} m, slopes ±1.5–2.5° (NASA LOLA elevation data).
                </p>
              </InfoTip>
            </div>
            <MoonProfile heights={live.heights} lengthM={live.length_m} />
          </>
        ) : (
          <p className="caption wk-live-empty">{drawing ? 'Profile appears as you draw.' : 'Pick a route to see its profile.'}</p>
        )}
      </div>

      {problem && (
        <div className="error-box" role="alert">
          {problem}
        </div>
      )}

      <details className="method wk-more">
        <summary>More options</summary>
        <div className="method-body">
          <div className="why-row">
            <label className="check">
              <input type="checkbox" checked={stretch} onChange={(e): void => props.onStretch(e.target.checked)} />
              Tolerate stretched routes (slower)
            </label>
            <Why id="walkMatcher" />
          </div>
        </div>
      </details>
    </section>
  );
}
