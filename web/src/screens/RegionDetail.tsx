import { useCallback, useMemo, type JSX } from 'react';
import { HAZARDS, metricInfo } from '../content';
import { EarthMap, type MapPoint } from '../components/EarthMap';
import { CoordBadge } from '../components/DangerProfile';
import { Fit, FitGlyph, HazardGlyph, VerdictGlyph, type VerdictKind } from '../components/Glyphs';
import { SampleChip, ScreenHead } from '../components/ScreenHead';
import { localSolarTime } from '../lib/solar';
import { placeName } from '../lib/placeName';
import { fmtRock, plainNote } from '../lib/plain';
import { matchesFor, useApp, useRegion, type CoreData } from '../store';
import { HAZARD_IDS, type EarthSite, type HazardId, type Light, type Match, type RehearsalWindow } from '../types/contract';

const DAY_FMT = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

const HAZARD_NOUN: Record<HazardId, string> = { shadow: 'shadow', rim: 'rim-jump', texture: 'texture' };

function hhmmUTC(d: Date): string {
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function countFits(m: Match): Record<Light, number> {
  const c: Record<Light, number> = { green: 0, amber: 0, red: 0 };
  m.lights.forEach((l): void => {
    if (l.light in c) c[l.light] += 1;
  });
  return c;
}

function WindowsTable({ windows, site }: { windows: RehearsalWindow[]; site: EarthSite }): JSX.Element {
  if (windows.length === 0) {
    return <p className="muted">No matching low-sun window in the searched period (for example, polar night at this latitude).</p>;
  }
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Date (UTC)</th>
          <th className="r">UTC</th>
          <th className="r">Local solar time</th>
          <th className="r">Sun elevation / azimuth</th>
        </tr>
      </thead>
      <tbody>
        {windows.map((w: RehearsalWindow) => {
          const s = new Date(w.start_utc);
          const e = new Date(w.end_utc);
          return (
            <tr key={w.start_utc}>
              <td className="mono">{DAY_FMT.format(s)}</td>
              <td className="r mono">
                {hhmmUTC(s)}–{hhmmUTC(e)}
              </td>
              <td className="r">
                {localSolarTime(s, site.lon)}–{localSolarTime(e, site.lon)}
              </td>
              <td className="r" title={w.el_kind}>
                {w.sun_el.toFixed(1)}° / {w.sun_az.toFixed(0)}°
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Verdict({ kind, title, items, empty }: { kind: VerdictKind; title: string; items: string[]; empty: string }): JSX.Element {
  return (
    <div className="verdict">
      <h4>
        <VerdictGlyph kind={kind} />
        {title}
      </h4>
      {items.length ? (
        <ul>
          {items.map((t: string) => {
            const n = plainNote(t);
            return (
              <li key={t} title={n.title}>
                {n.text}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="caption">{empty}</p>
      )}
    </div>
  );
}

function FitCounts({ match }: { match: Match }): JSX.Element {
  const c = countFits(match);
  const label = `${c.green} close, ${c.amber} partial, ${c.red} far of ${match.lights.length} metrics`;
  return (
    <span className="fit-counts" aria-label={label} title={label}>
      {(['green', 'amber', 'red'] as Light[]).map((l: Light) => (
        <span key={l} className="fit-count" data-fit={l} aria-hidden="true">
          <FitGlyph fit={l} />
          {c[l]}
        </span>
      ))}
    </span>
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
  const place = placeName(site);
  const rock = fmtRock(site.rock.lith);
  return (
    <article className="site-card" data-active={active}>
      <button type="button" className="site-card-head" onClick={onToggle} aria-expanded={active}>
        <span className="rank">{match.rank}</span>
        <span className="site-card-title">
          <span className="site-name" title={place.title}>
            {place.label}
          </span>
          <span className="caption">
            {place.region ? `${place.region} · ` : ''}
            {site.category.replace(/_/g, ' ')}
            {rock ? ` · ${rock}` : ''}
            {site.rock.anorthosite ? ' · anorthosite' : ''}
          </span>
        </span>
        <span className="site-card-tags">
          {site.known_analog && <span className="chip">Known analog</span>}
          {site.role === 'decoy' && <span className="chip chip-dashed">Decoy (control)</span>}
          <FitCounts match={match} />
        </span>
      </button>
      {active && (
        <div className="site-card-body">
          <div className="verdicts">
            <Verdict kind="match" title="Matches" items={match.matches_text} empty="No metric is within the Moon region’s spread." />
            <Verdict kind="mismatch" title="Doesn’t match" items={match.mismatches_text} empty="Every measured metric is close." />
            <Verdict kind="cannot" title="Can’t test here" items={match.cannot_test} empty="Nothing listed." />
          </div>

          <section>
            <h4 className="section-label">Metric by metric</h4>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th className="r">Moon (spread)</th>
                  <th className="r">This site</th>
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
                      <td className="r">
                        {mi.fmt(l.moon)}{' '}
                        <span className="faint">
                          ({mi.fmt(l.moon_iqr[0])}–{mi.fmt(l.moon_iqr[1])})
                        </span>
                      </td>
                      <td className="r">{mi.fmt(l.earth)}</td>
                      <td className="muted">{l.gap_text}</td>
                      <td>
                        <Fit fit={l.light} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <section>
            <h4 className="section-label">Rehearsal windows: when the sun here matches the Moon’s</h4>
            <WindowsTable windows={match.windows} site={site} />
          </section>

          <div className="card-actions">
            <button type="button" className="btn btn-primary" onClick={onCompare}>
              Compare terrain in 3D →
            </button>
            <span className="caption">
              Bare ground {(site.bare_frac * 100).toFixed(0)}% · {site.worldcover_note}
            </span>
          </div>
        </div>
      )}
    </article>
  );
}

function resultLine(regionName: string, hazard: HazardId, best: Match | undefined, site: EarthSite | undefined): string {
  if (!best || !site) return `No Earth match yet for ${regionName}, ${HAZARDS[hazard].name.toLowerCase()}.`;
  const c = countFits(best);
  return `${regionName} → ${placeName(site).label} reproduces ${c.green} of ${best.lights.length} ${HAZARD_NOUN[hazard]} metrics`;
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
        return s
          ? [{ id: s.id, lat: s.lat, lon: s.lon, label: String(m.rank), title: `#${m.rank} ${placeName(s).title}`, active: s.id === activeId }]
          : [];
      }),
    [list, core, activeId],
  );
  const onSelect = useCallback((id: string): void => setSite(id), [setSite]);

  if (!region) return <p>No region selected.</p>;
  const hz = HAZARDS[hazard];
  const best = list[0];

  return (
    <div>
      <ScreenHead
        kicker={`Earth matches · ${hz.name.toLowerCase()}`}
        chips={
          <>
            <CoordBadge region={region} />
            {core.matchesOrigin === 'mock' && <SampleChip what="Matches" />}
          </>
        }
        result={resultLine(region.name, hazard, best, best ? core.siteById.get(best.site_id) : undefined)}
        method={
          <p>
            For each of the 3 dangers, the three Earth sites whose terrain and light reproduce it most closely. Each metric is compared
            with the Moon region’s normal variation (its interquartile range) and marked close, partial or far. There is no overall “% Moon-like” score, on
            purpose.
          </p>
        }
      />

      <div className="tabs-row">
        <div className="tabs" role="tablist" aria-label="Danger">
          {HAZARD_IDS.map((h: HazardId) => (
            <button key={h} type="button" role="tab" className="tab" aria-selected={h === hazard} onClick={(): void => setHazard(h)}>
              <HazardGlyph hazard={h} />
              {HAZARDS[h].name}
              <span className="caption">{HAZARDS[h].mission}</span>
            </button>
          ))}
        </div>
        <label className="field field-inline">
          <span className="field-label">Moon region</span>
          <select className="select" value={regionId} onChange={(e): void => setRegion(e.target.value)}>
            {core.regions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="lesson">
        <strong>Lesson from {hz.mission}:</strong> {hz.lesson}
      </p>

      <div className="region-layout" role="tabpanel">
        <div className="map-box">
          <EarthMap points={points} onSelect={onSelect} fitKey={`${regionId}:${hazard}`} />
        </div>
        <div className="site-list">
          {list.length === 0 && <p className="muted">No matches for this region and danger in matches.json.</p>}
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
