import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { HAZARDS, ROW_NAME, VALIDATION_TARGETS, distanceFit, meetsTarget, type ValidationTarget } from '../content';
import { Fit, HazardGlyph, VerdictGlyph } from '../components/Glyphs';
import { SampleChip, ScreenHead } from '../components/ScreenHead';
import { loadOptionalJson } from '../data/loader';
import { useApp, type CoreData } from '../store';
import { HAZARD_IDS, isTransectsFile, type HazardId, type Light, type Meta, type RankingRow } from '../types/contract';
import { CreditsPanel } from '../components/Credits';
import { buildCredits, hasNasademCheck } from '../lib/credits';
import { featureName } from '../lib/plain';

/** Best-match distance to a fit class (shared bands; see distanceFit in content.ts). */
function distFit(d: number | undefined): Light | null {
  return distanceFit(d);
}

/** Lifts dots that would overlap their neighbour onto a second row, so all nine stay visible. */
function stackDots(entries: [string, number][]): { id: string; value: number; row: number }[] {
  const sorted = [...entries].sort((a: [string, number], b: [string, number]): number => a[1] - b[1]);
  let prev = -Infinity;
  let prevRow = 1;
  return sorted.map(([id, value]: [string, number]) => {
    const row = value - prev < 0.025 && prevRow === 0 ? 1 : 0;
    prev = value;
    prevRow = row;
    return { id, value, row };
  });
}

function fmt(v: number | undefined, d: number = 2): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—';
}

function Credits({ metas, nasadem }: { metas: { file: string; meta: Meta }[]; nasadem: boolean }): JSX.Element {
  const versions = Array.from(new Set(metas.map((m) => m.meta.pipeline_version))).join(', ');
  return (
    <CreditsPanel
      id="credits-h"
      credits={buildCredits(metas, { nasadem })}
      intro={<>Every source the results on these screens depend on, merged with the sources each data file lists. Pipeline version: {versions || 'unknown'}.</>}
    >
      <li>
        <strong>Failure accounts</strong> · ispace (26 May 2023); Intuitive Machines earnings call (13 May 2025), as reported by The Register (14 May
        2025); NASA JPL (11 Dec 2024)
      </li>
    </CreditsPanel>
  );
}

/** Plain-language list of the classifier's most telling features, with importances in a tooltip. */
function topFeatures(list: (string | { feature: string; importance: number })[]): { text: string; title: string } {
  const items = list.slice(0, 3).map((f) => (typeof f === 'string' ? { feature: f, importance: null } : f));
  return {
    text: items.map((f) => featureName(f.feature)).join(', '),
    title: items.map((f) => `${f.feature}${typeof f.importance === 'number' ? ` (${f.importance.toFixed(3)})` : ''}`).join(', '),
  };
}

/** A 0–1 scale with the target zone shaded and this value marked. */
function Band({ value, target }: { value: number | undefined; target: ValidationTarget }): JSX.Element {
  const lo = target.min ?? 0;
  const hi = target.max ?? 1;
  const v = typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : null;
  return (
    <div className="band" aria-hidden="true">
      <div className="band-track" />
      <div className="band-target" style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` }} />
      {v !== null && <div className="band-marker" style={{ left: `${v * 100}%` }} />}
      <span className="band-tick band-tick-0">0</span>
      <span className="band-tick band-tick-1">1</span>
    </div>
  );
}

/** A validation figure. Sample values look real, so they always carry the chip right beside the number. */
function ValueWithChip({ sample, children }: { sample: boolean; children: ReactNode }): JSX.Element {
  return (
    <span className="val-value-wrap">
      <span className="val-value">{children}</span>
      {sample && <SampleChip what="This figure and the others on this panel" />}
    </span>
  );
}

function Check({
  title,
  help,
  term,
  value,
  digits = 2,
  target,
  sample,
  children,
}: {
  sample: boolean;
  title: string;
  help: string;
  /** Technical name of the statistic, shown as a tooltip. */
  term?: string;
  value: number | undefined;
  digits?: number;
  target: ValidationTarget;
  children?: JSX.Element | null;
}): JSX.Element {
  const ok = meetsTarget(value, target);
  return (
    <div className="val-block">
      <div className="val-head">
        <div>
          <h3>{title}</h3>
          <p className="caption" title={term}>
            {help}
          </p>
        </div>
        <ValueWithChip sample={sample}>{fmt(value, digits)}</ValueWithChip>
      </div>
      <Band value={value} target={target} />
      <p className="val-status">
        {ok === null ? (
          <span className="muted">Not available yet</span>
        ) : (
          <span className="val-verdict" data-ok={ok}>
            <VerdictGlyph kind={ok ? 'pass' : 'fail'} />
            {ok ? 'Meets target' : 'Below target'}
          </span>
        )}
        <span className="caption">{target.text}</span>
      </p>
      {children}
    </div>
  );
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
  const tests = v.synthetic_tests ?? [];
  const testsPassed = tests.filter((t) => t.passed).length;
  const checks: (boolean | null)[] = [
    meetsTarget(v.shadow_vs_pgda?.pearson_r, VALIDATION_TARGETS.shadow_r),
    meetsTarget(v.known_vs_decoy_auc, VALIDATION_TARGETS.decoy_auc),
    meetsTarget(v.weight_stability_jaccard, VALIDATION_TARGETS.jaccard),
    tests.length ? testsPassed === tests.length : null,
  ];
  const known = checks.filter((c): c is boolean => c !== null);
  const passed = known.filter((c: boolean): boolean => c).length;
  const sample = core.summaryOrigin !== 'data';
  const aucs = Object.entries(v.classifier_two_sample?.per_region_auc ?? {});
  const open = (regionId: string, h: HazardId): void => {
    setRegion(regionId);
    setHazard(h);
    setScreen('region');
  };

  return (
    <div>
      <ScreenHead
        kicker="Summary and validation"
        chips={core.summaryOrigin === 'mock' ? <SampleChip what="Ranking and validation figures" /> : null}
        result={
          easiest && hardest
            ? `${regionName(easiest.region_id)} is the easiest region to rehearse on Earth; ${regionName(hardest.region_id)} the hardest`
            : 'No ranking yet'
        }
        method={
          <p>
            Regions are ranked by how close the best Earth match comes for each of the 3 dangers. Distances are in multiples of the Moon
            region’s normal variation (its interquartile range): under 0.5 is close, 0.5 to 1.5 partial, 1.5 or more far. The same bands
            colour the grid and word the reasons.
          </p>
        }
      />

      <div className="summary-layout">
        <section className="panel" aria-labelledby="grid-h">
          <div className="panel-head">
            <h2 id="grid-h">Best Earth match, region by danger</h2>
            <span className="caption">Easiest to hardest. Select a cell to open its Earth matches.</span>
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
                    <th scope="row" className="fit-region">
                      <span className="fit-region-name">{regionName(r.region_id)}</span>
                      <span className="caption">{r.reason}</span>
                    </th>
                    {HAZARD_IDS.map((h: HazardId) => {
                      const d = r.per_hazard_best_distance?.[h];
                      const f = distFit(d);
                      return (
                        <td key={h}>
                          <button
                            type="button"
                            className="fit-cell"
                            title={`${HAZARDS[h].name}: best match ${fmt(d)} × the Moon region’s normal variation away (0 = identical)`}
                            aria-label={`${regionName(r.region_id)}, ${HAZARDS[h].name}: ${f ? (f === 'green' ? 'close' : f === 'amber' ? 'partial' : 'far') : 'no data'}. Open Earth matches.`}
                            onClick={(): void => open(r.region_id, h)}
                          >
                            {f ? <Fit fit={f} /> : <span className="faint">—</span>}
                            <span className="fit-dist">{fmt(d)}</span>
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel" aria-labelledby="val-h">
          <div className="panel-head">
            <h2 id="val-h">Validation</h2>
            <span className="val-summary">
              {known.length ? `${passed} of ${known.length} checks meet their targets` : 'No checks available yet'}
              {sample ? ' (sample values, not results)' : ''}
            </span>
          </div>
          <Check
            title="Shadows vs NASA PGDA illumination"
            help="Agreement with NASA’s map (1 = perfect): our shadow share against NASA PGDA’s illumination map."
            term={v.shadow_vs_pgda?.note ? `Pearson correlation. ${v.shadow_vs_pgda.note}` : 'Pearson correlation'}
            value={v.shadow_vs_pgda?.pearson_r}
            target={VALIDATION_TARGETS.shadow_r}
            sample={sample}
          >
            <dl className="kv">
              <dt>Mean absolute error</dt>
              <dd>{fmt(v.shadow_vs_pgda?.mae, 3)}</dd>
              <dt>Bias</dt>
              <dd>{fmt(v.shadow_vs_pgda?.bias, 3)}</dd>
              <dt>Pixels compared</dt>
              <dd>{typeof v.shadow_vs_pgda?.n_px === 'number' ? v.shadow_vs_pgda.n_px.toLocaleString('en-US') : '—'}</dd>
            </dl>
          </Check>
          <Check
            title="Known analogs rank above decoys"
            help="Chance a known analog outranks a decoy such as dune fields, farmland or forest (0.50 = coin flip)."
            term="ROC-AUC"
            value={v.known_vs_decoy_auc}
            target={VALIDATION_TARGETS.decoy_auc}
            sample={sample}
          />
          <Check
            title="Top 3 stay put when weights move ±20%"
            help="How much the top 3 stay the same when the weights are nudged (1 = identical lists)."
            term="Jaccard index"
            value={v.weight_stability_jaccard}
            target={VALIDATION_TARGETS.jaccard}
            sample={sample}
          />
          <div className="val-block">
            <div className="val-head">
              <div>
                <h3>Synthetic tests</h3>
                <p className="caption">Known-answer terrains run through the same code.</p>
              </div>
              <ValueWithChip sample={sample}>
                {testsPassed}/{tests.length}
              </ValueWithChip>
            </div>
            <ul className="test-list">
              {tests.map((t) => (
                <li key={t.name}>
                  <span>{t.name.replace(/_/g, ' ')}</span>
                  <span className="val-verdict" data-ok={t.passed}>
                    <VerdictGlyph kind={t.passed ? 'pass' : 'fail'} />
                    {t.passed ? 'Passed' : 'Failed'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          {aucs.length > 0 && (
            <div className="val-block">
              <div className="val-head">
                <div>
                  <h3>Can a computer tell Moon from Earth terrain?</h3>
                  <p className="caption" title="Classifier two-sample test (AUC), per region">
                    0.5 = it can’t tell them apart; 1 = it always can. One dot per region. Shown for context, no target.
                  </p>
                </div>
                {sample && <SampleChip what="These values" />}
              </div>
              <div
                className="auc-strip"
                role="img"
                aria-label={`Classifier AUC per region, from ${fmt(Math.min(...aucs.map((a) => a[1])))} to ${fmt(Math.max(...aucs.map((a) => a[1])))}`}
              >
                <div className="band-track" />
                {stackDots(aucs).map(({ id, value, row }) => (
                  <span
                    key={id}
                    className="auc-dot"
                    style={{ left: `${Math.min(Math.max((value - 0.5) / 0.5, 0), 1) * 100}%`, top: `${4 - row * 9}px` }}
                    title={`${regionName(id)}: ${fmt(value)}`}
                  />
                ))}
                <span className="band-tick band-tick-0">0.5</span>
                <span className="band-tick band-tick-1">1</span>
              </div>
              <details className="method">
                <summary>Per-region values</summary>
                <dl className="kv method-body">
                  {aucs.map(([k, auc]: [string, number]) => (
                    <div key={k} className="kv-row">
                      <dt>{regionName(k)}</dt>
                      <dd>{fmt(auc)}</dd>
                    </div>
                  ))}
                </dl>
                {v.classifier_two_sample.top_features.length > 0 && (
                  <p className="caption" title={topFeatures(v.classifier_two_sample.top_features).title}>
                    What gives the Earth terrain away most: {topFeatures(v.classifier_two_sample.top_features).text}
                  </p>
                )}
              </details>
            </div>
          )}
          <div className="val-block">
            <h3>Where it fails</h3>
            <ul className="fails">
              {v.where_it_fails.map((w: string) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        </section>
      </div>
      <Credits metas={metas} nasadem={nasadem} />
    </div>
  );
}
