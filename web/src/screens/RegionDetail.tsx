import { useCallback, useMemo, type JSX } from 'react';
import { HAZARDS, metricInfo } from '../content';
import { EarthMap, type MapPoint } from '../components/EarthMap';
import { CoordBadge } from '../components/DangerProfile';
import { Fit, FitGlyph, HazardGlyph, VerdictGlyph, type VerdictKind } from '../components/Glyphs';
import { SampleChip, ScreenHead } from '../components/ScreenHead';
import { InfoTip } from '../components/InfoTip';
import { headlineLight, PatchFor } from '../components/PatchFor';
import { Select, type SelectOption } from '../components/Select';
import { regionOptions } from '../lib/regionOptions';
import { Term, Why } from '../components/Term';
import { fmtDeg, fmtNum, fmtPct, fmtSpread, fmtStat } from '../lib/units';
import { parseBootstrap } from '../lib/validationExtras';
import '../styles/clarity-moon.css';
import { localSolarTime } from '../lib/solar';
import { placeName } from '../lib/placeName';
import { plainNote } from '../lib/plain';
import { matchesFor, useApp, useRegion, type CoreData } from '../store';
import { HAZARD_IDS, isObj, type EarthSite, type HazardId, type Light, type Match, type RehearsalWindow } from '../types/contract';

const DAY_FMT = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

const HAZARD_NOUN: Record<HazardId, string> = { shadow: 'shadow', rim: 'rim-jump', texture: 'texture' };

/** Signed Earth − Moon difference in the metric's own unit: shares as percentage points, others as-is. */
function realGap(diff: number, unit: string): string {
  if (!Number.isFinite(diff)) return '—';
  const sign = diff > 0 ? '+' : diff < 0 ? '−' : '±';
  const a = Math.abs(diff);
  if (unit === '%') {
    const v = a * 100;
    return `${sign}${v < 1 ? v.toFixed(1) : Math.round(v)} pts`;
  }
  if (unit === 'm') return `${sign}${Math.round(a)} m`;
  if (unit === '°') return `${sign}${a.toFixed(1)}°`;
  if (unit === '/km²') return `${sign}${a.toFixed(1)} /km²`;
  return `${sign}${a < 10 ? a.toFixed(2) : a.toFixed(1)}`;
}

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

type Loose = Record<string, unknown>;

function field(o: unknown, k: string): unknown {
  return isObj(o) ? (o as Loose)[k] : undefined;
}

function numField(o: unknown, k: string): number | null {
  const v = field(o, k);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function strField(o: unknown, k: string): string | null {
  const v = field(o, k);
  return typeof v === 'string' && v ? v : null;
}

/** Pearson r per metric, Copernicus vs NASADEM, from method.json nasadem_check.per_metric. */
function nasademAgreement(core: CoreData): Record<string, number> {
  const out: Record<string, number> = {};
  const per = field(field(core.method?.file, 'nasadem_check'), 'per_metric');
  if (!isObj(per)) return out;
  Object.entries(per as Loose).forEach(([k, v]: [string, unknown]): void => {
    const r = numField(v, 'r');
    if (r !== null) out[k] = r;
  });
  return out;
}

/** Below this r the two elevation datasets disagree enough to flag the measure as less certain. */
const WEAK_R = 0.8;

/** Sun this low is bent noticeably by the atmosphere, so timing is uncertain. */
const REFRACTION_EL_DEG = 1;

const SHOWN_WINDOWS = 3;

function WindowRows({ windows, site }: { windows: RehearsalWindow[]; site: EarthSite }): JSX.Element {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Date (UTC)</th>
          <th className="r">UTC (h:mm)</th>
          <th className="r">Local solar (h:mm)</th>
          <th className="r">Sun elev. · azimuth</th>
          <th className="r">Length</th>
        </tr>
      </thead>
      <tbody>
        {windows.map((w: RehearsalWindow) => {
          const st = new Date(w.start_utc);
          const e = new Date(w.end_utc);
          const duration = numField(w, 'duration_min') ?? (e.getTime() - st.getTime()) / 60000;
          const refr = field(w, 'refraction_sensitive') === true || w.sun_el < REFRACTION_EL_DEG;
          return (
            <tr key={w.start_utc}>
              <td className="mono">{DAY_FMT.format(st)}</td>
              <td className="r mono">
                {hhmmUTC(st)}–{hhmmUTC(e)}
              </td>
              <td className="r">
                {localSolarTime(st, site.lon)}–{localSolarTime(e, site.lon)}
              </td>
              <td className="r" title={w.el_kind}>
                {fmtDeg(w.sun_el)} · {fmtDeg(w.sun_az, 0)}
                {refr && (
                  <span className="refr-flag">
                    refraction-sensitive
                    <Why id="refraction" align="end" />
                  </span>
                )}
              </td>
              <td className="r">{fmtNum(duration, 1)} min</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function WindowsTable({ windows, site }: { windows: RehearsalWindow[]; site: EarthSite }): JSX.Element {
  if (windows.length === 0) {
    return <p className="muted">No matching low-sun window in the searched period (for example, polar night at this latitude).</p>;
  }
  const rest = windows.slice(SHOWN_WINDOWS);
  return (
    <>
      <WindowRows windows={windows.slice(0, SHOWN_WINDOWS)} site={site} />
      {rest.length > 0 && (
        <details className="more-windows">
          <summary>{rest.length} more windows</summary>
          <WindowRows windows={rest} site={site} />
        </details>
      )}
    </>
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
  agreement,
  screened,
  regions,
  active,
  onToggle,
  onCompare,
}: {
  match: Match;
  site: EarthSite;
  agreement: Record<string, number>;
  screened: number | null;
  regions: { id: string; name: string }[];
  active: boolean;
  onToggle: () => void;
  onCompare: () => void;
}): JSX.Element {
  const place = placeName(site);
  const nasadem: unknown = field(site, 'nasadem');
  const nasMetrics: unknown = field(nasadem, 'metrics');
  const rehearsal: unknown = field(match, 'rehearsal');
  const targetEl = numField(rehearsal, 'target_sun_el');
  const tolEl = numField(rehearsal, 'el_tolerance');
  const rehearsalNote = [strField(rehearsal, 'azimuth_note'), strField(rehearsal, 'note'), strField(rehearsal, 'search')].filter(
    (t: string | null): t is string => t !== null,
  );
  const stageRank = numField(site, 'stage1_rank');
  const stageBest = strField(site, 'stage1_best');
  // One quality line: the site's screening rank among all Earth squares screened. stage1_best names the Moon
  // search where it got that rank, which may be another region; the line stays true either way and the
  // tooltip names the search.
  let quality: string | null = null;
  let qualityTitle: string | undefined;
  if (stageRank !== null && screened) {
    const topPct = Math.max(Math.ceil((stageRank / screened) * 1000) / 10, 0.1);
    quality = `Top ${fmtNum(topPct, 1)}% of ${fmtNum(screened)} Earth squares screened`;
    if (stageBest) {
      const [rid, hz] = stageBest.split('|');
      const rn = regions.find((r) => r.id === rid)?.name ?? rid;
      qualityTitle = `Ranked #${fmtNum(stageRank)} of ${fmtNum(screened)} when screened as a ${hz ?? ''} match for ${rn}`;
    }
  }
  return (
    <article className="site-card" data-active={active}>
      <div className="site-card-head">
        <button type="button" className="site-card-toggle" onClick={onToggle} aria-expanded={active}>
          <span className="rank">{match.rank}</span>
          <span className="site-card-title">
            <span className="site-name" title={place.title}>
              {place.label}
            </span>
            {quality && <span className="caption" title={qualityTitle}>{quality}</span>}
          </span>
        </button>
        <span className="site-card-tags">
          {site.known_analog && (
            <span className="chip">
              <Term id="knownAnalog">Known analog</Term>
            </span>
          )}
          {site.role === 'decoy' && (
            <span className="chip chip-dashed">
              <Term id="decoy">Decoy (control)</Term>
            </span>
          )}
          <FitCounts match={match} />
        </span>
      </div>
      {active && (
        <div className="site-card-body">
          {match.patchiness_summary?.text && <p className="patch-line">{match.patchiness_summary.text}</p>}
          <details className="verdict-details">
            <summary>Metric by metric and in words</summary>
            <div className="list-lede">
              <span className="why-row">
                Gap = this site minus the Moon region. Hover a gap for its <Term id="typicalSpread">× figure</Term>
                <Why id="iqr" />
              </span>
            </div>
          <section>
            <h4 className="section-label">Metric by metric</h4>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th className="r">Moon (middle 50%)</th>
                  <th className="r">This site</th>
                  <th className="r">
                    <span className="th-tip">
                      NASADEM check
                      <Why id="nasadem" align="end" />
                    </span>
                  </th>
                  <th className="r">Gap</th>
                  <th>Fit</th>
                </tr>
              </thead>
              <tbody>
                {match.lights.map((l) => {
                  const mi = metricInfo(l.metric);
                  const nv = field(nasMetrics, l.metric);
                  const r = agreement[l.metric];
                  const weak = typeof r === 'number' && r < WEAK_R;
                  const gap = numField(l, 'gap_in_iqr');
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
                      <td className="r metric-nasadem" data-weak={weak} title={weak ? 'Least certain measure: the two elevation datasets agree only moderately.' : undefined}>
                        {typeof nv === 'number' ? mi.fmt(nv) : '—'}
                        {typeof r === 'number' && <span className="pm">r {fmtStat(r)}{weak ? ' · least certain' : ''}</span>}
                      </td>
                      <td className="r" title={`${l.gap_text}${gap !== null ? ` · ${fmtSpread(gap, 1)} (× = how far off, compared with how much the Moon region varies within itself; under 0.5 = close)` : ''}`}>
                        {realGap(l.earth - l.moon, mi.unit)}
                      </td>
                      <td>
                        <Fit fit={l.light} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
          <PatchFor light={headlineLight(match)} hazard={match.hazard} />
          <div className="verdicts">
              <Verdict kind="match" title="Matches" items={match.matches_text} empty="No metric is within the Moon region’s spread." />
              <Verdict kind="mismatch" title="Doesn’t match" items={match.mismatches_text} empty="Every measured metric is close." />
              <Verdict kind="cannot" title="Can’t test here" items={match.cannot_test} empty="Nothing listed." />
          </div>
          </details>

          <section>
            <div className="windows-head">
              <h4 className="section-label">
                <Term id="rehearsalWindow">Rehearsal windows</Term>
              </h4>
              {targetEl !== null && (
                <span className="caption">
                  Sun elevation {fmtDeg(targetEl)}
                  {tolEl !== null ? ` ±${fmtDeg(tolEl, 2)}` : ''}
                </span>
              )}
              {rehearsalNote.length > 0 && (
                <InfoTip label="How the windows were searched" title="Window search" align="end">
                  {rehearsalNote.map((t: string) => (
                    <p key={t}>{t}</p>
                  ))}
                </InfoTip>
              )}
            </div>
            <WindowsTable windows={match.windows} site={site} />
          </section>

          <div className="card-actions">
            <button type="button" className="btn btn-primary" onClick={onCompare}>
              Compare terrain in 3D →
            </button>
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
  const regionOpts = useMemo((): SelectOption<string>[] => regionOptions(core.regions, core.summary?.ranking), [core]);
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
  const agreement = useMemo((): Record<string, number> => nasademAgreement(core), [core]);
  const screened = numField(field(core.method?.file, 'screen'), 'n_screened');
  const boot = parseBootstrap(core.summary?.validation);
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
            For each danger, the three Earth sites whose terrain and light reproduce it best. Each metric is marked close, partial or far
            against the Moon region’s typical spread. No overall “% Moon-like” score, on purpose.
          </p>
        }
      />

      <div className="tabs-row">
        <div className="tabs" role="tablist" aria-label="Danger">
          {HAZARD_IDS.map((h: HazardId) => (
            <button key={h} type="button" role="tab" className="tab" aria-selected={h === hazard} onClick={(): void => setHazard(h)}>
              <HazardGlyph hazard={h} />
              {HAZARDS[h].name}
            </button>
          ))}
        </div>
        <span className="tab-lesson">
          Lesson
          <InfoTip label={`Lesson from ${hz.mission}`} title={`Lesson from ${hz.mission}`} align="end">
            <p>
              <strong>{hz.mission}:</strong> {hz.lesson}
            </p>
          </InfoTip>
        </span>
        <Select
          className="field field-inline"
          labelClassName="field-label"
          label="Moon region"
          value={regionId}
          options={regionOpts}
          onChange={setRegion}
        />
      </div>

      <div className="region-layout" role="tabpanel">
        <div className="map-box">
          <EarthMap points={points} onSelect={onSelect} fitKey={`${regionId}:${hazard}`} />
        </div>
        <div className="site-list">
          <div className="list-lede">
            {boot && (
              <span className="why-row">
                This top 3 reappears in {fmtPct(boot.reappearance)} of reruns on a fresh sample
                <Why id="bootstrap" />
              </span>
            )}
          </div>
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
                agreement={agreement}
                screened={screened}
                regions={core.regions}
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
