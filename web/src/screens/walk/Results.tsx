// Step 3: the Earth twin. How close it is, both profiles, where it is, and the runners-up.
import { useMemo, type JSX } from 'react';
import { Loading } from '../../components/Loading';
import { FitGlyph } from '../../components/Glyphs';
import type { WalkProfile } from '../../lib/terrain';
import { heightsFromSlopes } from '../../lib/match';
import type { Region, TransectItem } from '../../types/contract';
import type { ResultRow } from '../../workers/dtw.worker';
import { matchQuality, type Findback } from './findback';
import { fmtKm, fmtLatLon, headingWord, placeLabel, type SiteInfo } from './place';
import { TwinChart } from './ProfileChart';
import { TwinMap, type TwinPath } from './TwinMap';

export interface Found {
  row: ResultRow;
  /** Transect as walked in the matched direction (start = lat0/lon0). */
  item: TransectItem;
  slopes: number[];
  heights: number[];
  /** Climb in the matched direction (m). */
  climb: number;
  /** RMS differences to the Moon walk, in the matched direction. */
  rmsHeight: number;
  rmsSlope: number;
}

interface ResultsProps {
  region: Region;
  data: { sites: Map<string, SiteInfo>; n: number; findback: Findback | null } | null;
  dataErr: string | null;
  busy: boolean;
  stale: boolean;
  query: WalkProfile | null;
  searchedLabel: string;
  matcher: 'height_slope' | 'dtw';
  found: Found[];
  sel: number;
  onSel: (i: number) => void;
  note: string;
  in3d: boolean;
  onWalk3d: () => void;
  onCalgary: () => void;
}

const nf = new Intl.NumberFormat('en-US');

export function Results(props: ResultsProps): JSX.Element {
  const { region, data, dataErr, busy, stale, query, found, sel } = props;
  const current = found[sel] ?? null;
  const place = (id: string): ReturnType<typeof placeLabel> => placeLabel(data?.sites.get(id), id);

  const path = useMemo(
    (): TwinPath | null =>
      current
        ? {
            key: `${current.row.i}:${current.row.reversed ? 'r' : 'f'}`,
            start: [current.item.lon0, current.item.lat0],
            end: [current.item.lon1, current.item.lat1],
            label: placeLabel(data?.sites.get(current.item.site_id), current.item.site_id).full,
          }
        : null,
    [current, data],
  );

  const moonHeights = useMemo((): number[] => (query ? Array.from(heightsFromSlopes(query.slopes, query.length_m)) : []), [query]);

  if (dataErr && !data) {
    return (
      <section className="wk-earth">
        <div className="error-box" role="alert">
          The Earth paths could not load ({dataErr}). Reload the page to try again.
        </div>
      </section>
    );
  }
  if (!data || (!current && busy)) {
    return (
      <section className="wk-earth wk-earth-empty" aria-busy="true">
        <Loading label={data ? `Comparing with ${nf.format(data.n)} Earth paths…` : 'Loading 22,000 Earth paths…'} />
      </section>
    );
  }
  if (!current || !query) {
    return (
      <section className="wk-earth wk-earth-empty">
        <div className="wk-empty">
          <h2>Your Earth twin appears here</h2>
          <p className="muted">
            Pick a ready-made route on the left, or draw your own on the terrain and press “Find its Earth twin”. We compare it with {nf.format(data.n)}{' '}
            straight Earth paths and show the one that climbs the same way.
          </p>
        </div>
      </section>
    );
  }

  const fb = data.findback;
  const quality = matchQuality(current.row.dist, props.matcher === 'dtw' ? (fb?.dtwSpread ?? null) : (fb?.euclidSpread ?? null), fb?.nRoutes ?? null);
  const p = place(current.item.site_id);
  const heading = headingWord(current.item.lat0, current.item.lon0, current.item.lat1, current.item.lon1);

  return (
    <section className="wk-earth" aria-labelledby="wk-twin-title" aria-busy={busy} data-dim={busy || stale}>
      {(stale || busy) && (
        <p className="wk-stale" role="status">
          {busy ? 'Searching for a new twin…' : `These results are for “${props.searchedLabel}”. Press “Find its Earth twin” for your new route.`}
        </p>
      )}

      <div className="wk-twin-head">
        <p className="wk-rank">{sel === 0 ? `Best of ${nf.format(data.n)} Earth paths` : `Runner-up ${sel + 1} of ${found.length}`}</p>
        <h2 id="wk-twin-title" title={p.full}>
          {p.full}
        </h2>
        <p className="caption">
          {fmtLatLon(current.item.lat0, current.item.lon0)} · a straight {fmtKm(current.item.length_m)} walk heading {heading}
        </p>
        {quality && (
          <p className="wk-quality">
            <span className="wk-quality-word">
              <FitGlyph fit={quality.fit} />
              {quality.word}
            </span>
            <span className="wk-quality-text">{quality.sentence}</span>
          </p>
        )}
      </div>

      <TwinMap path={path} />

      <table className="wk-compare">
        <caption className="sr-only">Moon route and Earth twin compared</caption>
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col">Moon · {props.searchedLabel}</th>
            <th scope="col">Earth twin</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Length</th>
            <td>{fmtKm(query.length_m)}</td>
            <td>{fmtKm(current.item.length_m)}</td>
          </tr>
          <tr>
            <th scope="row">Climbs</th>
            <td>{Math.round(query.climb_m)} m</td>
            <td>{Math.round(current.climb)} m</td>
          </tr>
          <tr>
            <th scope="row">Steepest</th>
            <td>{query.max_slope_deg.toFixed(1)}°</td>
            <td>{current.item.max_slope_deg.toFixed(1)}°</td>
          </tr>
          <tr>
            <th scope="row">Typical gap</th>
            <td colSpan={2}>
              heights {current.rmsHeight.toFixed(0)} m apart, slopes {current.rmsSlope.toFixed(1)}° apart
            </td>
          </tr>
        </tbody>
      </table>

      <TwinChart
        moonHeights={moonHeights}
        earthHeights={current.heights}
        moonSlopes={query.slopes}
        earthSlopes={current.slopes}
        moonLabel={`Moon · ${region.name}`}
        earthLabel={`Earth · ${p.short}`}
      />


      <div className="wk-runners">
        <h3>Closest Earth paths</h3>
        <table className="data-table wk-runner-table">
          <thead>
            <tr>
              <th className="r">#</th>
              <th>Place</th>
              <th className="r">Length</th>
              <th className="r" title="Typical height difference along the walk (root-mean-square)">
                Heights apart
              </th>
              <th className="r" title="Typical slope difference along the walk (root-mean-square)">
                Slopes apart
              </th>
            </tr>
          </thead>
          <tbody>
            {found.map((f: Found, i: number) => {
              const fp = place(f.item.site_id);
              return (
                <tr key={`${f.row.i}`} data-active={i === sel} onClick={(): void => props.onSel(i)}>
                  <td className="r">{i + 1}</td>
                  <td>
                    <button type="button" className="row-btn" aria-pressed={i === sel} title={fp.remote ? fp.full : undefined} onClick={(): void => props.onSel(i)}>
                      {fp.short}
                    </button>
                  </td>
                  <td className="r">{fmtKm(f.item.length_m)}</td>
                  <td className="r">{f.rmsHeight.toFixed(0)} m</td>
                  <td className="r">{f.rmsSlope.toFixed(1)}°</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="caption">{props.note} “Remote” places are more than 100 km from the nearest named town; hover for the exact spot.</p>
      </div>

      <div className="wk-actions">
        <button type="button" className="btn" disabled={!props.in3d} onClick={props.onWalk3d}>
          Walk both in 3D
          <span aria-hidden="true">→</span>
        </button>
        <button type="button" className="btn" onClick={props.onCalgary}>
          Find a twin in Calgary instead
          <span aria-hidden="true">→</span>
        </button>
        {!props.in3d && <span className="caption">This Earth square isn’t in the 3D site set, so it can’t open in 3D.</span>}
      </div>
    </section>
  );
}
