import { useCallback, useEffect, useState, type JSX } from 'react';
import { HAZARDS, distanceFit } from '../content';
import { FitGlyph, HazardGlyph } from '../components/Glyphs';
import { SampleChip, ScreenHead } from '../components/ScreenHead';
import { Why } from '../components/Term';
import { InfoTip } from '../components/InfoTip';
import { loadOptionalJson } from '../data/loader';
import { useApp, type CoreData } from '../store';
import {
  HAZARD_IDS,
  isObj,
  isTransectsFile,
  type EarthSite,
  type HazardId,
  type Light,
  type Match,
  type Meta,
  type RankingRow,
} from '../types/contract';
import { CreditsPanel } from '../components/Credits';
import { AnalogList } from '../components/AnalogList';
import { buildCredits, hasNasademCheck } from '../lib/credits';
import { parseMethodExtras } from '../lib/methodExtras';
import { parseBootstrap, parseWalkTest } from '../lib/validationExtras';
import type { MethodNoteId } from '../lib/methodNotes';
import { placeName } from '../lib/placeName';
import { fmtNum, fmtPct, fmtStat } from '../lib/units';
import '../styles/clarity.css';
import '../styles/summary.css';

/** The three limits we state up front (docs/method-decisions.md, "Limits we state up front"). */
const LIMITS: readonly string[] = [
  'Features under ~60 m (boulders, small craters) are invisible at 30 m resolution.',
  'On Earth this low sun lasts minutes; at the lunar pole it lasts days.',
  'No Earth place reproduces 1/6 g gravity, vacuum or −200 °C nights.',
];

type Verdict = 'good' | 'partial' | 'none';

/** Plain verdicts, on the same distance bands as distanceFit (green < 0.5, amber < 1.5, red beyond). */
const VERDICT: Record<Light, Verdict> = { green: 'good', amber: 'partial', red: 'none' };
const VERDICT_WORD: Record<Verdict, string> = {
  good: 'Good stand-in',
  partial: 'Partial stand-in',
  none: 'No good stand-in found',
};
const VERDICT_FIT: Record<Verdict, Light> = { good: 'green', partial: 'amber', none: 'red' };

/** Column labels and the noun used for each danger in the headline sentence. */
const COL_LABEL: Record<HazardId, string> = { shadow: 'Shadow', rim: 'Big drops', texture: 'Camera texture' };
const HAZARD_NOUN: Record<HazardId, string> = { shadow: 'low-sun shadows', rim: 'big drops', texture: 'camera texture' };

/** "154 km NE of " at the start of a pipeline site name (same pattern as lib/placeName.ts). */
const OFFSET = /^\d+\s*km\s+[NSEW]{1,3}\s+of\s+/i;
/** Display-only short country names; the precise name stays in the tooltip. */
const SHORT_COUNTRY: Record<string, string> = { "People's Republic of China": 'China' };

interface Place {
  /** "near Taltal, Chile" or a documented site's own name. */
  short: string;
  /** Precise name (with the distance and direction from the town), for the tooltip. */
  title: string;
}

function shortPlace(site: EarthSite): Place {
  const p = placeName(site);
  const country = SHORT_COUNTRY[site.country] ?? site.country;
  if (OFFSET.test(site.name)) return { short: `near ${site.name.replace(OFFSET, '')}, ${country}`, title: p.title };
  // Documented site: its own name, without a trailing "(Country)" that repeats the country.
  const base = site.name.replace(/\s*\(([^)]*)\)\s*$/, (whole: string, inner: string): string => (inner === site.country ? '' : whole));
  return { short: base.endsWith(country) ? base : `${base}, ${country}`, title: p.title };
}

interface Cell {
  verdict: Verdict | null;
  place: Place | null;
}

/** Verdict and Earth place of the region's #1 match for this danger. */
function cellFor(core: CoreData, row: RankingRow, h: HazardId): Cell {
  // per_hazard_best_site is a pipeline extra (not in the core contract); fall back to the rank-1 match.
  const sites: unknown = 'per_hazard_best_site' in row ? row.per_hazard_best_site : null;
  const raw: unknown = isObj(sites) ? sites[h] : null;
  const pool = core.matches.filter((m: Match): boolean => m.region_id === row.region_id && m.hazard === h);
  const m = pool.find((x: Match): boolean => x.site_id === raw) ?? pool.find((x: Match): boolean => x.rank === 1);
  const siteId = typeof raw === 'string' ? raw : m?.site_id;
  const site = siteId ? core.siteById.get(siteId) : undefined;
  const fit = distanceFit(row.per_hazard_best_distance?.[h] ?? m?.distance);
  return { verdict: fit ? VERDICT[fit] : null, place: site ? shortPlace(site) : null };
}

interface GridRow {
  id: string;
  name: string;
  cells: Record<HazardId, Cell>;
}

interface Tally {
  good: number;
  partial: number;
  none: number;
  total: number;
  /** Regions where every danger is a good or partial stand-in. */
  regionsCovered: number;
  /** Region x danger pairs with no good stand-in, in ranking order. */
  gaps: { region: string; hazard: HazardId }[];
}

function tally(rows: GridRow[]): Tally {
  const t: Tally = { good: 0, partial: 0, none: 0, total: 0, regionsCovered: 0, gaps: [] };
  for (const r of rows) {
    let covered = true;
    for (const h of HAZARD_IDS) {
      const v = r.cells[h].verdict;
      if (!v) {
        covered = false;
        continue;
      }
      t[v] += 1;
      t.total += 1;
      if (v === 'none') {
        covered = false;
        t.gaps.push({ region: r.name, hazard: h });
      }
    }
    if (covered) t.regionsCovered += 1;
  }
  return t;
}

function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** One sentence from the data: how many regions are fully covered, and which danger has no stand-in. */
function headline(t: Tally, nRegions: number): string {
  const all = t.regionsCovered === nRegions;
  const lead = `For ${all ? 'all' : t.regionsCovered} of ${nRegions} regions, every danger has a good or partial stand-in on Earth.`;
  if (!t.gaps.length) return lead;
  return `${lead} No good stand-in yet for ${listJoin(t.gaps.map((g: { region: string; hazard: HazardId }): string => `${g.region}’s ${HAZARD_NOUN[g.hazard]}`))}.`;
}

function Credits({ metas, nasadem }: { metas: { file: string; meta: Meta }[]; nasadem: boolean }): JSX.Element {
  const versions = Array.from(new Set(metas.map((m) => m.meta.pipeline_version))).join(', ');
  return (
    <details className="method sum-section">
      <summary>Data credits and licences</summary>
      <CreditsPanel
        id="credits-h"
        credits={buildCredits(metas, { nasadem })}
        intro={<>Every source behind these screens. Pipeline version: {versions || 'unknown'}.</>}
      >
        <li>
          <strong>Failure accounts</strong> · ispace (26 May 2023); Intuitive Machines earnings call (13 May 2025), as reported by The Register (14
          May 2025); NASA JPL (11 Dec 2024)
        </li>
      </CreditsPanel>
    </details>
  );
}

interface TrustCheck {
  key: string;
  what: string;
  result: string;
  why: MethodNoteId;
}

export function Summary(): JSX.Element {
  const core = useApp((s) => s.core) as CoreData;
  const setRegion = useApp((s) => s.setRegion);
  const setHazard = useApp((s) => s.setHazard);
  const setScreen = useApp((s) => s.setScreen);
  const [walkMeta, setWalkMeta] = useState<Meta | null>(null);
  const [analogMeta, setAnalogMeta] = useState<Meta | null>(null);
  const onAnalogMeta = useCallback((m: Meta): void => setAnalogMeta(m), []);
  useEffect((): void => {
    loadOptionalJson('walk/transects.json', isTransectsFile)
      .then((r): void => setWalkMeta(r?.value.meta ?? null))
      .catch((): void => undefined);
  }, []);

  const summary = core.summary;
  const regionName = (id: string): string => core.regions.find((r) => r.id === id)?.name ?? id;
  const metas = [
    ...core.metas,
    ...(walkMeta ? [{ file: 'walk/transects.json', meta: walkMeta }] : []),
    ...(analogMeta ? [{ file: 'analog_tags.json', meta: analogMeta }] : []),
  ];
  const nasadem = hasNasademCheck(core.method?.file);

  if (!summary) {
    return (
      <div>
        <div className="error-box">summary.json is not available yet from the pipeline or the sample set.</div>
        <Credits metas={metas} nasadem={nasadem} />
      </div>
    );
  }
  const v = summary.validation;
  const ranking = [...summary.ranking].sort((a: RankingRow, b: RankingRow): number => a.rank - b.rank);
  const easiest = ranking[0];
  const hardest = ranking[ranking.length - 1];
  const sample = core.summaryOrigin !== 'data';
  const rows: GridRow[] = ranking.map((r: RankingRow): GridRow => ({
    id: r.region_id,
    name: regionName(r.region_id),
    cells: { shadow: cellFor(core, r, 'shadow'), rim: cellFor(core, r, 'rim'), texture: cellFor(core, r, 'texture') },
  }));
  const t = tally(rows);
  const extras = core.method ? parseMethodExtras(core.method.file) : null;
  const boot = parseBootstrap(v);
  const walkTop1 = parseWalkTest(v)?.top1;
  const open = (regionId: string, h: HazardId): void => {
    setRegion(regionId);
    setHazard(h);
    setScreen('region');
  };

  const checks: TrustCheck[] = [
    {
      key: 'pgda',
      what: 'Shadows agree with NASA’s sunlight map',
      result: `r = ${fmtStat(v.shadow_vs_pgda?.pearson_r)}`,
      why: 'shadowFar',
    },
    extras?.aucIndependent != null
      ? {
          key: 'analogs',
          what: 'Real Moon-training sites outrank decoys',
          result: `${fmtStat(extras.aucIndependent)} on ${fmtNum(extras.nIndependent)} independent sites (0.50 = chance)`,
          why: 'analogs',
        }
      : {
          key: 'analogs',
          what: 'Real Moon-training sites outrank decoys',
          result: `${fmtStat(v.known_vs_decoy_auc)} (0.50 = chance)`,
          why: 'analogs',
        },
    ...(boot
      ? [{ key: 'boot', what: 'Top 3 survive a fresh Earth sample', result: `${fmtPct(boot.reappearance)} reappear in reruns`, why: 'bootstrap' as const }]
      : []),
    ...(typeof walkTop1 === 'number'
      ? [{ key: 'walk', what: 'Walk matcher finds a hidden Moon route', result: `first try ${fmtPct(walkTop1)} of the time`, why: 'walkMatcher' as const }]
      : []),
  ];

  return (
    <div>
      <ScreenHead
        kicker="Summary"
        chips={core.summaryOrigin === 'mock' ? <SampleChip what="Ranking and validation figures" /> : null}
        result={
          easiest && hardest
            ? `${regionName(easiest.region_id)} is the easiest region to rehearse on Earth; ${regionName(hardest.region_id)} the hardest`
            : 'No ranking yet'
        }
      />
      <p className="sum-problem">
        Low-sun shadows, crater-rim drops and blank ground fooled recent landers; we ranked NASA’s 9 south-pole regions by how well Earth stages
        each hazard.
      </p>

      {t.total > 0 && <p className="sum-headline">{headline(t, rows.length)}</p>}

      <section className="panel" aria-labelledby="grid-h">
        <div className="panel-head">
          <div className="why-row">
            <h2 id="grid-h">Where to rehearse each danger</h2>
            <InfoTip label="What does ‘good stand-in’ mean?" title="Good stand-in">
              <p>
                Good stand-in = the Earth site’s measurements for that danger fall within the Moon site’s own natural variation. Exact numbers are
                on each match’s page.
              </p>
            </InfoTip>
          </div>
          <span className="caption">Best Earth stand-in for each Moon region and danger.</span>
          {sample && <SampleChip what="This ranking" />}
        </div>
        <div className="table-scroll">
          <table className="fit-grid sv-grid">
            <thead>
              <tr>
                <th scope="col">Region, easiest first</th>
                {HAZARD_IDS.map((h: HazardId) => (
                  <th key={h} scope="col">
                    <span className="th-hz">
                      <HazardGlyph hazard={h} />
                      {COL_LABEL[h]}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r: GridRow, i: number) => (
                <tr key={r.id}>
                  <th scope="row" className="fit-region">
                    <span className="fit-region-name">{r.name}</span>
                    {i === 0 && <span className="caption">Easiest</span>}
                    {i === rows.length - 1 && rows.length > 1 && <span className="caption">Hardest</span>}
                  </th>
                  {HAZARD_IDS.map((h: HazardId) => {
                    const c = r.cells[h];
                    const word = c.verdict ? VERDICT_WORD[c.verdict] : 'No data';
                    const where = c.place ? (c.verdict === 'none' ? `closest: ${c.place.short}` : c.place.short) : null;
                    return (
                      <td key={h}>
                        <button
                          type="button"
                          className="fit-cell sv-cell"
                          data-verdict={c.verdict ?? 'missing'}
                          title={c.place ? c.place.title : undefined}
                          aria-label={`${r.name}, ${HAZARDS[h].name}: ${word}${where ? `, ${where}` : ''}. Open Earth matches.`}
                          onClick={(): void => open(r.id, h)}
                        >
                          <span className="sv-verdict">
                            {c.verdict ? <FitGlyph fit={VERDICT_FIT[c.verdict]} /> : null}
                            {word}
                          </span>
                          {where && <span className="sv-place">{where}</span>}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {t.total > 0 && (
          <div className="why-row sv-counts">
            <span className="sv-count">
              <FitGlyph fit="green" />
              Good stand-ins: {t.good} of {t.total}
            </span>
            <span className="sv-count">
              <FitGlyph fit="amber" />
              Partial: {t.partial}
            </span>
            <span className="sv-count">
              <FitGlyph fit="red" />
              None: {t.none}
            </span>
            {summary.patchiness && summary.patchiness.n_top1 > 0 && (
              <InfoTip label="Do the Earth sites vary like the Moon?" title="Patchiness" align="end">
                <p>
                  We also check whether each best Earth site varies across its 25 patches as much as its Moon site does:{' '}
                  {summary.patchiness.n_similar_headline} of {summary.patchiness.n_top1} do. This is a second check, not part of the ranking.
                </p>
              </InfoTip>
            )}
          </div>
        )}
      </section>

      <AnalogList core={core} onMeta={onAnalogMeta} />

      <section className="sum-section" aria-labelledby="sure-h">
        <h2 id="sure-h">How sure are we?</h2>
        <ul className="sure-list">
          {checks.map((c: TrustCheck) => (
            <li key={c.key}>
              <span className="sure-what">{c.what}</span>
              <span className="sure-result">{c.result}</span>
              <Why id={c.why} align="end" />
              {sample && <SampleChip what="This figure" />}
            </li>
          ))}
        </ul>
      </section>

      <section className="sum-section" aria-labelledby="limits-h">
        <h2 id="limits-h">Limits</h2>
        <ul className="limits">
          {LIMITS.map((l: string) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </section>

      <Credits metas={metas} nasadem={nasadem} />
    </div>
  );
}
