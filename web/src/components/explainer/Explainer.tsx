// "How we find Earth analogs": six plain-language steps, one big visual each.
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import { loadTile, type LoadedTile } from '../../data/tiles';
import { loadJsonFrom, type Loaded } from '../../data/loader';
import { listWords, metricInfo, NEW_PLACE_MIN_KM } from '../../content';
import { parseMethodExtras, type DocumentedSite, type MethodExtras } from '../../lib/methodExtras';
import { isFindbackRaw, parseFindback, type Findback } from '../../screens/walk/findback';
import { InfoTip } from '../InfoTip';
import { avgShadowAt } from '../../lib/shadow';
import { placeName } from '../../lib/placeName';
import { useApp } from '../../store';
import { type MethodFile, type MethodFunnelRow, type MethodPoint, type MethodValSite } from '../../types/contract';
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

function useExampleTile(regionId: string | null): { tile: LoadedTile | null; name: string; avgShadow3: number | null } {
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
  return { tile, name: region?.name ?? '', avgShadow3: region ? avgShadowAt(3, region.hazards.shadow.metrics) : null };
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

function WorldDots({
  points,
  phase,
  active,
  screened,
  coveragePct,
}: {
  points: MethodPoint[];
  phase: 'sample' | 'filter';
  active: boolean;
  screened: number;
  coveragePct: number | null;
}): JSX.Element {
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

  return (
    <div ref={wrap} className="ex-world">
      <canvas
        ref={canvas}
        role="img"
        aria-label={
          phase === 'sample'
            ? `World map of sampled squares: ${nf.format(screened)} screened, sampled from bare land`
            : 'World map: squares on bare ground kept, the rest thrown out'
        }
      />
      <div className="ex-world-legend">
        {phase === 'sample' ? (
          <>
            <span className="ex-stat">
              <strong>{nf.format(screened)}</strong> squares screened
            </span>
            {coveragePct !== null && (
              <span className="ex-stat">
                <strong>{coveragePct.toFixed(1)}%</strong> of bare land covered
              </span>
            )}
            <span className="ex-stat">
              <strong>2</strong> rounds
            </span>
          </>
        ) : (
          <>
            <span className="legend-item">
              <span className="dot-key" aria-hidden="true" />
              Kept: bare ground
            </span>
            <span className="legend-item">
              <span className="dot-key dot-key-dim" aria-hidden="true" />
              Thrown out
            </span>
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Step 4: terrain measurements
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
      <p className="ex-also">
        <span className="ex-chip">+ ground brightness</span>
        <span className="ex-chip">+ slope direction</span>
      </p>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Step 5: funnel
// ------------------------------------------------------------------------------------------------

const STAGE_LABEL: Record<string, string> = {
  sampled: 'Random points on land',
  dsm_safe: 'Bare ground to choose from',
  screened: 'Squares measured, two rounds',
  stage1_top: 'Shortlist after zooming in',
  stage2: 'Checked in detail at 30 m',
  final_top3: 'Places in a top 3',
};

/** The funnel rows plus the screened count (method.json keeps it in `screen`), placed by size. */
function withScreened(rows: MethodFunnelRow[], screened: number): MethodFunnelRow[] {
  if (rows.some((r: MethodFunnelRow): boolean => r.stage === 'screened')) return rows;
  const i = rows.findIndex((r: MethodFunnelRow): boolean => r.n < screened);
  if (i <= 0) return rows;
  return [...rows.slice(0, i), { stage: 'screened', n: screened }, ...rows.slice(i)];
}

function Funnel({ rows, moved }: { rows: MethodFunnelRow[]; moved: MethodExtras['refine'] }): JSX.Element {
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
          <span className="ex-funnel-label">
            {STAGE_LABEL[r.stage] ?? r.stage.replace(/_/g, ' ')}
            {r.stage === 'stage1_top' && moved && <span className="faint"> · {nf.format(moved.nMoved)} moves</span>}
          </span>
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
      <p className="caption">Best rank among all Earth squares; left is better. Dashed lines mark each group’s middle.</p>
    </div>
  );
}

function in100(v: number): string {
  return `${Math.round(v * 100)} in 100`;
}

function Scorecard({ x, findback, shadowR }: { x: MethodExtras; findback: Findback | null; shadowR: number | null }): JSX.Element {
  const firsts = x.documented?.sites.filter((s: DocumentedSite): boolean => s.rank === 1).map((s: DocumentedSite): string => s.name.replace(/ volcanic field$/i, '')) ?? [];
  const n = x.nasadem;
  const rs = n ? [n.shadowR, n.jumpR, n.slopeR].filter((v: number | null): v is number => v !== null) : [];
  return (
    <dl className="ex-score">
      {(x.aucIndependent ?? x.aucOriginal) !== null && (
        <div>
          <dt>Known analog beats a decoy</dt>
          <dd>
            <strong>{in100(x.aucIndependent ?? x.aucOriginal ?? 0)}</strong>
            <span className="faint">{x.aucIndependent !== null ? 'new, held-out sites' : 'original set'}</span>
          </dd>
        </div>
      )}
      {x.documented && (
        <div>
          <dt>Famous field sites</dt>
          <dd>
            <strong>
              {x.documented.nTop3 !== null ? `${x.documented.nTop3} of ${x.documented.nSites} reach a top 3` : `${x.documented.nSites} compared`}
            </strong>
            {firsts.length > 0 && <span className="faint">{listWords(firsts.slice(0, 4))} rank 1st in some searches</span>}
          </dd>
        </div>
      )}
      {rs.length > 0 && (
        <div>
          <dt>Second elevation map agrees</dt>
          <dd>
            <strong>r {rs.map((v: number): string => v.toFixed(2)).join(' · ')}</strong>
            <span className="faint">shadow · jump · slope; exact top 3 can change</span>
          </dd>
        </div>
      )}
      {findback?.top1 != null && (
        <div>
          <dt>Walk test: hidden copy found first</dt>
          <dd>
            <strong>{Math.round(findback.top1 * 100)}%</strong>
            <span className="faint">{findback.nRoutes ? `${nf.format(findback.nRoutes)} routes` : ''}</span>
          </dd>
        </div>
      )}
      {shadowR !== null && (
        <div>
          <dt>Shadows vs NASA’s map</dt>
          <dd>
            <strong>r {shadowR.toFixed(2)}</strong>
            <span className="faint">pixel by pixel</span>
          </dd>
        </div>
      )}
    </dl>
  );
}

// ------------------------------------------------------------------------------------------------
// The explainer
// ------------------------------------------------------------------------------------------------

interface StepCtx {
  m: MethodFile | null;
  x: MethodExtras | null;
  nRegions: number | null;
  findback: Findback | null;
  shadowR: number | null;
}

interface Step {
  title: string;
  short: string;
  /** One short sentence, about 20 words at most. Numbers belong in the visual. */
  body: (c: StepCtx) => string;
  /** Everything else, behind the "i" button. */
  info: (c: StepCtx) => ReactNode;
}

/** Two short lines per info box: why the choice fits the problem, and how accurate it is (docs/method-decisions.md). */
function WhyHow({ why, how }: { why: ReactNode; how: ReactNode }): JSX.Element {
  return (
    <>
      <p>
        <strong>Why it fits:</strong> {why}
      </p>
      <p>
        <strong>How accurate:</strong> {how}
      </p>
    </>
  );
}

function funnelRow(m: MethodFile | null, stage: string): MethodFunnelRow | undefined {
  return m?.funnel.find((r: MethodFunnelRow): boolean => r.stage === stage);
}

const STEPS: Step[] = [
  {
    title: 'Turn a Moon site into numbers',
    short: 'Measure',
    body: (c): string =>
      `3 dangers plus slope, measured in each of NASA’s ${c.nRegions ?? 'candidate'} regions. Region locations checked against USGS official boundaries.`,
    info: (c): ReactNode => (
      <WhyHow
        why="these are the dangers that fooled real landers; slope matters for walking and touchdown."
        how={`all ${c.nRegions ?? ''} regions lie within 0.2 km of the USGS official extents; Moon heights are good to ±0.3–0.5 m.`}
      />
    ),
  },
  {
    title: 'Sample bare land across Earth',
    short: 'Sample',
    body: (): string => 'Two rounds: first spread across all latitudes and terrain types, then focused near the best hits.',
    info: (c): ReactNode => (
      <WhyHow
        why="measuring every 15 km square on Earth isn’t feasible, so we sample, then look harder near the best hits."
        how={
          c.m
            ? `it’s a sample: ${nf.format(c.m.screen.n_screened)} squares from bare land, not all of Earth. The map shows a subset.`
            : 'it’s a sample from bare land, not all of Earth.'
        }
      />
    ),
  },
  {
    title: 'Keep only bare ground',
    short: 'Filter',
    body: (): string =>
      'Keep ground where the elevation data sees the real surface — no forests, cities, farmland, water or ice (low scrub is fine).',
    info: (c): ReactNode => {
      const a = funnelRow(c.m, 'sampled');
      const b = funnelRow(c.m, 'dsm_safe');
      const known = a?.known_pass != null && b?.known_pass != null ? `${b.known_pass} of ${a.known_pass} known analogs pass` : null;
      const decoys = a?.decoy_pass != null && b?.decoy_pass === 0 ? `all ${a.decoy_pass} decoys fail` : null;
      return (
        <WhyHow
          why="Earth elevation data includes treetops and roofs, which fake the terrain."
          how={known || decoys ? `${[known, decoys].filter(Boolean).join('; ')}.` : 'checked against known analogs and decoys.'}
        />
      );
    },
  },
  {
    title: 'Compare terrain measurements',
    short: 'Compare',
    body: (): string => 'Every square gets the Moon site’s numbers; the closest win. Ground brightness and slope direction now count too.',
    info: (c): ReactNode => (
      <WhyHow
        why="danger lives in the extremes, so we compare the whole spread of each measure, not its average."
        how={`crater-bowl counts were tested and dropped: forests and farmland mimicked them${
          c.x?.shapeAucWithout != null && c.x.shapeAucWith != null
            ? ` (known-vs-decoy score ${c.x.shapeAucWithout.toFixed(2)} → ${c.x.shapeAucWith.toFixed(2)})`
            : ''
        }.`}
      />
    ),
  },
  {
    title: 'Zoom in, then check in detail',
    short: 'Shortlist',
    body: (): string =>
      `Top squares shift a few km to their best spot. Results are at least ${NEW_PLACE_MIN_KM} km from any known analog: new places.`,
    info: (c): ReactNode => (
      <WhyHow
        why={`a few km can line a square up with the terrain much better; the ${NEW_PLACE_MIN_KM} km rule keeps results new.`}
        how={`the shortlist is re-measured with 30 m data before the top 3 are chosen${
          c.x?.refine ? ` (${nf.format(c.x.refine.nMoved)} moves)` : ''
        }.`}
      />
    ),
  },
  {
    title: 'Prove it works',
    short: 'Check',
    body: (): string => 'Known analogs beat decoys, famous field sites rank high, and a second elevation map agrees.',
    info: (c): ReactNode => (
      <WhyHow
        why="a working method should rank Moon-training sites above farmland and forest."
        how={
          <>
            {c.x?.aucIndependent != null
              ? `feature choices used the original analogs; ${c.x.nIndependent ?? ''} independent held-out sites score ${in100(c.x.aucIndependent)}. `
              : ''}
            {c.x?.nasadem
              ? `The exact top 3 can change with the elevation dataset${c.x.nasadem.top3Overlap !== null ? ` (overlap ${c.x.nasadem.top3Overlap.toFixed(2)})` : ''}.`
              : ''}
          </>
        }
      />
    ),
  },
];

export function Explainer(): JSX.Element {
  const ref = useRef<HTMLElement>(null);
  const near = useNearViewport(ref);
  const [step, setStep] = useState<number>(0);
  const [overlay, setOverlay] = useState<Overlay>('slope');
  const [userPicked, setUserPicked] = useState<boolean>(false);
  const core = useApp((s) => s.core);
  // method.json belongs to the dependent set loaded with the core data (same origin as earth_sites/matches).
  const method = core?.method ?? null;
  const methodState: 'loading' | 'ready' | 'missing' = !core ? 'loading' : method ? 'ready' : 'missing';

  const m = method?.file ?? null;
  const ex = useExampleTile(m?.example.region_id ?? null);
  const extras = useMemo((): MethodExtras | null => (m ? parseMethodExtras(m) : null), [m]);
  const shadowR = core?.summary?.validation?.shadow_vs_pgda?.pearson_r ?? null;
  const [findback, setFindback] = useState<Findback | null>(null);
  const methodOrigin = method?.origin ?? null;
  useEffect((): (() => void) | void => {
    if (!near || !methodOrigin) return;
    let alive = true;
    loadJsonFrom('walk/findback.json', isFindbackRaw, methodOrigin)
      .then((fb: Loaded<Record<string, unknown>> | null): void => {
        if (alive && fb) setFindback(parseFindback(fb.value));
      })
      .catch((): void => undefined);
    return (): void => {
      alive = false;
    };
  }, [near, methodOrigin]);
  const ctx: StepCtx = { m, x: extras, nRegions: core?.regions.length ?? null, findback, shadowR };

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
    const site = core?.siteById.get(m.example.site_id);
    return site ? placeName(site).label : m.example.site_id;
  }, [m, core]);
  const regionName = useMemo((): string => {
    if (!m) return '';
    return core?.regions.find((r) => r.id === m.example.region_id)?.name ?? m.example.region_id.replace(/_/g, ' ');
  }, [m, core]);

  const s = STEPS[step];

  let visual: JSX.Element;
  if (step === 0) {
    visual =
      near && ex.tile ? (
        <Suspense fallback={<Loading label="Loading the 3D view…" />}>
          <MoonTile3D tile={ex.tile} overlay={overlay} regionName={ex.name} avgShadow={ex.avgShadow3} />
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
    visual = (
      <WorldDots
        points={m.points}
        phase={step === 1 ? 'sample' : 'filter'}
        active={near}
        screened={m.screen.n_screened}
        coveragePct={extras?.coveragePctBare ?? null}
      />
    );
  } else if (step === 3) {
    visual = <Fingerprint method={m} siteName={siteName} regionName={regionName} />;
  } else if (step === 4) {
    visual = <Funnel rows={withScreened(m.funnel, m.screen.n_screened)} moved={extras?.refine ?? null} />;
  } else {
    visual = (
      <div className="ex-check">
        <StripPlot method={m} />
        {extras && <Scorecard x={extras} findback={findback} shadowR={shadowR} />}
      </div>
    );
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
          <div className="ex-copy-row">
            <p className="ex-copy">{s.body(ctx)}</p>
            <InfoTip label={`More about step ${step + 1}: ${s.short}`} title={s.title} align="end">
              {s.info(ctx)}
            </InfoTip>
          </div>
          {step === 0 && (
            <OverlayButtons
              overlay={overlay}
              onPick={(o: Overlay): void => {
                setUserPicked(true);
                setOverlay(o);
              }}
            />
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
