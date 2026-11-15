// Step 7: Alberta's best Moon-analog windows, and Moon routes matched to Calgary pathways.
// NASA LOLA + Copernicus/WorldCover for Alberta; City of Calgary Open Data, the Calgary Equity Index 2024 and NRCan HRDEM for Calgary.
// The Calgary tab leads with the Equity Index result (calgary/equity.json); the Moon-route matcher is secondary.
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Marker, Popup, type Map as MlMap, type MapLayerMouseEvent } from 'maplibre-gl';
import { assetUrl, loadFloat32, loadJsonFrom, type Loaded } from '../data/loader';
import { HAZARDS, ROW_NAME } from '../content';
import { GeoMap } from '../components/GeoMap';
import { Fit, HazardGlyph } from '../components/Glyphs';
import { Loading } from '../components/Loading';
import { ScreenHead } from '../components/ScreenHead';
import { HAZARD_IDS, type HazardId, type Meta } from '../types/contract';
import { CreditsPanel } from '../components/Credits';
import { InfoTip } from '../components/InfoTip';
import { buildCredits, type Credit, type CreditArea } from '../lib/credits';
import '../styles/calgary.css';
import { CalgaryMap, type MapPin } from './alberta/CalgaryMap';
import { CalgaryPlanner, ctuidOfOption } from './alberta/CalgaryPlanner';
import { EquityCompare, equityResult, type EquityResult } from './alberta/EquityCompare';
import { RouteThumb, useTwinGeom } from './alberta/MoonTwin';
import {
  buildPlannerIndex,
  needPercentiles,
  planFor,
  rankEvents,
  titleCase,
  type EventPick,
  type PlannerIndex,
  type PlanOption,
  type PreferredNearest,
  type TractInfo,
} from './alberta/planner';
import { accessPhrase, NEED_FILTER_ORDER, pinElement, type NeedFilter } from './alberta/shared';
import {
  isAlbertaFile,
  isEquityFile,
  isOverlaysGeo,
  isPresetsFile,
  isWalksFile,
  isWindowsGeo,
  type AlbertaFile,
  type AlbertaLight,
  type AlbertaSearch,
  type CalgaryPreset,
  type CalgaryWalk,
  type EquityCoverageRow,
  type EquityEvent,
  type EquityFile,
  type OverlaysGeo,
  type PresetsFile,
  type UncapturedTract,
  type WalksFile,
  type WindowsGeo,
} from '../types/alberta';

const nf = new Intl.NumberFormat('en-US');

const HAZARD_NOUN: Record<HazardId, string> = { shadow: 'low-sun shadows', rim: 'crater-rim height jumps', texture: 'camera texture' };

const ALBERTA_BOUNDS: [[number, number], [number, number]] = [
  [-120.3, 48.8],
  [-109.6, 60.2],
];

// ------------------------------------------------------------------------------------------------
// Data (data/ only: there is no sample set for these files)
// ------------------------------------------------------------------------------------------------

interface AlbertaData {
  file: AlbertaFile;
  windows: WindowsGeo;
}

interface CalgaryData {
  walks: WalksFile;
  rows: Float32Array;
  presets: PresetsFile;
  overlays: OverlaysGeo;
  /** Equity Index analysis; null if the file has not been built (the tab then shows the matcher only). */
  equity: EquityFile | null;
}

let albertaPromise: Promise<AlbertaData> | null = null;
let calgaryPromise: Promise<CalgaryData> | null = null;

function need<T>(v: Loaded<T> | null, path: string): T {
  if (!v) throw new Error(`${path} is not available yet in web/public/data/.`);
  return v.value;
}

function loadAlberta(): Promise<AlbertaData> {
  if (!albertaPromise) {
    albertaPromise = (async (): Promise<AlbertaData> => {
      const [file, windows] = await Promise.all([
        loadJsonFrom('alberta/alberta.json', isAlbertaFile, 'data'),
        loadJsonFrom('alberta/alberta_windows.geojson', isWindowsGeo, 'data'),
      ]);
      return { file: need(file, 'alberta/alberta.json'), windows: need(windows, 'alberta/alberta_windows.geojson') };
    })();
    albertaPromise.catch((): void => {
      albertaPromise = null;
    });
  }
  return albertaPromise;
}

function loadCalgary(): Promise<CalgaryData> {
  if (!calgaryPromise) {
    calgaryPromise = (async (): Promise<CalgaryData> => {
      const [walks, presets, overlays, equity] = await Promise.all([
        loadJsonFrom('calgary/walks.json', isWalksFile, 'data'),
        loadJsonFrom('calgary/presets.json', isPresetsFile, 'data'),
        loadJsonFrom('calgary/calgary_overlays.geojson', isOverlaysGeo, 'data'),
        loadJsonFrom('calgary/equity.json', isEquityFile, 'data'),
      ]);
      const w = need(walks, 'calgary/walks.json');
      const [n, pts] = w.bin.shape;
      const rows = await loadFloat32('calgary/walks.bin', n * pts, 'data');
      return {
        walks: w,
        rows: rows.value,
        presets: need(presets, 'calgary/presets.json'),
        overlays: need(overlays, 'calgary/calgary_overlays.geojson'),
        equity: equity?.value ?? null,
      };
    })();
    calgaryPromise.catch((): void => {
      calgaryPromise = null;
    });
  }
  return calgaryPromise;
}

function useLoad<T>(loader: () => Promise<T>, active: boolean): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect((): (() => void) | void => {
    if (!active || data) return;
    let alive = true;
    loader()
      .then((d: T): void => {
        if (alive) setData(d);
      })
      .catch((e: unknown): void => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return (): void => {
      alive = false;
    };
  }, [active, data, loader]);
  return { data, error };
}

// ------------------------------------------------------------------------------------------------
// Shared bits
// ------------------------------------------------------------------------------------------------

function fmtUnit(v: number | null, unit: string): string {
  if (v === null || !Number.isFinite(v)) return '—';
  if (unit === 'frac') return `${(v * 100).toFixed(1)}%`;
  if (unit === 'm') return `${v.toFixed(0)} m`;
  if (unit === 'deg') return `${v.toFixed(1)}°`;
  return v.toFixed(2);
}

function fileDate(meta: Meta | undefined): string {
  const d = meta?.generated_utc ? new Date(meta.generated_utc) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : 'date not recorded';
}

const stripUrl = (s: string): string => s.replace(/\s*\(https?:[^)]*\)\s*$/, '').trim();

/**
 * The shared credits list, made exact for this screen: Calgary credits name each Open Data dataset with its id and the
 * licence version from the files' meta; Alberta adds the GIBS imagery behind the satellite view.
 */
function screenCredits(metas: { file: string; meta: Meta | undefined }[], area: CreditArea): Credit[] {
  const sources = metas.flatMap((m) => m.meta?.sources ?? []);
  const credits = buildCredits(metas, { areas: [area], nasadem: false }).map((c: Credit): Credit => ({ ...c }));
  if (area === 'calgary') {
    const city = sources.filter((s): boolean => /^City of Calgary/i.test(s.name) && !/Equity Index/i.test(s.name));
    const cityNames = Array.from(new Set(city.map((s): string => s.name.replace(/^City of Calgary\s*-\s*/i, '').replace(/^Calgary Transit /, 'Transit '))));
    const eq = sources.find((s): boolean => /Equity Index/i.test(s.name));
    const hr = sources.find((s): boolean => /HRDEM/i.test(s.name));
    for (const c of credits) {
      if (c.key === 'calgary' && city.length) {
        c.name = `City of Calgary Open Data: ${cityNames.join(', ')}`;
        c.licence = stripUrl(city[0].licence);
      } else if (c.key === 'equity' && eq) {
        c.name = 'Calgary Equity Index 2024 (ArcGIS FeatureServer, Accessibility & Amenities domain; higher score = amenities harder to reach)';
        c.url = eq.url;
        c.licence = stripUrl(eq.licence);
      } else if (c.key === 'hrdem' && hr) {
        c.licence = hr.licence;
      } else if (c.key === 'lola') {
        c.use = 'the 18 Moon routes matched to Calgary paths';
      }
    }
  }
  if (area === 'alberta' && !credits.some((c: Credit): boolean => c.key === 'gibs')) {
    const gibs = buildCredits([], { nasadem: false }).find((c: Credit): boolean => c.key === 'gibs');
    if (gibs) credits.push({ ...gibs, name: `NASA GIBS imagery (MODIS Terra corrected reflectance, ${GIBS_DATE})`, use: 'the satellite view of the Alberta map' });
  }
  return credits;
}

function Credits({ metas, area }: { metas: { file: string; meta: Meta | undefined }[]; area: CreditArea }): JSX.Element {
  const dates = Array.from(new Set(metas.map((m) => fileDate(m.meta)))).join(', ');
  return (
    <CreditsPanel
      id="ab-credits-h"
      credits={screenCredits(metas, area)}
      intro={<>Every source this tab’s results depend on, merged with the sources each data file lists. Files generated {dates}.</>}
    />
  );
}

// ------------------------------------------------------------------------------------------------
// Alberta
// ------------------------------------------------------------------------------------------------

function searchFor(file: AlbertaFile, region: string, hazard: HazardId): AlbertaSearch | undefined {
  return file.searches.find((s: AlbertaSearch): boolean => s.region === region && s.hazard === hazard);
}

interface HazardBest {
  hazard: HazardId;
  name: string;
  id: string;
  regionName: string;
  rank: number | null;
  n: number | null;
}

function bestByHazard(file: AlbertaFile): HazardBest[] {
  return HAZARD_IDS.flatMap((h: HazardId): HazardBest[] => {
    const b = file.best_per_hazard[h];
    if (!b) return [];
    const gs = searchFor(file, b.region, h)?.global_screen;
    return [
      {
        hazard: h,
        name: b.name,
        id: b.id,
        regionName: b.region_name,
        rank: gs?.alberta_best_rank_among_global ?? null,
        n: gs?.n_eligible ?? null,
      },
    ];
  });
}

export function albertaResult(file: AlbertaFile): string {
  const ranked = bestByHazard(file).filter((b: HazardBest): boolean => b.rank !== null && b.n !== null);
  ranked.sort((a: HazardBest, b: HazardBest): number => (a.rank ?? 0) / (a.n ?? 1) - (b.rank ?? 0) / (b.n ?? 1));
  const top = ranked[0];
  if (!top || top.rank === null || top.n === null)
    return `${nf.format(file.coverage.n_pass)} of ${nf.format(file.coverage.n_windows)} Alberta windows are bare enough to compare`;
  return `Alberta’s best, ${top.name.split(' · ')[0]}, ranks #${nf.format(top.rank)} of ${nf.format(top.n)} worldwide for ${HAZARD_NOUN[top.hazard]}`;
}

function windowPopup(p: Record<string, unknown>): HTMLElement {
  const box = document.createElement('div');
  const t = document.createElement('strong');
  t.textContent = String(p.name ?? p.id ?? '');
  const line = document.createElement('div');
  const pass = p.pass === true;
  const d = typeof p.best_distance === 'number' ? p.best_distance : null;
  const fail = typeof p.fail === 'string' && p.fail ? p.fail.split(',').join(', ') : '';
  line.textContent = pass
    ? `Bare enough to compare${d !== null ? ` · best distance ${d.toFixed(2)}` : ''}`
    : `Thrown out: ${fail || 'land cover'} (our elevation data would see the cover, not the ground)`;
  box.append(t, line);
  if (p.in_protected_area === true) {
    const park = document.createElement('div');
    park.textContent = 'In a protected area';
    box.append(park);
  }
  return box;
}

/**
 * NASA GIBS true-colour imagery for the satellite view. HLS (30 m) is a daily swath product, so a province view on one
 * date is mostly empty; MODIS Terra corrected reflectance on a cloud-light late-summer day covers all of Alberta.
 */
const GIBS_DATE = '2025-08-26';
const GIBS_TILES = `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${GIBS_DATE}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`;
const GIBS_CREDIT = `Imagery: NASA GIBS, MODIS Terra true colour, ${GIBS_DATE}`;

type BaseView = 'map' | 'satellite';

function AlbertaMap({ data, hazard }: { data: AlbertaData; hazard: HazardId }): JSX.Element {
  const mapRef = useRef<MlMap | null>(null);
  const markers = useRef<Marker[]>([]);
  const [ready, setReady] = useState<boolean>(false);
  const [base, setBase] = useState<BaseView>('map');
  const onLoad = useCallback(
    (map: MlMap): void => {
      mapRef.current = map;
      map.addSource('gibs', { type: 'raster', tiles: [GIBS_TILES], tileSize: 256, maxzoom: 9, attribution: GIBS_CREDIT });
      map.addLayer({ id: 'gibs', type: 'raster', source: 'gibs', layout: { visibility: 'none' }, paint: { 'raster-opacity': 1 } });
      map.addSource('windows', { type: 'geojson', data: data.windows });
      map.addLayer({
        id: 'win-fail',
        type: 'fill',
        source: 'windows',
        filter: ['!=', ['get', 'pass'], true],
        paint: { 'fill-color': '#2c3038', 'fill-opacity': 0.45 },
      });
      map.addLayer({
        id: 'win-pass',
        type: 'fill',
        source: 'windows',
        filter: ['==', ['get', 'pass'], true],
        paint: {
          'fill-color': [
            'case',
            ['==', ['typeof', ['get', 'best_distance']], 'number'],
            ['interpolate', ['linear'], ['get', 'best_distance'], 0.2, '#edeae4', 0.8, '#b9b5ae', 2, '#6f6b64'],
            '#6f6b64',
          ],
          'fill-opacity': 0.95,
        },
      });
      map.addLayer({
        id: 'win-edge',
        type: 'line',
        source: 'windows',
        paint: { 'line-color': '#0a0b0e', 'line-width': 0.4, 'line-opacity': 0.6 },
      });
      map.addLayer({
        id: 'win-park',
        type: 'line',
        source: 'windows',
        filter: ['all', ['==', ['get', 'in_protected_area'], true], ['==', ['get', 'pass'], true]],
        paint: { 'line-color': '#b9b5ae', 'line-width': 1, 'line-dasharray': [2, 2], 'line-opacity': 0.55 },
      });
      for (const layer of ['win-pass', 'win-fail']) {
        map.on('click', layer, (e: MapLayerMouseEvent): void => {
          const f = e.features?.[0];
          if (!f) return;
          new Popup({ closeButton: true, maxWidth: '280px' })
            .setLngLat(e.lngLat)
            .setDOMContent(windowPopup(f.properties ?? {}))
            .addTo(map);
        });
        map.on('mouseenter', layer, (): void => {
          map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', layer, (): void => {
          map.getCanvas().style.cursor = '';
        });
      }
      setReady(true);
    },
    [data],
  );

  // Satellite view: imagery on, windows become a light veil so the ground shows through.
  useEffect((): void => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const sat = base === 'satellite';
    map.setLayoutProperty('gibs', 'visibility', sat ? 'visible' : 'none');
    map.setPaintProperty('win-fail', 'fill-opacity', sat ? 0 : 0.45);
    map.setPaintProperty('win-pass', 'fill-opacity', sat ? 0.6 : 0.95);
    map.setPaintProperty('win-edge', 'line-opacity', sat ? 0 : 0.6);
  }, [base, ready]);

  useEffect((): void => {
    const map = mapRef.current;
    if (!map || !ready) return;
    markers.current.forEach((m: Marker): void => {
      m.remove();
    });
    markers.current = [];
    const best = data.file.best_per_hazard[hazard];
    if (best) {
      const el = pinElement('1', `Alberta’s best for ${HAZARDS[hazard].name.toLowerCase()}: ${best.name}`, true);
      markers.current.push(new Marker({ element: el }).setLngLat([best.lon, best.lat]).addTo(map));
      const forest = searchFor(data.file, best.region, hazard)?.terrain_only_best;
      if (forest && !forest.dsm_pass) {
        const el2 = pinElement('T', `Closest on terrain alone: ${forest.name} (fails: ${forest.fail.join(', ')})`, false, true);
        markers.current.push(new Marker({ element: el2 }).setLngLat([forest.lon, forest.lat]).addTo(map));
      }
    }
  }, [data, hazard, ready]);

  return (
    <div className="geo-map-box ab-map">
      <GeoMap
        bounds={ALBERTA_BOUNDS}
        label="Map of Alberta's 15 km windows"
        onLoad={onLoad}
        onRemove={(): void => {
          markers.current.forEach((m: Marker): void => {
            m.remove();
          });
          mapRef.current = null;
        }}
      />
      <div className="seg seg-sm ab-base" role="group" aria-label="Background">
        <button type="button" aria-pressed={base === 'map'} onClick={(): void => setBase('map')}>
          Map
        </button>
        <button type="button" aria-pressed={base === 'satellite'} onClick={(): void => setBase('satellite')}>
          Satellite
        </button>
      </div>
      {base === 'satellite' && <span className="ab-base-credit">{GIBS_CREDIT}</span>}
    </div>
  );
}

/** Plain names for the Alberta metric labels; the technical label stays in the tooltip. */
function plainAlbertaLabel(label: string): string {
  const rough = /^Roughness \S+\((\d+) m\), RMS height difference$/.exec(label);
  if (rough) return `Bumpiness over ${rough[1]} m`;
  const sh = /^Shadowed azimuths at sun elevation (\d+)° \(local horizon, 90 m\)$/.exec(label);
  if (sh) return `Shadow at a ${sh[1]}° sun, averaged over all sun directions`;
  if (/^1 km height jump, P95/.test(label)) return 'Height jump over 1 km (worst 5%)';
  return label;
}

function LightsTable({ lights }: { lights: AlbertaLight[] }): JSX.Element {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Metric (90 m)</th>
          <th className="r">Moon</th>
          <th className="r">Alberta</th>
          <th>Fit</th>
        </tr>
      </thead>
      <tbody>
        {lights.map((l: AlbertaLight) => (
          <tr key={l.component}>
            <td title={plainAlbertaLabel(l.label) !== l.label ? `${l.label} · ${l.gap}` : l.gap}>{plainAlbertaLabel(l.label)}</td>
            <td className="r">{fmtUnit(l.moon, l.unit)}</td>
            <td className="r">{fmtUnit(l.alberta, l.unit)}</td>
            <td>
              <Fit fit={l.light} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AlbertaPanel({ data, hazard, setHazard }: { data: AlbertaData; hazard: HazardId; setHazard: (h: HazardId) => void }): JSX.Element {
  const { file } = data;
  const cov = file.coverage;
  const best = file.best_per_hazard[hazard];
  const search = best ? searchFor(file, best.region, hazard) : undefined;
  const top = search?.top[0];
  const gs = search?.global_screen;
  const site = best ? file.sites[best.id] : undefined;
  const forest = search?.terrain_only_best;
  const fails = Object.entries(cov.fail_reason_counts).sort((a: [string, number], b: [string, number]): number => b[1] - a[1]);
  const maxFail = Math.max(...fails.map((f: [string, number]): number => f[1]), 1);
  const treeCloser = file.searches.filter(
    (s: AlbertaSearch): boolean =>
      !!s.terrain_only_best &&
      !s.terrain_only_best.dsm_pass &&
      s.terrain_only_best.fail.includes('tree') &&
      s.terrain_only_best.distance < (s.top[0]?.distance ?? Infinity),
  ).length;
  const FAIL_WORD: Record<string, string> = {
    tree: 'Trees',
    crop: 'Cropland',
    built: 'Buildings',
    water: 'Water',
    wet: 'Wetland',
    snow: 'Snow and ice',
    land: 'Outside land',
  };

  return (
    <div className="panel panel-pad ab-panel">
      <section>
        <div className="cg-h">
          <h3>
            {nf.format(cov.n_pass)} of {nf.format(cov.n_windows)} windows are bare enough to compare
          </h3>
          <InfoTip label="Why only bare ground counts" title="Only bare ground counts" align="end">
            <div className="infotip-body">
              <p>
                Our elevation data sees treetops, crops and rooftops, so those 15 km windows would fake the terrain. The bare ones cover{' '}
                {cov.pct_area_pass.toFixed(1)}% of Alberta’s area.
              </p>
              <p className="caption">A window can fail for more than one reason.</p>
            </div>
          </InfoTip>
        </div>
        <ul className="fail-bars">
          {fails.map(([k, v]: [string, number]) => (
            <li key={k}>
              <span>{FAIL_WORD[k] ?? k}</span>
              <span className="fail-bar" aria-hidden="true">
                <span style={{ transform: `scaleX(${v / maxFail})` }} />
              </span>
              <span className="r">{nf.format(v)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <div className="tabs" role="tablist" aria-label="Danger">
          {HAZARD_IDS.map((h: HazardId) => (
            <button key={h} type="button" role="tab" className="tab" aria-selected={h === hazard} onClick={(): void => setHazard(h)}>
              <HazardGlyph hazard={h} />
              {ROW_NAME[h]}
            </button>
          ))}
        </div>
        {best && top ? (
          <div className="ab-best">
            <div className="ab-best-head">
              {site?.hillshade && (
                <img
                  className="ab-thumb"
                  src={assetUrl(site.hillshade, 'data')}
                  alt={`Hillshade of ${best.name}, 15 × 15 km`}
                  width={96}
                  height={96}
                />
              )}
              <div>
                <p className="caption">Alberta’s closest match · against {best.region_name}</p>
                <h3 className="ab-best-name">{best.name}</h3>
                {gs && (
                  <p className="ab-rank">
                    #{nf.format(gs.alberta_best_rank_among_global)}{' '}
                    <span className="muted">of {nf.format(gs.n_eligible)} bare windows worldwide</span>
                  </p>
                )}
                <p className="caption">
                  Distance {top.distance.toFixed(2)} (0 = identical terrain
                  {gs ? `; the world’s best match scores ${gs.best_distance.toFixed(2)}` : ''})
                </p>
              </div>
            </div>
            {best.park_label && <p className="chip chip-dashed ab-park">Protected area: {best.park_label}</p>}
            <LightsTable lights={top.lights} />
            {forest && !forest.dsm_pass && forest.distance < top.distance && (
              <p className="ab-note">
                Closer on terrain alone: {forest.name.split(' · ')[0]} ({forest.distance.toFixed(2)}, dashed pin), but {forest.fail.join(', ')}{' '}
                cover hides the ground.
              </p>
            )}
          </div>
        ) : (
          <p className="muted">No eligible Alberta window for this danger.</p>
        )}
        <p className="caption">
          Honest limit: forested Rockies come close on terrain
          {treeCloser ? ` (closest in ${treeCloser} of ${file.searches.length} searches)` : ''}, but trees disqualify them.
        </p>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Calgary
// ------------------------------------------------------------------------------------------------

/** One threshold for "Calgary match", used by the headline count and the per-route label: typical slope mismatch under 1°. */
const CALGARY_MATCH_DEG = 1;

function isCalgaryMatch(dtwDeg: number | undefined): boolean {
  return typeof dtwDeg === 'number' && dtwDeg < CALGARY_MATCH_DEG;
}

export function calgaryResult(presets: CalgaryPreset[]): string {
  const ok = (p: CalgaryPreset): boolean => isCalgaryMatch(p.match.recommended?.dtw_deg);
  const gentle = presets.filter((p: CalgaryPreset): boolean => p.kind === 'gentle');
  const steep = presets.filter((p: CalgaryPreset): boolean => p.kind === 'steeper');
  const nSteep = steep.filter(ok).length;
  return `${gentle.filter(ok).length} of ${gentle.length} gentle Moon routes have a Calgary path within 1° of slope; ${nSteep === 0 ? 'no steeper one does' : `${nSteep} of ${steep.length} steeper ones do`}`;
}

/** Headline for the Calgary tab: the key equity result, or the matcher result if equity.json is missing. */
export function calgaryHeadline(equity: EquityFile | null, presets: CalgaryPreset[]): string {
  if (!equity) return calgaryResult(presets);
  const hi = equity.coverage.find((r: EquityCoverageRow): boolean => r.category === 'Highest');
  if (!hi) return equity.headline;
  return `${hi.n_covered} of ${hi.n_tracts} highest-need neighbourhoods have a Moon walk starting within 400 m of a bus or train stop`;
}

/** The one-sentence purpose of the Calgary tab (the screen headline). */
export const CALGARY_PURPOSE =
  'We found Calgary pathways with the same ups and downs as Moon routes, then used the City’s Equity Index to choose where free Moon-walk events should go.';

const SHORT_ACCESS: Record<string, string> = { Highest: 'Hardest', High: 'Hard', Moderate: 'Middling', Low: 'Easier', Lowest: 'Easiest' };

// ---------------------------------------------------------------------------- intro: three steps + one result

/** The route that illustrates steps 1–2: event #1 and the Moon route it copies (else the first preset's match). */
function exampleRoute(data: CalgaryData): { preset: CalgaryPreset; walk: CalgaryWalk } | null {
  const items = data.walks.items;
  const presets = data.presets.presets;
  const e = data.equity?.top_events[0];
  if (e?.moon_match) {
    const walk = items.find((w: CalgaryWalk): boolean => w.id === e.route_id);
    const preset = presets.find((p: CalgaryPreset): boolean => p.region === e.moon_match?.region && p.kind === e.moon_match?.kind);
    if (walk && preset) return { preset, walk };
  }
  for (const p of presets) {
    const id = p.match.recommended?.id;
    const walk = id ? items.find((w: CalgaryWalk): boolean => w.id === id) : undefined;
    if (walk) return { preset: p, walk };
  }
  return null;
}

function BusStopIcon(): JSX.Element {
  return (
    <svg className="cg-step-icon" viewBox="0 0 48 48" aria-hidden="true">
      <rect x="0" y="0" width="48" height="48" rx="6" className="cg-step-icon-bg" />
      <line x1="17" y1="12" x2="17" y2="40" className="cg-step-icon-pole" />
      <rect x="9" y="8" width="16" height="12" rx="2.5" className="cg-step-icon-sign" />
      <text x="17" y="17.5" textAnchor="middle" className="cg-step-icon-text">
        BUS
      </text>
      <rect x="27" y="22" width="14" height="18" rx="2" fill="var(--need-5)" />
      <rect x="31" y="27" width="6" height="6" rx="1" className="cg-step-icon-door" />
    </svg>
  );
}

function StepThumb({ data, world }: { data: CalgaryData; world: 'moon' | 'calgary' }): JSX.Element | null {
  const ex = useMemo(() => exampleRoute(data), [data]);
  if (!ex) return null;
  return <StepThumbInner preset={ex.preset} walk={ex.walk} walks={data.walks.items} world={world} />;
}

function StepThumbInner({
  preset,
  walk,
  walks,
  world,
}: {
  preset: CalgaryPreset;
  walk: CalgaryWalk;
  walks: CalgaryWalk[];
  world: 'moon' | 'calgary';
}): JSX.Element | null {
  const g = useTwinGeom(preset, walk, walks);
  return (
    <span className="cg-step-thumb">
      <RouteThumb g={g} world={world} px={64} />
    </span>
  );
}

function CalgaryIntro({ data, result }: { data: CalgaryData; result: EquityResult | null }): JSX.Element {
  const ex = useMemo(() => exampleRoute(data), [data]);
  const exPlace = ex ? (ex.walk.park?.split(';')[0].trim() ?? (ex.walk.tract?.communities ? titleCase(ex.walk.tract.communities.split(',')[0]) : '')) : '';
  return (
    <section className="cg-intro" aria-label="How it works and the result">
      <ol className="cg-steps">
        <li className="cg-step">
          <StepThumb data={data} world="moon" />
          <span className="cg-step-text">
            <strong>Moon route</strong>
            {ex && <span className="cg-step-sub">{ex.preset.region_name}</span>}
          </span>
        </li>
        <li className="cg-step">
          <StepThumb data={data} world="calgary" />
          <span className="cg-step-text">
            <strong>Calgary path, same slopes</strong>
            {exPlace && <span className="cg-step-sub">{exPlace}</span>}
          </span>
        </li>
        <li className="cg-step">
          <BusStopIcon />
          <span className="cg-step-text">
            <strong>Near a bus stop, where amenities are hardest to reach</strong>
          </span>
        </li>
      </ol>
      <div className="cg-result">
        {result ? <ResultLine r={result} /> : data.equity ? <p className="cg-result-text muted">Ranking event spots…</p> : <p className="cg-result-text">{calgaryResult(data.presets.presets)}.</p>}
      </div>
    </section>
  );
}

function ResultLine({ r }: { r: EquityResult }): JSX.Element {
  const withPart = r.withIndex === r.n ? `all ${r.n}` : `${r.withIndex} of ${r.n}`;
  const better = r.withIndex > r.withoutIndex;
  return (
    <div className="cg-result-text">
      With the City’s Equity Index, <strong>{withPart}</strong> suggested events go to neighbourhoods where amenities are hardest to reach.{' '}
      {better ? (
        <>
          Without it, only <strong>{r.withoutIndex} of {r.n}</strong> would.
        </>
      ) : (
        <>
          Without it, <strong>{r.withoutIndex} of {r.n}</strong> would.
        </>
      )}{' '}
      <InfoTip label="How this is counted" title="How this is counted" align="end">
        <div className="infotip-body">
          <p>
            <strong>Hardest to reach</strong> = High or Highest on the Calgary Equity Index 2024 Accessibility &amp; Amenities domain (the top two of
            the City’s five groups; a higher score means more barriers).
          </p>
          <p>
            Each list picks the best Moon walk per neighbourhood with starts at least 2 km apart. With the index, how hard amenities are to reach is
            multiplied in; without it, only closeness to transit and slope match count.
          </p>
        </div>
      </InfoTip>
    </div>
  );
}

// ---------------------------------------------------------------------------- "See the numbers"

type CoverageBasis = 'tracts' | 'people';

function CoverageChart({ rows }: { rows: EquityCoverageRow[] }): JSX.Element {
  const [basis, setBasis] = useState<CoverageBasis>('tracts');
  return (
    <div className="cg-cov">
      <div className="cg-cov-head">
        <span className="caption" id="cg-cov-cap">
          Share with a Moon walk near a bus stop, by how hard amenities are to reach
        </span>
        <div className="seg seg-sm" role="group" aria-labelledby="cg-cov-cap">
          <button type="button" aria-pressed={basis === 'tracts'} onClick={(): void => setBasis('tracts')}>
            Neighbourhoods
          </button>
          <button type="button" aria-pressed={basis === 'people'} onClick={(): void => setBasis('people')}>
            Residents
          </button>
        </div>
      </div>
      <table className="cg-cov-table">
        <caption className="sr-only">
          Share of census tracts (neighbourhoods) or residents, per Equity Index Accessibility &amp; Amenities group, with at least one Moon-walk
          route that starts within 400 m of an active transit stop.
        </caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">How hard amenities are to reach</th>
            <th scope="col">Share covered</th>
            <th scope="col">Covered of total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r: EquityCoverageRow) => {
            const pct = (basis === 'tracts' ? r.pct_covered : r.pct_population_covered) ?? 0;
            const detail =
              basis === 'tracts'
                ? `${r.n_covered} of ${r.n_tracts}`
                : `${nf.format(Math.round(r.population_covered / 1000))}k of ${nf.format(Math.round(r.population / 1000))}k`;
            const tip =
              basis === 'tracts'
                ? `${accessPhrase(r.category)}: ${r.n_covered} of ${r.n_tracts} neighbourhoods (${pct.toFixed(0)}%) have a Moon walk near a bus stop`
                : `${accessPhrase(r.category)}: ${nf.format(r.population_covered)} of ${nf.format(r.population)} residents (${pct.toFixed(0)}%) live in a neighbourhood with one`;
            return (
              <tr key={r.category} title={tip}>
                <th scope="row">
                  <span className="need-swatch" data-need={r.category} aria-hidden="true" />
                  {SHORT_ACCESS[r.category] ?? r.category}
                </th>
                <td className="cg-bar-cell">
                  <span className="cg-bar" aria-hidden="true">
                    <span style={{ transform: `scaleX(${Math.max(pct, 0.5) / 100})` }} />
                  </span>
                  <span className="cg-bar-pct">{pct.toFixed(0)}%</span>
                </td>
                <td className="cg-bar-detail">{detail}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EquityInfo({ equity }: { equity: EquityFile }): JSX.Element {
  const tot = equity.coverage_total_equity.map((r: EquityCoverageRow): number => r.pct_covered ?? 0);
  const lo = Math.min(...tot);
  const hi = Math.max(...tot);
  return (
    <InfoTip label="What is the Calgary Equity Index?" title="Calgary Equity Index 2024" align="end">
      <div className="infotip-body">
        <p>
          The City of Calgary scores each of its 288 census tracts on access to amenities, economic opportunity, health, belonging and
          environment. <strong>A higher score means more barriers</strong>. The City sorts tracts into five equal groups.
        </p>
        <p>
          We use the <strong>Accessibility &amp; Amenities</strong> score: how hard it is to get to parks, shops and services.
        </p>
        <p className="caption">
          Check on the City’s overall Total Equity Score: coverage is {lo.toFixed(0)}–{hi.toFixed(0)}% in every group, so the gap is specific to
          access to amenities.
        </p>
      </div>
    </InfoTip>
  );
}

const REASON_SHORT: Record<string, string> = {
  no_route: 'No pathway route in our sample',
  far_from_stop: 'Routes start over 400 m from a stop',
  no_slope_match: 'No Moon slope match yet',
  other: '',
};

function UncapturedList({
  equity,
  onOpen,
  outlined,
  onOutline,
}: {
  equity: EquityFile;
  onOpen: (ctuid: string) => void;
  outlined: boolean;
  onOutline: () => void;
}): JSX.Element | null {
  const u = equity.uncaptured_highest;
  if (!u.tracts.length) return null;
  return (
    <section className="cg-unreached" aria-labelledby="cg-unr-h">
      <div className="cg-h">
        <h4 id="cg-unr-h" className="cg-sub">
          {u.n} neighbourhoods where amenities are hardest to reach have no Moon walk near a bus stop yet
        </h4>
      </div>
      <button type="button" className="chip chip-button cg-gap-btn" aria-pressed={outlined} onClick={onOutline}>
        <span className="cg-gap-key" aria-hidden="true" />
        {outlined ? 'Outlined on the map' : 'Outline them on the map'}
      </button>
      <ul>
        {u.tracts.map((t: UncapturedTract) => (
          <li key={t.ctuid}>
            <button type="button" className="cg-unreached-btn" onClick={(): void => onOpen(t.ctuid)}>
              <span className="cg-unreached-name">{t.communities || t.tract}</span>
              <span className="muted">
                {REASON_SHORT[t.reason] ?? ''}
                {t.nearest_suitable ? ` · nearest Moon walk ${t.nearest_suitable.dist_km.toFixed(1)} km` : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NumbersView({
  data,
  compare,
  tracts,
  onOpen,
  onPick,
  needFilter,
  setNeedFilter,
  outlined,
  onOutline,
}: {
  data: CalgaryData;
  compare: { withNeed: EventPick[]; withoutNeed: EventPick[] } | null;
  tracts: Map<string, TractInfo> | null;
  onOpen: (ctuid: string) => void;
  onPick: (p: EventPick) => void;
  needFilter: NeedFilter;
  setNeedFilter: (f: NeedFilter) => void;
  outlined: boolean;
  onOutline: () => void;
}): JSX.Element {
  const equity = data.equity;
  const filterOpts: NeedFilter[] = ['All', ...NEED_FILTER_ORDER];
  return (
    <details className="cg-numbers">
      <summary>See the numbers</summary>
      <div className="cg-numbers-body">
        {equity && (
          <section aria-labelledby="cg-cov-h" className="cg-num-sec">
            <div className="cg-h">
              <h4 id="cg-cov-h" className="cg-sub">
                Who has a Moon walk near a bus stop
              </h4>
              <EquityInfo equity={equity} />
            </div>
            <CoverageChart rows={equity.coverage} />
            <p className="cg-gap">
              <strong>{equity.gap.high_need.pct_covered.toFixed(0)}%</strong> of neighbourhoods where amenities are hardest to reach vs{' '}
              <strong>{equity.gap.low_need.pct_covered.toFixed(0)}%</strong> where they are easiest.
            </p>
          </section>
        )}
        {equity &&
          (compare && tracts ? (
            <EquityCompare withNeed={compare.withNeed} withoutNeed={compare.withoutNeed} tracts={tracts} onPick={onPick} />
          ) : (
            <p className="caption" role="status">
              Ranking event spots…
            </p>
          ))}
        {equity && <UncapturedList equity={equity} onOpen={onOpen} outlined={outlined} onOutline={onOutline} />}
        <section className="cg-num-sec" aria-labelledby="cg-filter-h">
          <h4 id="cg-filter-h" className="cg-sub">
            Show on the map
          </h4>
          <div className="cg-filter-row" role="group" aria-labelledby="cg-filter-h">
            {filterOpts.map((c: NeedFilter) => (
              <button
                key={c}
                type="button"
                className="chip chip-button cg-need-btn"
                aria-pressed={needFilter === c}
                onClick={(): void => setNeedFilter(c)}
                title={c === 'All' ? 'All neighbourhoods' : accessPhrase(c)}
              >
                {c !== 'All' && <span className="need-swatch" data-need={c} aria-hidden="true" />}
                {c === 'All' ? 'All' : SHORT_ACCESS[c]}
              </button>
            ))}
          </div>
        </section>
        <p className="caption">Moon routes: {calgaryResult(data.presets.presets)}.</p>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------- panel

let plannerPromise: Promise<PlannerIndex> | null = null;

/** Matches every route to the Moon once per page load (≈ 0.3 s, yielding between presets). */
function usePlannerIndex(data: CalgaryData): PlannerIndex | null {
  const [ix, setIx] = useState<PlannerIndex | null>(null);
  useEffect((): (() => void) => {
    let alive = true;
    if (!plannerPromise) {
      plannerPromise = buildPlannerIndex(data.walks.items, data.rows, data.walks.bin.shape[1], data.presets.presets, data.overlays);
      plannerPromise.catch((): void => {
        plannerPromise = null;
      });
    }
    plannerPromise
      .then((r: PlannerIndex): void => {
        if (alive) setIx(r);
      })
      .catch((): void => undefined);
    return (): void => {
      alive = false;
    };
  }, [data]);
  return ix;
}

function firstOptionValue(ix: PlannerIndex | null, data: CalgaryData, ctuid: string): string {
  const t = ix?.tracts.get(ctuid);
  if (t) return `${ctuid}|${t.communities[0] ?? t.label}`;
  const f = data.overlays.features.find((x): boolean => x.properties.ctuid === ctuid);
  const name = f ? (f.properties.communities.split(',')[0]?.trim() ?? '') : '';
  return `${ctuid}|${name ? titleCase(name) : `Census tract ${f?.properties.name ?? ''}`}`;
}

function CalgaryPanel({ data }: { data: CalgaryData }): JSX.Element {
  const equity = data.equity;
  const items = data.walks.items;
  const ix = usePlannerIndex(data);
  const [ctuid, setCtuid] = useState<string | null>(null);
  const [selectValue, setSelectValue] = useState<string>('');
  const [optIdx, setOptIdx] = useState<number>(0);
  const [fitKey, setFitKey] = useState<number>(0);
  const [zoomKey, setZoomKey] = useState<number>(0);
  const [routeInView, setRouteInView] = useState<boolean>(false);
  const [needFilter, setNeedFilter] = useState<NeedFilter>('All');
  const [unreachedOnly, setUnreachedOnly] = useState<boolean>(false);
  const mapColRef = useRef<HTMLDivElement | null>(null);

  const indexById = useMemo((): Map<string, number> => new Map(items.map((w: CalgaryWalk, k: number): [string, number] => [w.id, k])), [items]);
  const preferred = useMemo((): Map<string, PreferredNearest> => {
    const m = new Map<string, PreferredNearest>();
    equity?.uncaptured_highest.tracts.forEach((t: UncapturedTract): void => {
      const k = t.nearest_suitable ? indexById.get(t.nearest_suitable.route_id) : undefined;
      if (t.nearest_suitable && k !== undefined) m.set(t.ctuid, { walkIndex: k, distKm: t.nearest_suitable.dist_km });
    });
    return m;
  }, [equity, indexById]);
  const unreachedIds = useMemo((): string[] => equity?.uncaptured_highest.tracts.map((t: UncapturedTract): string => t.ctuid) ?? [], [equity]);
  const reached = useMemo((): Set<string> | null => (ix ? new Set(ix.suitableByTract.keys()) : null), [ix]);
  const plan = useMemo((): PlanOption[] => (ix && ctuid ? planFor(ix, items, ctuid, preferred.get(ctuid)) : []), [ix, ctuid, items, preferred]);
  const planWalk = plan[optIdx] ? items[plan[optIdx].walkIndex] : null;
  const compare = useMemo((): { withNeed: EventPick[]; withoutNeed: EventPick[] } | null => {
    if (!ix) return null;
    const pct = needPercentiles(data.overlays);
    return { withNeed: rankEvents(ix, items, pct, true), withoutNeed: rankEvents(ix, items, pct, false) };
  }, [ix, items, data.overlays]);
  const result = useMemo(
    (): EquityResult | null => (compare && ix && equity ? equityResult(compare.withNeed, compare.withoutNeed, ix.tracts) : null),
    [compare, ix, equity],
  );

  const pins = useMemo((): MapPin[] => {
    if (!equity) return [];
    return equity.top_events.flatMap((e: EquityEvent): MapPin[] => {
      const k = indexById.get(e.route_id);
      const w = k !== undefined ? items[k] : undefined;
      if (!w || !w.coords.length) return [];
      const [lat, lon] = w.coords[0];
      return [{ rank: e.rank, lonLat: [lon, lat], title: `Suggested event ${e.rank}: ${e.place}. Show its Moon walk.` }];
    });
  }, [equity, indexById, items]);

  const openTract = useCallback(
    (id: string, opts: { fit: boolean; walkIndex?: number; value?: string }): void => {
      setCtuid(id);
      setSelectValue(opts.value ?? firstOptionValue(ix, data, id));
      let at = 0;
      if (ix && opts.walkIndex !== undefined) {
        const list = planFor(ix, items, id, preferred.get(id));
        at = Math.max(0, list.findIndex((o: PlanOption): boolean => o.walkIndex === opts.walkIndex));
      }
      setOptIdx(at);
      if (opts.fit) setFitKey((k: number): number => k + 1);
    },
    [ix, data, items, preferred],
  );
  const onPin = useCallback(
    (rank: number): void => {
      const e = equity?.top_events.find((x: EquityEvent): boolean => x.rank === rank);
      if (e) openTract(e.ctuid, { fit: true, walkIndex: indexById.get(e.route_id) });
    },
    [equity, openTract, indexById],
  );
  const onMapTract = useCallback((id: string): void => openTract(id, { fit: false }), [openTract]);
  /** Zoom to the route (with a pulse) and bring the map on screen below the sticky header if it is not. */
  const zoomToRoute = (): void => {
    setZoomKey((k: number): number => k + 1);
    const box = mapColRef.current?.querySelector<HTMLElement>('.cg-map');
    if (!box) return;
    const r = box.getBoundingClientRect();
    const head = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || 60;
    if (r.top < head + 8 || r.bottom > window.innerHeight) {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      box.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    }
  };

  const activePin = planWalk ? (equity?.top_events.find((e: EquityEvent): boolean => e.route_id === planWalk.id)?.rank ?? null) : null;

  return (
    <>
      <CalgaryIntro data={data} result={result} />
      <div className="ab-layout cg-layout" role="tabpanel">
      <div className="cg-map-col" ref={mapColRef}>
        <CalgaryMap
          overlays={data.overlays}
          walks={items}
          walk={planWalk}
          selectedTract={ctuid}
          pins={pins}
          activePin={activePin}
          onPin={onPin}
          onTract={onMapTract}
          needFilter={needFilter}
          unreachedOnly={unreachedOnly}
          unreachedIds={unreachedIds}
          reached={reached}
          fitKey={fitKey}
          zoomKey={zoomKey}
          onRouteInView={setRouteInView}
        />
        <div className="cg-legend">
          <span className="legend-item">
            <span className="cg-ramp-key" aria-hidden="true" />
            Brighter = amenities harder to reach <span className="muted">(Calgary Equity Index 2024)</span>
          </span>
          {pins.length > 0 && (
            <span className="legend-item">
              <span className="pin-key" aria-hidden="true">
                1
              </span>
              Suggested event
            </span>
          )}
          {planWalk && (
            <span className="legend-item">
              <span className="mt-key-start" aria-hidden="true" />
              <span className="cg-route-key" aria-hidden="true" />
              <span className="mt-key-end" aria-hidden="true" />
              Moon walk, start to end
            </span>
          )}
        </div>
      </div>
      <div className="panel panel-pad ab-panel cg-panel">
        <CalgaryPlanner
          overlays={data.overlays}
          walks={items}
          rows={data.rows}
          pts={data.walks.bin.shape[1]}
          presets={data.presets.presets}
          index={ix}
          selectValue={selectValue}
          onSelect={(v: string): void => {
            const id = ctuidOfOption(v);
            if (id) openTract(id, { fit: true, value: v });
          }}
          ctuid={ctuid}
          plan={plan}
          optionIdx={optIdx}
          onNext={(): void => {
            setOptIdx((i: number): number => (plan.length ? (i + 1) % plan.length : 0));
            setFitKey((k: number): number => k + 1);
          }}
          onShow={zoomToRoute}
          routeInView={routeInView}
        />
        <NumbersView
          data={data}
          compare={compare}
          tracts={ix?.tracts ?? null}
          onOpen={(id: string): void => openTract(id, { fit: true })}
          onPick={(pk: EventPick): void => openTract(pk.ctuid, { fit: true, walkIndex: pk.walkIndex })}
          needFilter={needFilter}
          setNeedFilter={setNeedFilter}
          outlined={unreachedOnly}
          onOutline={(): void => setUnreachedOnly((v: boolean): boolean => !v)}
        />
      </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------------------------------------
// Screen
// ------------------------------------------------------------------------------------------------

type Tab = 'alberta' | 'calgary';

export default function AlbertaCalgary(): JSX.Element {
  const [tab, setTab] = useState<Tab>('alberta');
  const [hazard, setHazard] = useState<HazardId>('shadow');
  const ab = useLoad(loadAlberta, tab === 'alberta');
  const cg = useLoad(loadCalgary, tab === 'calgary');

  const result =
    tab === 'alberta'
      ? ab.data
        ? albertaResult(ab.data.file)
        : 'Loading Alberta’s windows…'
      : CALGARY_PURPOSE;

  return (
    <div>
      <ScreenHead
        kicker="Alberta & Calgary · NASA data with City of Calgary Open Data"
        result={result}
        method={
          tab === 'alberta' ? (
            <p>
              Every 15 km window that touches Alberta ({ab.data ? nf.format(ab.data.file.coverage.n_windows) : 'about 3,000'}) gets the same
              90 m terrain measurements as the Moon regions and the global Earth screen, so distances and ranks are directly comparable. Only windows
              bare enough for the elevation data to see the ground are eligible.
            </p>
          ) : (
            <p>
              {cg.data ? nf.format(cg.data.walks.items.length) : 'About 2,800'} City of Calgary pathway routes get slope profiles from NRCan
              lidar and are matched to 18 Moon routes (NASA LOLA). A route counts when its typical slope mismatch is under 1° and it starts within
              400 m of an active bus or train stop. The Calgary Equity Index 2024 (Accessibility &amp; Amenities) shows where amenities are hardest
              to reach; events go there first.
            </p>
          )
        }
      />
      <div className="tabs" role="tablist" aria-label="Alberta or Calgary">
        <button type="button" role="tab" className="tab" aria-selected={tab === 'alberta'} onClick={(): void => setTab('alberta')}>
          Alberta’s closest Moon terrain
        </button>
        <button type="button" role="tab" className="tab" aria-selected={tab === 'calgary'} onClick={(): void => setTab('calgary')}>
          Moon routes on Calgary paths
        </button>
      </div>

      {tab === 'alberta' &&
        (ab.error ? (
          <div className="error-box">Alberta data unavailable: {ab.error}</div>
        ) : !ab.data ? (
          <Loading label="Loading Alberta’s windows…" />
        ) : (
          <>
            <div className="ab-layout" role="tabpanel">
              <div>
                <AlbertaMap data={ab.data} hazard={hazard} />
                <div className="ab-legend">
                  <span className="legend-item">
                    <span className="ramp-key" aria-hidden="true" />
                    Bare windows, brighter = closer to the Moon
                  </span>
                  <span className="legend-item">
                    <span className="swatch-key swatch-fail" aria-hidden="true" />
                    Thrown out (trees, crops, water…)
                  </span>
                  <span className="legend-item">
                    <span className="swatch-key swatch-park" aria-hidden="true" />
                    Bare window in a protected area
                  </span>
                  <span className="legend-item">
                    <span className="pin-key" aria-hidden="true">
                      1
                    </span>
                    Best for this danger
                  </span>
                  <span className="legend-item">
                    <span className="pin-key pin-key-dashed" aria-hidden="true">
                      T
                    </span>
                    Closest on terrain alone (fails land cover)
                  </span>
                </div>
              </div>
              <AlbertaPanel data={ab.data} hazard={hazard} setHazard={setHazard} />
            </div>
            <Credits area="alberta" metas={[{ file: 'alberta.json', meta: ab.data.file.meta }]} />
          </>
        ))}

      {tab === 'calgary' &&
        (cg.error ? (
          <div className="error-box">Calgary data unavailable: {cg.error}</div>
        ) : !cg.data ? (
          <Loading label="Loading Calgary’s pathways…" />
        ) : (
          <>
            <CalgaryPanel data={cg.data} />
            <details className="cg-more">
              <summary>Limits and data credits</summary>
              <p className="cg-honest">
                The ups and downs match at about 20–30 m scale; steep Moon routes have no city equivalent. For outreach, not equipment testing
                or an accessibility rating.
              </p>
              <Credits
                area="calgary"
                metas={[
                  { file: 'walks.json', meta: cg.data.walks.meta },
                  { file: 'presets.json', meta: cg.data.presets.meta },
                  { file: 'calgary_overlays.geojson', meta: cg.data.overlays.meta },
                  ...(cg.data.equity ? [{ file: 'equity.json', meta: cg.data.equity.meta }] : []),
                ]}
              />
            </details>
          </>
        ))}
    </div>
  );
}
