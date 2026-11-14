import { useEffect, useState, type JSX } from 'react';
import { HAZARDS, ROW_NAME, distanceFit } from '../content';
import { Fit, HazardGlyph } from '../components/Glyphs';
import { SampleChip, ScreenHead } from '../components/ScreenHead';
import { Why } from '../components/Term';
import { InfoTip } from '../components/InfoTip';
import { loadOptionalJson } from '../data/loader';
import { useApp, type CoreData } from '../store';
import { HAZARD_IDS, isObj, isTransectsFile, type HazardId, type Match, type Meta, type RankingRow } from '../types/contract';
import { CreditsPanel } from '../components/Credits';
import { buildCredits, hasNasademCheck } from '../lib/credits';
import { parseMethodExtras } from '../lib/methodExtras';
import { parseBootstrap, parseWalkTest } from '../lib/validationExtras';
import type { MethodNoteId } from '../lib/methodNotes';
import { fmtM, fmtNum, fmtPct, fmtSpread, fmtStat } from '../lib/units';
import '../styles/clarity.css';

/** The three limits we state up front (docs/method-decisions.md, "Limits we state up front"). */
const LIMITS: readonly string[] = [
  'Features under ~60 m (boulders, small craters) are invisible at 30 m resolution.',
  'On Earth this low sun lasts minutes; at the lunar pole it lasts days.',
  'No Earth place reproduces 1/6 g gravity, vacuum or −200 °C nights.',
];

/** For each hazard, the one measure whose Moon–Earth gap the "How close?" line reports. */
const GAP_METRIC: Record<HazardId, { metric: string; label: string; fmt: (v: number) => string }> = {
  rim: { metric: 'jump1km_p95_m', label: 'rim drop', fmt: (v: number): string => `~${fmtM(v)}` },
  shadow: { metric: 'shadow_frac_el3', label: 'shadow', fmt: (v: number): string => `~${fmtNum(Math.max(1, v * 100), 0)}% of the ground` },
  texture: { metric: 'empty_cell_frac_el3', label: 'blank ground', fmt: (v: number): string => `~${fmtNum(Math.max(1, v * 100), 0)}% of the ground` },
};

/** A 0–1 share as a whole percentage. */
function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

/** Each ranking cell's headline measure, shown as Moon value vs Earth value (no derived units to decode). */
const CELL_GAP: Record<HazardId, { metric: string; text: (moon: number, earth: number) => string; what: string }> = {
  shadow: {
    metric: 'shadow_frac_el3',
    text: (moon: number, earth: number): string => `Moon ${pct(moon)} · Earth ${pct(earth)} dark`,
    what: 'share of the ground in shadow at a 3° sun, averaged over all sun directions',
  },
  rim: {
    metric: 'jump1km_p95_m',
    text: (moon: number, earth: number): string => `Moon ${Math.round(moon)} m · Earth ${Math.round(earth)} m drops`,
    what: 'height change over 1 km, steepest 5% of 1 km stretches (the big drops)',
  },
  texture: {
    metric: 'empty_cell_frac_el3',
    text: (moon: number, earth: number): string => `Moon ${pct(moon)} · Earth ${pct(earth)} featureless`,
    what: 'share of 1 km squares with nothing for a camera to track (3° sun)',
  },
};

const TIMES_LINE = '× = how far off, compared with how much the Moon region varies within itself (under 0.5 = close)';

/** Real-unit gap of the region's #1 Earth match for this hazard, from matches.json lights; null when missing. */
function cellGap(core: CoreData, row: RankingRow, h: HazardId): string | null {
  // per_hazard_best_site is a pipeline extra (not in the core contract); fall back to the rank-1 match.
  const sites: unknown = 'per_hazard_best_site' in row ? row.per_hazard_best_site : null;
  const raw: unknown = isObj(sites) ? sites[h] : null;
  const best = typeof raw === 'string' ? raw : null;
  const pool = core.matches.filter((m: Match): boolean => m.region_id === row.region_id && m.hazard === h);
  const m = pool.find((x: Match): boolean => x.site_id === best) ?? pool.find((x: Match): boolean => x.rank === 1);
  const l = m?.lights.find((x) => x.metric === CELL_GAP[h].metric);
  if (!l) return null;
  return Number.isFinite(l.moon) && Number.isFinite(l.earth) ? CELL_GAP[h].text(l.moon, l.earth) : null;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a: number, b: number): number => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

interface HowClose {
  gaps: { hazard: HazardId; text: string }[];
  nClose: number;
  n: number;
}

/** Typical Moon–Earth gap of the #1 Earth match per region, one measure per hazard, plus how many #1s are close. */
function howClose(matches: Match[]): HowClose {
  const top = matches.filter((m: Match): boolean => m.rank === 1);
  const gaps = (['rim', 'shadow', 'texture'] as HazardId[]).flatMap((h: HazardId): { hazard: HazardId; text: string }[] => {
    const g = GAP_METRIC[h];
    const diffs = top
      .filter((m: Match): boolean => m.hazard === h)
      .flatMap((m: Match): number[] => m.lights.filter((l) => l.metric === g.metric).map((l) => Math.abs(l.earth - l.moon)))
      .filter((d: number): boolean => Number.isFinite(d));
    const med = median(diffs);
    return med === null ? [] : [{ hazard: h, text: `${g.label} ${g.fmt(med)}` }];
  });
  return { gaps, nClose: top.filter((m: Match): boolean => distanceFit(m.distance) === 'green').length, n: top.length };
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
  useEffect((): void => {
    loadOptionalJson('walk/transects.json', isTransectsFile)
      .then((r): void => setWalkMeta(r?.value.meta ?? null))
      .catch((): void => undefined);
  }, []);

  const summary = core.summary;
  const regionName = (id: string): string => core.regions.find((r) => r.id === id)?.name ?? id;
  const metas = walkMeta ? [...core.metas, { file: 'walk/transects.json', meta: walkMeta }] : core.metas;
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
  const close = howClose(core.matches);
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

      <section className="panel" aria-labelledby="grid-h">
        <div className="panel-head">
          <h2 id="grid-h">Best Earth match, region by danger</h2>
          <span className="caption why-row">
            Gap between the Moon region and its best Earth match
            <InfoTip label="What do the gaps mean?" title="Reading a cell">
              <p>
                <strong>Shadow:</strong> {CELL_GAP.shadow.what}. <strong>Rim:</strong> {CELL_GAP.rim.what}. <strong>Texture:</strong>{' '}
                {CELL_GAP.texture.what}.
              </p>
              <p>
                Close / Partial / Far sums up every measure of that danger. Hover a cell for its × figure: {TIMES_LINE}.
              </p>
            </InfoTip>
          </span>
          {sample && <SampleChip what="This ranking" />}
        </div>
        <div className="table-scroll">
          <table className="fit-grid">
            <thead>
              <tr>
                <th className="r" scope="col">
                  #
                </th>
                <th scope="col">Region</th>
                {HAZARD_IDS.map((h: HazardId) => (
                  <th key={h} scope="col">
                    <span className="th-hz">
                      <HazardGlyph hazard={h} />
                      {ROW_NAME[h]}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ranking.map((r: RankingRow) => (
                <tr key={r.region_id}>
                  <td className="r fit-rank">{r.rank}</td>
                  <th scope="row" className="fit-region" title={r.reason}>
                    <span className="fit-region-name">{regionName(r.region_id)}</span>
                  </th>
                  {HAZARD_IDS.map((h: HazardId) => {
                    const d = r.per_hazard_best_distance?.[h];
                    const f = distanceFit(d);
                    const gap = cellGap(core, r, h);
                    const word = f ? (f === 'green' ? 'close' : f === 'amber' ? 'partial' : 'far') : 'no data';
                    return (
                      <td key={h}>
                        <button
                          type="button"
                          className="fit-cell"
                          title={`${HAZARDS[h].name}: best Earth match ${gap ?? 'gap not available'} (${CELL_GAP[h].what}). ${fmtSpread(d)} · ${TIMES_LINE}.`}
                          aria-label={`${regionName(r.region_id)}, ${HAZARDS[h].name}: ${word}${gap ? `, ${gap}` : ''} (${fmtSpread(d)} spread). Open Earth matches.`}
                          onClick={(): void => open(r.region_id, h)}
                        >
                          {f ? <Fit fit={f} /> : <span className="faint">—</span>}
                          {gap && <span className="fit-dist">{gap}</span>}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {close.n > 0 && (
          <div className="why-row sum-close">
            <span>
              <strong>How close?</strong> Typical gap of the #1 Earth match: {close.gaps.map((g) => g.text).join(', ')} · {close.nClose} of {close.n}{' '}
              close
            </span>
          </div>
        )}
        {summary.patchiness && summary.patchiness.n_top1 > 0 && (
          <div className="why-row sum-close sum-patch">
            <span>
              {summary.patchiness.n_similar_headline} of {summary.patchiness.n_top1} also vary about as much as their Moon site
            </span>
            <InfoTip label="What does ‘vary as much’ mean?" title="Patchiness">
              <p>We also check whether the Earth square varies across its 25 patches as much as the Moon site does.</p>
            </InfoTip>
          </div>
        )}
      </section>

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
