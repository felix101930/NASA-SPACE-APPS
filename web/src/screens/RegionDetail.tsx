import { useCallback, useMemo, type JSX } from 'react';
import { HAZARDS, LIGHT_LABEL, metricInfo } from '../content';
import { EarthMap, type MapPoint } from '../components/EarthMap';
import { CoordBadge, HZ_VAR } from '../components/DangerProfile';
import { localSolarTime } from '../lib/solar';
import { matchesFor, useApp, useRegion, type CoreData } from '../store';
import { HAZARD_IDS, type EarthSite, type HazardId, type Match, type RehearsalWindow } from '../types/contract';

const DAY_FMT = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

function hhmmUTC(d: Date): string {
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function WindowsTable({ windows, site }: { windows: RehearsalWindow[]; site: EarthSite }): JSX.Element {
  if (windows.length === 0) {
    return <p className="muted">No matching low-sun window in the searched period (for example, polar night at this latitude).</p>;
  }
  return (
    <table className="windows">
      <thead>
        <tr>
          <th>Date (UTC)</th>
          <th>UTC</th>
          <th>Local solar time</th>
          <th>Sun el / az</th>
        </tr>
      </thead>
      <tbody>
        {windows.map((w: RehearsalWindow) => {
          const s = new Date(w.start_utc);
          const e = new Date(w.end_utc);
          return (
            <tr key={w.start_utc}>
              <td>{DAY_FMT.format(s)}</td>
              <td>
                {hhmmUTC(s)}–{hhmmUTC(e)}
              </td>
              <td>
                {localSolarTime(s, site.lon)}–{localSolarTime(e, site.lon)}
              </td>
              <td title={w.el_kind}>
                {w.sun_el.toFixed(1)}° / {w.sun_az.toFixed(0)}°
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SiteCard({
  match,
  site,
  active,
  onToggle,
  onCompare,
}: {
  match: Match;
  site: EarthSite;
  active: boolean;
  onToggle: () => void;
  onCompare: () => void;
}): JSX.Element {
  const greens = match.lights.filter((l) => l.light === 'green').length;
  return (
    <article className="site-card" data-active={active}>
      <button className="site-card-head" onClick={onToggle} aria-expanded={active}>
        <span className="rank">{match.rank}</span>
        <span>
          <span style={{ display: 'block', fontWeight: 600, fontSize: 16 }}>{site.name}</span>
          <span className="muted" style={{ fontSize: 13 }}>
            {site.country} · {site.category.replace(/_/g, ' ')} · {site.rock.lith}
            {site.rock.anorthosite ? ' · anorthosite' : ''}
          </span>
        </span>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {site.known_analog && <span className="chip chip-ok">Known analog</span>}
          {site.role === 'decoy' && <span className="chip chip-warn">Decoy (control)</span>}
          <span className="chip num" title="Metrics within the Moon region's spread">
            {greens}/{match.lights.length} close
          </span>
        </span>
      </button>
      {active && (
        <div className="site-card-body">
          <div className="verdicts">
            <div className="verdict">
              <h4>
                <span aria-hidden="true">✅</span> Matches
              </h4>
              {match.matches_text.length ? (
                <ul>
                  {match.matches_text.map((t: string) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              ) : (
                <p className="faint" style={{ fontSize: 13 }}>
                  No metric is within the Moon region’s spread.
                </p>
              )}
            </div>
            <div className="verdict">
              <h4>
                <span aria-hidden="true">⚠️</span> Doesn’t match
              </h4>
              {match.mismatches_text.length ? (
                <ul>
                  {match.mismatches_text.map((t: string) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              ) : (
                <p className="faint" style={{ fontSize: 13 }}>
                  Every measured metric is close.
                </p>
              )}
            </div>
            <div className="verdict">
              <h4>
                <span aria-hidden="true">🚫</span> Can’t test here
              </h4>
              <ul>
                {match.cannot_test.map((t: string) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
          </div>

          <div>
            <div className="label" style={{ marginBottom: 8 }}>
              Metric by metric
            </div>
            <table className="lights">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Moon (spread)</th>
                  <th>This site</th>
                  <th>Gap</th>
                  <th>Fit</th>
                </tr>
              </thead>
              <tbody>
                {match.lights.map((l) => {
                  const mi = metricInfo(l.metric);
                  return (
                    <tr key={l.metric}>
                      <td title={mi.help}>{mi.label}</td>
                      <td className="num">
                        {mi.fmt(l.moon)}{' '}
                        <span className="faint">
                          ({mi.fmt(l.moon_iqr[0])}–{mi.fmt(l.moon_iqr[1])})
                        </span>
                      </td>
                      <td className="num">{mi.fmt(l.earth)}</td>
                      <td>{l.gap_text}</td>
                      <td>
                        <span className={`light light-${l.light}`}>{LIGHT_LABEL[l.light] ?? l.light}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div>
            <div className="label" style={{ marginBottom: 8 }}>
              Rehearsal windows · when the sun here matches the Moon’s
            </div>
            <WindowsTable windows={match.windows} site={site} />
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={onCompare}>
              Compare terrain in 3D →
            </button>
            <span className="faint" style={{ fontSize: 12.5 }}>
              Bare ground {(site.bare_frac * 100).toFixed(0)}% · {site.worldcover_note}
            </span>
          </div>
        </div>
      )}
    </article>
  );
}

export function RegionDetail(): JSX.Element {
  const core = useApp((s) => s.core) as CoreData;
  const hazard = useApp((s) => s.hazard);
  const setHazard = useApp((s) => s.setHazard);
  const siteId = useApp((s) => s.siteId);
  const setSite = useApp((s) => s.setSite);
  const setScreen = useApp((s) => s.setScreen);
  const regionId = useApp((s) => s.regionId);
  const setRegion = useApp((s) => s.setRegion);
  const region = useRegion();

  const list = useMemo((): Match[] => matchesFor(core, regionId, hazard), [core, regionId, hazard]);
  const activeId = siteId && list.some((m: Match): boolean => m.site_id === siteId) ? siteId : (list[0]?.site_id ?? null);

  const points = useMemo(
    (): MapPoint[] =>
      list.flatMap((m: Match): MapPoint[] => {
        const s = core.siteById.get(m.site_id);
        return s ? [{ id: s.id, lat: s.lat, lon: s.lon, label: String(m.rank), title: `#${m.rank} ${s.name}`, active: s.id === activeId }] : [];
      }),
    [list, core, activeId],
  );
  const onSelect = useCallback((id: string): void => setSite(id), [setSite]);

  if (!region) return <p>No region selected.</p>;
  const hz = HAZARDS[hazard];

  return (
    <div>
      <div className="screen-head">
        <div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <h1>{region.name}</h1>
            <CoordBadge region={region} />
            {core.matchesOrigin === 'mock' && (
              <span className="chip chip-warn" title="matches.json is the synthetic mock set; the pipeline output is not available yet">
                Mock matches
              </span>
            )}
          </div>
          <p>
            For each hazard, the three Earth sites whose terrain and light reproduce it most closely. Fits are shown metric
            by metric; there is no overall “% Moon-like” score, on purpose.
          </p>
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="label">Region</span>
          <select className="select" value={regionId} onChange={(e): void => setRegion(e.target.value)}>
            {core.regions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="tabs" role="tablist" aria-label="Hazard">
        {HAZARD_IDS.map((h: HazardId) => (
          <button key={h} role="tab" className="tab" aria-selected={h === hazard} onClick={(): void => setHazard(h)}>
            <span className="hz-dot" style={{ background: HZ_VAR[h] }} aria-hidden="true" />
            {HAZARDS[h].name}
            <span className="faint" style={{ fontSize: 12 }}>
              {HAZARDS[h].mission}
            </span>
          </button>
        ))}
      </div>

      <p className="muted" style={{ marginBottom: 16 }}>
        <strong style={{ color: 'var(--text)' }}>Lesson from {hz.mission}:</strong> {hz.lesson}
      </p>

      <div className="region-layout" role="tabpanel">
        <div className="map-box">
          <EarthMap points={points} onSelect={onSelect} fitKey={`${regionId}:${hazard}`} />
        </div>
        <div>
          {list.length === 0 && <p className="muted">No matches for this region and hazard in matches.json.</p>}
          {list.map((m: Match) => {
            const site = core.siteById.get(m.site_id);
            if (!site) {
              return (
                <p key={m.site_id} className="error-box">
                  Site {m.site_id} is referenced in matches.json but missing from earth_sites.json.
                </p>
              );
            }
            return (
              <SiteCard
                key={m.site_id}
                match={m}
                site={site}
                active={m.site_id === activeId}
                onToggle={(): void => setSite(m.site_id)}
                onCompare={(): void => {
                  setSite(m.site_id);
                  setScreen('terrain');
                }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
