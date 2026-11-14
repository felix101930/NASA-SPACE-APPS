import { useEffect, useState, type JSX } from 'react';
import { HAZARDS } from '../content';
import { HZ_VAR } from '../components/DangerProfile';
import { loadOptionalJson } from '../data/loader';
import { useApp, type CoreData } from '../store';
import { HAZARD_IDS, isTransectsFile, type HazardId, type Meta, type RankingRow, type Source } from '../types/contract';

function distLight(d: number): { cls: string; word: string } {
  if (d < 0.5) return { cls: 'light-green', word: 'close' };
  if (d < 1.5) return { cls: 'light-amber', word: 'partial' };
  return { cls: 'light-red', word: 'far' };
}

function fmt(v: number | undefined, d: number = 2): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—';
}

function Credits({ metas }: { metas: { file: string; meta: Meta }[] }): JSX.Element {
  const seen = new Map<string, { s: Source; files: string[] }>();
  for (const { file, meta } of metas) {
    for (const s of meta.sources) {
      const key = `${s.name}|${s.url}`;
      const hit = seen.get(key);
      if (hit) hit.files.push(file);
      else seen.set(key, { s, files: [file] });
    }
  }
  const versions = Array.from(new Set(metas.map((m) => m.meta.pipeline_version))).join(', ');
  return (
    <section className="panel panel-pad credits" aria-labelledby="credits-h">
      <h2 id="credits-h" style={{ fontSize: 18, marginBottom: 4 }}>
        Data credits and licences
      </h2>
      <p className="faint" style={{ fontSize: 13, marginBottom: 12 }}>
        Collected from the <code>meta.sources</code> block of every loaded file. Pipeline version: {versions || 'unknown'}.
      </p>
      <ul>
        {Array.from(seen.values()).map(({ s, files }) => (
          <li key={`${s.name}|${s.url}`}>
            <strong style={{ color: 'var(--text)' }}>{s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.name}</a> : s.name}</strong>
            {s.licence ? ` · ${s.licence}` : ''}
            {s.citation ? ` · ${s.citation}` : ''} <span className="faint">({files.join(', ')})</span>
          </li>
        ))}
        <li>
          <strong style={{ color: 'var(--text)' }}>Basemap</strong> · OpenFreeMap (positron style), OpenMapTiles, © OpenStreetMap contributors (ODbL)
        </li>
        <li>
          <strong style={{ color: 'var(--text)' }}>Failure accounts</strong> · ispace (26 May 2023); Intuitive Machines earnings call, May 2025, via The Register; NASA JPL (11 Dec 2024)
        </li>
      </ul>
    </section>
  );
}

export function Summary(): JSX.Element {
  const core = useApp((s) => s.core) as CoreData;
  const setRegion = useApp((s) => s.setRegion);
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

  if (!summary) {
    return (
      <div>
        <div className="error-box">summary.json is not available yet from the pipeline or the mock set.</div>
        <Credits metas={metas} />
      </div>
    );
  }
  const v = summary.validation;
  const ranking = [...summary.ranking].sort((a: RankingRow, b: RankingRow): number => a.rank - b.rank);

  return (
    <div>
      <div className="screen-head">
        <div>
          <h1 style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            Easiest to hardest to rehearse on Earth
            {core.summaryOrigin === 'mock' && <span className="chip chip-warn" style={{ fontSize: 13 }}>Mock ranking</span>}
          </h1>
          <p>
            Ranked by how close the best Earth match comes for each hazard. Distances are in units of the Moon region’s own
            spread (interquartile range): under 0.5 is close, over 1.5 is far.
          </p>
        </div>
      </div>

      <div className="summary-layout">
        <section className="panel" aria-label="Region ranking">
          {ranking.map((r: RankingRow) => (
            <div className="rank-row" key={r.region_id}>
              <span className="rank">{r.rank}</span>
              <div>
                <h3>
                  <button
                    className="btn btn-sm"
                    style={{ background: 'none', border: 0, padding: 0, fontSize: 15, fontWeight: 600, textAlign: 'left' }}
                    onClick={(): void => {
                      setRegion(r.region_id);
                      setScreen('region');
                    }}
                  >
                    {regionName(r.region_id)}
                  </button>
                </h3>
                <div className="dist-chips">
                  {HAZARD_IDS.map((h: HazardId) => {
                    const d = r.per_hazard_best_distance[h];
                    const l = distLight(d);
                    return (
                      <span key={h} className="chip" title={`${HAZARDS[h].name}: best match ${fmt(d)} IQR away`}>
                        <span className="hz-dot" style={{ background: HZ_VAR[h] }} aria-hidden="true" />
                        {HAZARDS[h].short} <span className={`light ${l.cls}`} style={{ fontSize: 12 }}>{l.word}</span>
                      </span>
                    );
                  })}
                </div>
              </div>
              <p className="muted" style={{ fontSize: 14 }}>
                {r.reason}
              </p>
            </div>
          ))}
        </section>

        <section className="panel" aria-labelledby="val-h">
          <div className="val-block">
            <h2 id="val-h" style={{ fontSize: 18, display: 'flex', gap: 8, alignItems: 'center' }}>
              Validation
              {core.summaryOrigin === 'mock' && <span className="chip chip-warn">Mock values</span>}
            </h2>
            <p>How we check that the numbers mean what we say.</p>
          </div>
          <div className="val-block">
            <h3>Shadows vs NASA PGDA illumination maps</h3>
            <p>{v.shadow_vs_pgda.note}</p>
            <dl className="kv">
              <dt>Pearson r</dt>
              <dd>{fmt(v.shadow_vs_pgda.pearson_r)}</dd>
              <dt>Mean absolute error</dt>
              <dd>{fmt(v.shadow_vs_pgda.mae, 3)}</dd>
              <dt>Bias</dt>
              <dd>{fmt(v.shadow_vs_pgda.bias, 3)}</dd>
              <dt>Pixels compared</dt>
              <dd>{v.shadow_vs_pgda.n_px.toLocaleString('en-US')}</dd>
            </dl>
          </div>
          <div className="val-block">
            <h3>Known analogs vs decoys</h3>
            <p>Known analog sites held out from tuning should rank above decoys (deserts of dunes, farmland, forest).</p>
            <dl className="kv">
              <dt>ROC-AUC</dt>
              <dd>{fmt(v.known_vs_decoy_auc)}</dd>
              <dt>Top-3 stability under ±20% weights (Jaccard)</dt>
              <dd>{fmt(v.weight_stability_jaccard)}</dd>
            </dl>
          </div>
          <div className="val-block">
            <h3>Can a classifier tell Moon from Earth tiles?</h3>
            <p>Two-sample test: an AUC near 0.5 means the best Earth tiles are hard to tell apart from the Moon region.</p>
            <dl className="kv">
              {Object.entries(v.classifier_two_sample.per_region_auc).map(([k, auc]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt>{regionName(k)}</dt>
                  <dd>{fmt(auc)}</dd>
                </div>
              ))}
            </dl>
            {v.classifier_two_sample.top_features.length > 0 && (
              <p className="faint" style={{ fontSize: 12.5, marginTop: 8 }}>
                Most telling features: {v.classifier_two_sample.top_features.join(', ')}
              </p>
            )}
          </div>
          <div className="val-block">
            <h3>Synthetic tests</h3>
            <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13.5 }}>
              {v.synthetic_tests.map((t) => (
                <li key={t.name} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <span className="num">{t.name}</span>
                  <span className={`light ${t.passed ? 'light-green' : 'light-red'}`}>{t.passed ? 'passed' : 'failed'}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="val-block">
            <h3>Where it fails</h3>
            <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-2)', fontSize: 13.5, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {v.where_it_fails.map((w: string) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        </section>
      </div>
      <Credits metas={metas} />
    </div>
  );
}
