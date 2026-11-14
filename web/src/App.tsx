import { lazy, Suspense, useEffect, type JSX } from 'react';
import { loadJson, loadOptionalJson, onMockUsed } from './data/loader';
import { buildCore, SCREENS, useApp, type ScreenId } from './store';
import {
  isEarthSitesFile,
  isMatchesFile,
  isOverviewFile,
  isRegionsFile,
  isSummaryFile,
} from './types/contract';
import { Loading } from './components/Loading';
import { Story } from './screens/Story';
import { MoonOverview } from './screens/MoonOverview';
import { RegionDetail } from './screens/RegionDetail';
import { Summary } from './screens/Summary';

// Heavy screens (three.js, worker) load on demand.
const Terrain3D = lazy(() => import('./screens/Terrain3D'));
const Walk = lazy(() => import('./screens/Walk'));

function TopBar(): JSX.Element {
  const screen = useApp((s) => s.screen);
  const setScreen = useApp((s) => s.setScreen);
  const mockFiles = useApp((s) => s.mockFiles);
  return (
    <header className="topbar">
      <button className="brand" onClick={(): void => setScreen('story')} aria-label="Rehearse the Landing, back to start">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-text">Rehearse the Landing</span>
      </button>
      <nav className="stepper" aria-label="Story steps">
        {SCREENS.map((s, i) => (
          <button
            key={s.id}
            className="step"
            aria-current={screen === s.id ? 'step' : undefined}
            onClick={(): void => setScreen(s.id)}
          >
            <span className="step-n">{i + 1}</span>
            <span className="step-label">{s.label}</span>
            <span className="step-short">{s.short}</span>
          </button>
        ))}
      </nav>
      <div className="topbar-right">
        {mockFiles.length > 0 && (
          <span
            className="mock-badge"
            title={`Synthetic mock files in use (pipeline output missing):\n${mockFiles.join('\n')}`}
            aria-label={`Mock data in use for ${mockFiles.length} files`}
          >
            MOCK DATA · {mockFiles.length}
          </span>
        )}
      </div>
    </header>
  );
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
        const [regions, sites, matches, summary, overview] = await Promise.all([
          loadJson('regions.json', isRegionsFile),
          loadJson('earth_sites.json', isEarthSitesFile),
          loadJson('matches.json', isMatchesFile),
          loadOptionalJson('summary.json', isSummaryFile),
          loadOptionalJson('overview.json', isOverviewFile),
        ]);
        if (!cancelled) useApp.getState().setCore(buildCore(regions, sites, matches, summary, overview));
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
            <p style={{ marginTop: 6 }}>{loadError}</p>
            <p style={{ marginTop: 6 }}>Run the pipeline (writes web/public/data/) or `npm run mock` (writes web/public/mock/), then reload.</p>
          </div>
        ) : needsData && !core ? (
          <Loading label="Loading danger profiles and Earth matches…" />
        ) : (
          <Suspense fallback={<Loading label="Loading the 3D engine…" />}>
            <ScreenSwitch screen={screen} />
          </Suspense>
        )}
      </main>
      <footer className="footer">
        <span>NASA Space Apps 2026 · Earth analogs for the Artemis south-pole candidate regions</span>
        <span>Moon: LOLA / PGDA · Earth: Copernicus GLO-30, ESA WorldCover, Macrostrat · Maps © OpenStreetMap, OpenFreeMap</span>
      </footer>
    </div>
  );
}
