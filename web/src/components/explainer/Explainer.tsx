// "How we find Earth analogs": six plain-language steps, one big visual each.
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { loadOptionalJson, type Loaded } from '../../data/loader';
import { loadTile, type LoadedTile } from '../../data/tiles';
import { metricInfo } from '../../content';
import { useApp } from '../../store';
import { isMethodFile, type MethodFile, type MethodFunnelRow, type MethodPoint, type MethodValSite } from '../../types/contract';
import { HazardGlyph, type HazardKey } from '../Glyphs';
import { Loading } from '../Loading';
import type { Overlay } from './MoonTile3D';

const MoonTile3D = lazy(() => import('./MoonTile3D'));

const nf = new Intl.NumberFormat('en-US');

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** False on the first frame, then true: lets bars grow in from zero (instantly with reduced motion). */
function useEntered(): boolean {
  const [on, setOn] = useState<boolean>(false);
  useEffect((): (() => void) => {
    const id = requestAnimationFrame((): void => setOn(true));
    return (): void => cancelAnimationFrame(id);
  }, []);
  return on;
}

/** True once the element has come near the viewport (and stays true). */
function useNearViewport(ref: React.RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState<boolean>(false);
  useEffect((): (() => void) | void => {
    const el = ref.current;
    if (!el || near) return;
    const io = new IntersectionObserver(
      (entries: IntersectionObserverEntry[]): void => {
        if (entries.some((e: IntersectionObserverEntry): boolean => e.isIntersecting)) setNear(true);
      },
      { rootMargin: '200px 0px' },
    );
    io.observe(el);
    return (): void => io.disconnect();
  }, [ref, near]);
  return near;
}

// ------------------------------------------------------------------------------------------------
// Step 1: Moon tile with overlays
// ------------------------------------------------------------------------------------------------

const OVERLAYS: { id: Overlay; label: string }[] = [
  { id: 'slope', label: 'Steepness' },
  { id: 'shadow', label: 'Shadow at 3° sun' },
  { id: 'rim', label: 'Crater-rim drop' },
  { id: 'texture', label: 'Camera texture' },
];

function useExampleTile(regionId: string | null): { tile: LoadedTile | null; name: string } {
  const core = useApp((s) => s.core);
  const region = core
    ? (core.regions.find((r) => r.id === regionId) ?? core.regions.find((r) => r.id === 'malapert_massif') ?? core.regions[0])
    : null;
  const [tile, setTile] = useState<LoadedTile | null>(null);
  useEffect((): (() => void) | void => {
    if (!region || !core) return;
    let alive = true;
    loadTile(region.tile, core.regionsOrigin)
      .then((t: LoadedTile): void => {
        if (alive) setTile(t);
      })
      .catch((): void => undefined);
    return (): void => {
      alive = false;
    };
  }, [region, core]);
  return { tile, name: region?.name ?? '' };
}

function OverlayButtons({ overlay, onPick }: { overlay: Overlay; onPick: (o: Overlay) => void }): JSX.Element {
  return (
    <div className="overlay-buttons" role="group" aria-label="What we measure">
      {OVERLAYS.map((o) => (
        <button key={o.id} type="button" className="btn btn-sm" aria-pressed={overlay === o.id} onClick={(): void => onPick(o.id)}>
          <HazardGlyph hazard={o.id} />
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Steps 2–3: world dots
// ------------------------------------------------------------------------------------------------

function WorldDots({ points, phase, active }: { points: MethodPoint[]; phase: 'sample' | 'filter'; active: boolean }): JSX.Element {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState<number>(800);
  useEffect((): (() => void) | void => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver((e: ResizeObserverEntry[]): void => {
      const cw = e[0]?.contentRect.width;
      if (cw) setW(Math.floor(cw));
    });
    ro.observe(el);
    return (): void => ro.disconnect();
  }, []);
  const h = Math.round(w * 0.5);

  useEffect((): (() => void) | void => {
    const cv = canvas.current;
    if (!cv || !active) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const x = (lon: number): number => ((lon + 180) / 360) * w;
    const y = (lat: number): number => ((90 - lat) / 180) * h;
    const r = Math.max(1, w / 900);

    const frame = (p: number): void => {
      ctx.fillStyle = '#121419';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(237, 234, 228, 0.07)';
      ctx.lineWidth = 1;
      for (let lon = -150; lon <= 150; lon += 30) {
        ctx.beginPath();
        ctx.moveTo(x(lon), 0);
        ctx.lineTo(x(lon), h);
        ctx.stroke();
      }
      for (let lat = -60; lat <= 60; lat += 30) {
        ctx.beginPath();
        ctx.moveTo(0, y(lat));
        ctx.lineTo(w, y(lat));
        ctx.stroke();
      }
      if (phase === 'sample') {
        const k = Math.round(points.length * p);
        ctx.fillStyle = 'rgba(237, 234, 228, 0.85)';
        for (let i = 0; i < k; i++) {
          const pt = points[i];
          ctx.fillRect(x(pt.lon) - r, y(pt.lat) - r, r * 2, r * 2);
        }
      } else {
        // thrown-out squares fade to a faint outline; kept ones stay bright
        const fade = 0.85 - 0.7 * p;
        ctx.fillStyle = `rgba(111, 107, 100, ${fade.toFixed(3)})`;
        for (const pt of points) if (!pt.pass) ctx.fillRect(x(pt.lon) - r, y(pt.lat) - r, r * 2, r * 2);
        ctx.fillStyle = 'rgba(237, 234, 228, 0.9)';
        for (const pt of points) if (pt.pass) ctx.fillRect(x(pt.lon) - r, y(pt.lat) - r, r * 2, r * 2);
      }
    };

    if (prefersReducedMotion()) {
      frame(1);
      return;
    }
    const dur = phase === 'sample' ? 1800 : 1000;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number): void => {
      const t = Math.min(1, (now - t0) / dur);
      frame(1 - Math.pow(1 - t, 3));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return (): void => cancelAnimationFrame(raf);
  }, [points, phase, active, w, h]);

  const kept = points.filter((p: MethodPoint): boolean => p.pass).length;
  return (
    <div ref={wrap} className="ex-world">
      <canvas
        ref={canvas}
        role="img"
        aria-label={
          phase === 'sample'
            ? `World map with ${nf.format(points.length)} sampled squares`
            : `World map: ${nf.format(kept)} bare squares kept, ${nf.format(points.length - kept)} thrown out`
        }
      />
      <div className="ex-world-legend">
        {phase === 'sample' ? (
          <span className="legend-item">
            <span className="dot-key" aria-hidden="true" />
            {nf.format(points.length)} sample squares
          </span>
        ) : (
          <>
            <span className="legend-item">
              <span className="dot-key" aria-hidden="true" />
              {nf.format(kept)} kept
            </span>
            <span className="legend-item">
              <span className="dot-key dot-key-dim" aria-hidden="true" />
              {nf.format(points.length - kept)} thrown out
            </span>
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Step 4: fingerprints
// ------------------------------------------------------------------------------------------------

function Fingerprint({ method, siteName, regionName }: { method: MethodFile; siteName: string; regionName: string }): JSX.Element {
  const ex = method.example;
  const keys = Object.keys(ex.moon).filter((k: string): boolean => typeof ex.earth[k] === 'number');
  const hz: HazardKey = ex.hazard === 'shadow' || ex.hazard === 'rim' || ex.hazard === 'texture' ? ex.hazard : 'slope';
  const on = useEntered();
  return (
    <div className="ex-finger">
      <div className="ex-finger-head">
        <span className="legend-item">
          <span className="bar-key" aria-hidden="true" />
          Moon · {regionName}
        </span>
        <span className="legend-item">
          <span className="bar-key bar-key-earth" aria-hidden="true" />
          Earth · {siteName}
        </span>
      </div>
      <ul className="ex-finger-rows">
        {keys.map((k: string) => {
          const mi = metricInfo(k);
          const m = ex.moon[k];
          const e = ex.earth[k];
          const max = Math.max(Math.abs(m), Math.abs(e)) || 1;
          return (
            <li key={k}>
              <span className="ex-finger-label">
                <HazardGlyph hazard={hz} />
                {mi.label}
              </span>
              <span className="ex-bars">
                <span className="ex-bar" style={{ transform: `scaleX(${on ? Math.abs(m) / max : 0})` }} />
                <span className="ex-bar ex-bar-earth" style={{ transform: `scaleX(${on ? Math.abs(e) / max : 0})` }} />
              </span>
              <span className="ex-finger-vals">
                <span>{mi.fmt(m)}</span>
                <span className="muted">{mi.fmt(e)}</span>
              </span>
            </li>
          );
        })}
      </ul>
      <p className="caption">Each metric is compared on its own. There is no single “% Moon-like” score.</p>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Step 5: funnel
// ------------------------------------------------------------------------------------------------

const STAGE_LABEL: Record<string, string> = {
  sampled: 'Bare-land squares sampled',
  dsm_safe: 'No trees, cities, farms or ice',
  stage1_top: 'Shortlist from the quick comparison',
  stage2: 'Checked in detail',
  final_top3: 'Top 3 for each danger and region',
};

function Funnel({ rows }: { rows: MethodFunnelRow[] }): JSX.Element {
  const max = Math.max(...rows.map((r: MethodFunnelRow): number => r.n), 1);
  const on = useEntered();
  return (
    <ol className="ex-funnel">
      {rows.map((r: MethodFunnelRow, i: number) => (
        <li key={r.stage}>
          <span className="ex-funnel-track" aria-hidden="true">
            <span
              className="ex-funnel-bar"
              style={{ transform: `scaleX(${on ? Math.max(0.03, Math.sqrt(r.n / max)) : 0})`, transitionDelay: `${i * 90}ms` }}
            />
          </span>
          <span className="ex-funnel-n">{nf.format(r.n)}</span>
          <span className="ex-funnel-label">{STAGE_LABEL[r.stage] ?? r.stage.replace(/_/g, ' ')}</span>
        </li>
      ))}
    </ol>
  );
}

// ------------------------------------------------------------------------------------------------
// Step 6: known analogs vs decoys
// ------------------------------------------------------------------------------------------------

function StripPlot({ method }: { method: MethodFile }): JSX.Element {
  const v = method.validation;
  const W = 640;
  const H = 168;
  const x = (pct: number): number => 24 + (Math.min(Math.max(pct, 0), 100) / 100) * (W - 48);
  const rowY = { known: 54, decoys: 118 };
  const jitter = (i: number): number => ((i * 7) % 5) * 4 - 8;
  const dot = (s: MethodValSite, i: number, kind: 'known' | 'decoys'): JSX.Element => (
    <circle key={s.id} cx={x(s.best_rank_pct)} cy={rowY[kind] + jitter(i)} r="6" className={kind === 'known' ? 'sp-known' : 'sp-decoy'}>
      <title>
        {s.name}: best rank in the top {s.best_rank_pct.toFixed(1)}%
      </title>
    </circle>
  );
  return (
    <div className="ex-strip">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Known Moon-training sites: median best rank top ${v.known_median_pct.toFixed(1)}%. Decoys: median ${v.decoy_median_pct.toFixed(0)}%.`}
      >
        <line x1={x(0)} x2={x(100)} y1={H - 22} y2={H - 22} className="sp-axis" />
        {[0, 25, 50, 75, 100].map((t: number) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={H - 26} y2={H - 18} className="sp-axis" />
            <text x={x(t)} y={H - 4} textAnchor="middle" className="sp-tick">
              {t === 0 ? 'top' : `${t}%`}
            </text>
          </g>
        ))}
        <text x={x(0)} y={rowY.known - 22} className="sp-row">
          Known Moon-training sites
        </text>
        <text x={x(0)} y={rowY.decoys - 22} className="sp-row">
          Decoys: farmland, forest, cities, dunes
        </text>
        <line x1={x(v.known_median_pct)} x2={x(v.known_median_pct)} y1={rowY.known - 14} y2={rowY.known + 14} className="sp-median" />
        <line x1={x(v.decoy_median_pct)} x2={x(v.decoy_median_pct)} y1={rowY.decoys - 14} y2={rowY.decoys + 14} className="sp-median" />
        {v.known.map((s: MethodValSite, i: number) => dot(s, i, 'known'))}
        {v.decoys.map((s: MethodValSite, i: number) => dot(s, i, 'decoys'))}
      </svg>
      <p className="caption">
        Where each site’s best match ranks among all Earth squares; left is better. Lines mark the middle site of each group. A known site
        beats a decoy {Math.round(v.auc * 100)} times in 100 (AUC {v.auc.toFixed(2)}).
      </p>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// The explainer
// ------------------------------------------------------------------------------------------------

interface Step {
  title: string;
  short: string;
  body: (m: MethodFile | null) => string;
}

const STEPS: Step[] = [
  {
    title: 'Turn a Moon site into numbers',
    short: 'Measure',
    body: (): string =>
      'We measure the 4 dangers that hurt real landers: steep ground, long shadows from a low sun, sudden drops at crater rims, and smooth ground a camera can’t track.',
  },
  {
    title: 'Sample bare land across Earth',
    short: 'Sample',
    body: (m): string =>
      `We pick ${m ? nf.format(m.screen.n_screened) : 'thousands of'} squares of 15 × 15 km at random, spread across latitudes and terrain types.`,
  },
  {
    title: 'Throw out trees, cities, farms and ice',
    short: 'Filter',
    body: (): string =>
      'Our elevation data sees treetops and rooftops, so those squares would fake the terrain. Only bare ground stays in.',
  },
  {
    title: 'Compare fingerprints',
    short: 'Compare',
    body: (): string => 'Every square gets the same numbers as the Moon site. The closer the numbers, the better the match.',
  },
  {
    title: 'Shortlist, then check in detail',
    short: 'Shortlist',
    body: (): string =>
      'A quick comparison narrows thousands of squares to a shortlist. The shortlist gets the full, slower check, and we keep the top 3 for each danger.',
  },
  {
    title: 'Prove it works',
    short: 'Check',
    body: (): string => 'Known Moon-training sites rank near the top; farmland and forest don’t.',
  },
];

export function Explainer(): JSX.Element {
  const ref = useRef<HTMLElement>(null);
  const near = useNearViewport(ref);
  const [step, setStep] = useState<number>(0);
  const [overlay, setOverlay] = useState<Overlay>('slope');
  const [userPicked, setUserPicked] = useState<boolean>(false);
  const [method, setMethod] = useState<Loaded<MethodFile> | null>(null);
  const [methodState, setMethodState] = useState<'loading' | 'ready' | 'missing'>('loading');
  const core = useApp((s) => s.core);

  useEffect((): void => {
    if (!near) return;
    loadOptionalJson('method.json', isMethodFile)
      .then((m): void => {
        setMethod(m);
        setMethodState(m ? 'ready' : 'missing');
      })
      .catch((): void => setMethodState('missing'));
  }, [near]);

  const m = method?.value ?? null;
  const ex = useExampleTile(m?.example.region_id ?? null);

  // Cycle the step-1 overlays until the visitor picks one (not with reduced motion).
  useEffect((): (() => void) | void => {
    if (step !== 0 || userPicked || !near || prefersReducedMotion()) return;
    const id = window.setInterval((): void => {
      setOverlay((o: Overlay): Overlay => OVERLAYS[(OVERLAYS.findIndex((x) => x.id === o) + 1) % OVERLAYS.length].id);
    }, 3500);
    return (): void => window.clearInterval(id);
  }, [step, userPicked, near]);

  const siteName = useMemo((): string => {
    if (!m) return '';
    return core?.siteById.get(m.example.site_id)?.name ?? m.example.site_id;
  }, [m, core]);
  const regionName = useMemo((): string => {
    if (!m) return '';
    return core?.regions.find((r) => r.id === m.example.region_id)?.name ?? m.example.region_id.replace(/_/g, ' ');
  }, [m, core]);

  const s = STEPS[step];
  const needsMethod = step > 0;

  let visual: JSX.Element;
  if (step === 0) {
    visual =
      near && ex.tile ? (
        <Suspense fallback={<Loading label="Loading the 3D view…" />}>
          <MoonTile3D tile={ex.tile} overlay={overlay} regionName={ex.name} />
        </Suspense>
      ) : (
        <Loading label="Loading a Moon tile…" />
      );
  } else if (!m) {
    visual =
      methodState === 'loading' ? (
        <Loading label="Loading the method data…" />
      ) : (
        <p className="muted ex-missing">method.json is not available yet.</p>
      );
  } else if (step === 1 || step === 2) {
    visual = <WorldDots points={m.points} phase={step === 1 ? 'sample' : 'filter'} active={near} />;
  } else if (step === 3) {
    visual = <Fingerprint method={m} siteName={siteName} regionName={regionName} />;
  } else if (step === 4) {
    visual = <Funnel rows={m.funnel} />;
  } else {
    visual = <StripPlot method={m} />;
  }

  return (
    <section ref={ref} id="how-we-find-analogs" className="explainer" aria-labelledby="explainer-h">
      <div className="explainer-head">
        <h2 id="explainer-h">How we find Earth analogs</h2>
        <p className="muted">
          Six steps, no jargon.{method?.origin === 'mock' ? ' The numbers below are sample data until the pipeline finishes.' : ''}
        </p>
      </div>
      <ol className="ex-rail" aria-label="Steps">
        {STEPS.map((st: Step, i: number) => (
          <li key={st.title}>
            <button type="button" className="ex-rail-btn" aria-current={i === step ? 'step' : undefined} onClick={(): void => setStep(i)}>
              <span className="ex-rail-n">{i + 1}</span>
              <span className="ex-rail-label">{st.short}</span>
            </button>
          </li>
        ))}
      </ol>
      <div className="ex-body">
        <div className="ex-visual" aria-live="polite">
          {visual}
        </div>
        <div className="ex-text">
          <p className="ex-count">
            Step {step + 1} of {STEPS.length}
          </p>
          <h3 className="ex-title">{s.title}</h3>
          <p className="ex-copy">{s.body(m)}</p>
          {step === 0 && (
            <OverlayButtons
              overlay={overlay}
              onPick={(o: Overlay): void => {
                setUserPicked(true);
                setOverlay(o);
              }}
            />
          )}
          {needsMethod && m && step === 1 && (
            <p className="caption">
              From {nf.format(m.screen.n_draws)} random points, {nf.format(m.screen.n_land)} fell on land. The final sample covers{' '}
              {nf.format(m.screen.coverage_km2)} km².
            </p>
          )}
          <div className="ex-nav">
            <button type="button" className="btn" disabled={step === 0} onClick={(): void => setStep(step - 1)}>
              ← Back
            </button>
            <button type="button" className="btn" disabled={step === STEPS.length - 1} onClick={(): void => setStep(step + 1)}>
              Next →
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
