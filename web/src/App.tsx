import { lazy, Suspense, useEffect, useRef, useState, type JSX } from 'react';
import { loadJson, loadJsonFrom, onMockUsed, type Loaded, type Origin } from './data/loader';
import { buildCore, SCREENS, useApp, type ScreenId } from './store';
import {
  isEarthSitesFile,
  isMatchesFile,
  isMethodFile,
  isOverviewFile,
  isRegionsFile,
  isSummaryFile,
  type EarthSitesFile,
  type MatchesFile,
  type MethodFile,
  type SummaryFile,
} from './types/contract';
import { Loading } from './components/Loading';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Story } from './screens/Story';
import { MoonOverview } from './screens/MoonOverview';
import { RegionDetail } from './screens/RegionDetail';
import { Summary } from './screens/Summary';

// Heavy screens (three.js, worker) load on demand.
const Terrain3D = lazy(() => import('./screens/Terrain3D'));
const Walk = lazy(() => import('./screens/Walk'));
const AlbertaCalgary = lazy(() => import('./screens/AlbertaCalgary'));

/** Groups mock file paths: JSON files by name, tiles and images by folder with a count. */
function groupMock(files: string[]): string[] {
  const json = files.filter((f: string): boolean => f.endsWith('.json')).sort();
  const folders = new Map<string, number>();
  for (const f of files) {
    if (f.endsWith('.json')) continue;
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/') + 1) : './';
    folders.set(dir, (folders.get(dir) ?? 0) + 1);
  }
  const rest = Array.from(folders.entries())
    .sort((a: [string, number], b: [string, number]): number => a[0].localeCompare(b[0]))
    .map(([dir, n]: [string, number]): string => `${dir} · ${n} ${n === 1 ? 'file' : 'files'}`);
  return [...json, ...rest];
}

function SampleDataChip({ files }: { files: string[] }): JSX.Element {
  const [open, setOpen] = useState<boolean>(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect((): (() => void) | void => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (wrap.current && e.target instanceof Node && !wrap.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return (): void => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const rows = groupMock(files);
  return (
    <div className="sample-wrap" ref={wrap}>
      <button
        type="button"
        className="chip chip-sample chip-button"
        aria-expanded={open}
        aria-controls="sample-pop"
        onClick={(): void => setOpen((o: boolean): boolean => !o)}
      >
        Sample data
      </button>
      {open && (
        <div id="sample-pop" className="popover" role="dialog" aria-label="Files using sample data">
          <p className="popover-title">Some screens use the synthetic sample set</p>
          <p className="popover-text">The pipeline has not written these files yet, so the app falls back to web/public/mock/:</p>
          <ul className="popover-list">
            {rows.map((r: string) => (
              <li key={r} className="mono">
                {r}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function TopBar(): JSX.Element {
  const screen = useApp((s) => s.screen);
  const setScreen = useApp((s) => s.setScreen);
  const mockFiles = useApp((s) => s.mockFiles);
  return (
    <header className="topbar">
      <button className="brand" onClick={(): void => setScreen('story')} aria-label="Moon on Earth, back to start">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-text">Moon on Earth</span>
      </button>
      <nav className="stepper" aria-label="Story steps">
        {SCREENS.map((s, i) => (
          <button key={s.id} className="step" aria-current={screen === s.id ? 'step' : undefined} onClick={(): void => setScreen(s.id)}>
            <span className="step-n">{i + 1}</span>
            <span className="step-label">{s.label}</span>
            <span className="step-short">{s.short}</span>
          </button>
        ))}
      </nav>
      <div className="topbar-right">{mockFiles.length > 0 && <SampleDataChip files={mockFiles} />}</div>
    </header>
  );
}

interface DependentSet {
  origin: Origin;
  sites: Loaded<EarthSitesFile>;
  matches: Loaded<MatchesFile>;
  summary: Loaded<SummaryFile> | null;
  method: Loaded<MethodFile> | null;
}

/**
 * earth_sites, matches, summary and method join on site and region ids, so they must come from the same place.
 * Use data/ only when all four exist there; until the pipeline has written every one of them, use mock/ for all.
 */
async function loadDependentSet(): Promise<DependentSet> {
  const [sites, matches, summary, method] = await Promise.all([
    loadJsonFrom('earth_sites.json', isEarthSitesFile, 'data'),
    loadJsonFrom('matches.json', isMatchesFile, 'data'),
    loadJsonFrom('summary.json', isSummaryFile, 'data'),
    loadJsonFrom('method.json', isMethodFile, 'data'),
  ]);
  // method.json (explainer numbers) is written last by the earth stage; it carries its own origin and only
  // falls back to mock by itself, so a missing method.json never holds earth_sites/matches/summary on mock.
  if (sites && matches && summary) {
    const ownMethod = method ?? (await loadJsonFrom('method.json', isMethodFile, 'mock'));
    return { origin: 'data', sites, matches, summary, method: ownMethod };
  }
  const [mSites, mMatches, mSummary, mMethod] = await Promise.all([
    loadJsonFrom('earth_sites.json', isEarthSitesFile, 'mock'),
    loadJsonFrom('matches.json', isMatchesFile, 'mock'),
    loadJsonFrom('summary.json', isSummaryFile, 'mock'),
    loadJsonFrom('method.json', isMethodFile, 'mock'),
  ]);
  if (!mSites || !mMatches) {
    throw new Error('earth_sites.json and matches.json are missing from both data/ and mock/ (run the pipeline or `npm run mock`).');
  }
  return { origin: 'mock', sites: mSites, matches: mMatches, summary: mSummary, method: mMethod };
}

function ScreenSwitch({ screen }: { screen: ScreenId }): JSX.Element {
  switch (screen) {
    case 'story':
      return <Story />;
    case 'moon':
      return <MoonOverview />;
    case 'region':
      return <RegionDetail />;
    case 'terrain':
      return <Terrain3D />;
    case 'walk':
      return <Walk />;
    case 'summary':
      return <Summary />;
    case 'alberta':
      return <AlbertaCalgary />;
  }
}

export function App(): JSX.Element {
  const screen = useApp((s) => s.screen);
  const core = useApp((s) => s.core);
  const loadError = useApp((s) => s.loadError);

  useEffect((): (() => void) => {
    const off = onMockUsed((p: string): void => useApp.getState().addMockFile(p));
    let cancelled = false;
    (async (): Promise<void> => {
      try {
        const [regions, set] = await Promise.all([loadJson('regions.json', isRegionsFile), loadDependentSet()]);
        // The backdrop only makes sense with regions from the same source.
        const overview = await loadJsonFrom('overview.json', isOverviewFile, regions.origin);
        if (!cancelled) {
          useApp.getState().setCore(buildCore(regions, set.sites, set.matches, set.summary, overview, set.method, set.origin));
        }
      } catch (e: unknown) {
        if (!cancelled) useApp.getState().setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    const onHash = (): void => {
      const h = window.location.hash.replace('#/', '');
      const found = SCREENS.find((s) => s.id === h);
      if (found) useApp.getState().setScreen(found.id);
    };
    window.addEventListener('hashchange', onHash);
    return (): void => {
      cancelled = true;
      off();
      window.removeEventListener('hashchange', onHash);
    };
  }, []);

  useEffect((): void => {
    window.scrollTo({ top: 0 });
  }, [screen]);

  const needsData = screen !== 'story';

  return (
    <div className="app">
      <TopBar />
      <main className="screen" key={screen}>
        {needsData && loadError ? (
          <div className="error-box" role="alert">
            <strong>Could not load the pipeline outputs.</strong>
            <p>{loadError}</p>
            <p>Run the pipeline (writes web/public/data/) or `npm run mock` (writes web/public/mock/), then reload.</p>
          </div>
        ) : needsData && !core ? (
          <Loading label="Loading danger profiles and Earth matches…" />
        ) : (
          <ErrorBoundary name={SCREENS.find((s) => s.id === screen)?.label ?? screen} resetKey={screen}>
            <Suspense fallback={<Loading label="Loading the 3D engine…" />}>
              <ScreenSwitch screen={screen} />
            </Suspense>
          </ErrorBoundary>
        )}
      </main>
      <footer className="footer">
        <span>Moon on Earth · NASA Space Apps 2026 · Earth analogs for the Artemis south-pole candidate regions</span>
        <span>
          Moon: LOLA / PGDA · Earth: Copernicus GLO-30, ESA WorldCover, Macrostrat · Calgary: City of Calgary Open Data, Equity Index 2024,
          NRCan HRDEM · Maps © OpenStreetMap, OpenFreeMap
        </span>
      </footer>
    </div>
  );
}
