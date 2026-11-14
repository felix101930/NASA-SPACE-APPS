// Step 7: Alberta's best Moon-analog windows, and Moon routes matched to Calgary pathways.
// NASA LOLA + Copernicus/WorldCover for Alberta; City of Calgary Open Data, the Calgary Equity Index 2024 and NRCan HRDEM for Calgary.
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { LngLatBounds, Marker, Popup, type GeoJSONSource, type Map as MlMap, type MapLayerMouseEvent } from 'maplibre-gl';
import type { Feature, FeatureCollection, LineString } from 'geojson';
import { assetUrl, loadFloat32, loadJsonFrom, type Loaded } from '../data/loader';
import { HAZARDS, ROW_NAME } from '../content';
import { GeoMap } from '../components/GeoMap';
import { Fit, HazardGlyph } from '../components/Glyphs';
import { Loading } from '../components/Loading';
import { ScreenHead } from '../components/ScreenHead';
import { SlopeChart } from '../components/SlopeChart';
import { useApp } from '../store';
import { HAZARD_IDS, type HazardId, type Meta } from '../types/contract';
import { CreditsPanel } from '../components/Credits';
import { buildCredits, type CreditArea } from '../lib/credits';
import {
  isAlbertaFile,
  isOverlaysGeo,
  isPresetsFile,
  isWalksFile,
  isWindowsGeo,
  NEED_ORDER,
  type AlbertaFile,
  type AlbertaLight,
  type AlbertaSearch,
  type CalgaryPreset,
  type CalgaryWalk,
  type OverlaysGeo,
  type PresetMatchRow,
  type PresetsFile,
  type WalksFile,
  type WindowsGeo,
} from '../types/alberta';

const nf = new Intl.NumberFormat('en-US');

const HAZARD_NOUN: Record<HazardId, string> = { shadow: 'low-sun shadows', rim: 'crater-rim height jumps', texture: 'camera texture' };

/** Equity Index need ramp (keep in sync with --need-1..5 in styles.css). Higher = greater need for access to amenities. */
const NEED_COLOUR: Record<string, string> = {
  Lowest: '#1d2b2c',
  Low: '#21403f',
  Moderate: '#2a5c56',
  High: '#357f73',
  Highest: '#45a593',
};

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
      const [walks, presets, overlays] = await Promise.all([
        loadJsonFrom('calgary/walks.json', isWalksFile, 'data'),
        loadJsonFrom('calgary/presets.json', isPresetsFile, 'data'),
        loadJsonFrom('calgary/calgary_overlays.geojson', isOverlaysGeo, 'data'),
      ]);
      const w = need(walks, 'calgary/walks.json');
      const [n, pts] = w.bin.shape;
      const rows = await loadFloat32('calgary/walks.bin', n * pts, 'data');
      return {
        walks: w,
        rows: rows.value,
        presets: need(presets, 'calgary/presets.json'),
        overlays: need(overlays, 'calgary/calgary_overlays.geojson'),
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

function Credits({ metas, area }: { metas: { file: string; meta: Meta | undefined }[]; area: CreditArea }): JSX.Element {
  const dates = Array.from(new Set(metas.map((m) => fileDate(m.meta)))).join(', ');
  return (
    <CreditsPanel
      id="ab-credits-h"
      credits={buildCredits(metas, { areas: [area], nasadem: false })}
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

function pinElement(label: string, title: string, active: boolean, dashed = false): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = dashed ? 'pin pin-dashed' : 'pin';
  el.textContent = label;
  el.title = title;
  el.setAttribute('aria-label', title);
  if (active) el.setAttribute('aria-current', 'true');
  return el;
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

function AlbertaMap({ data, hazard }: { data: AlbertaData; hazard: HazardId }): JSX.Element {
  const mapRef = useRef<MlMap | null>(null);
  const markers = useRef<Marker[]>([]);
  const [ready, setReady] = useState<boolean>(false);
  const onLoad = useCallback(
    (map: MlMap): void => {
      mapRef.current = map;
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
    <div className="geo-map-box">
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
        <h3>Only bare ground counts</h3>
        <p className="muted">
          {nf.format(cov.n_pass)} of {nf.format(cov.n_windows)} windows ({cov.pct_area_pass.toFixed(1)}% of Alberta’s area) are bare enough
          to compare. Our elevation data sees treetops, crops and rooftops, so those windows would fake the terrain.
        </p>
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
        <p className="caption">A window can fail for more than one reason.</p>
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
                On terrain alone, {forest.name} comes closer ({forest.distance.toFixed(2)}), but it fails on {forest.fail.join(', ')} cover.
                Our elevation data sees the canopy, not the ground, so it can’t count. It is the dashed pin on the map.
              </p>
            )}
          </div>
        ) : (
          <p className="muted">No eligible Alberta window for this danger.</p>
        )}
        <p className="caption">
          Honest limit: forested Rockies come close on terrain
          {treeCloser ? ` (in ${treeCloser} of ${file.searches.length} searches the closest terrain is forest)` : ''}, but trees disqualify
          them.
        </p>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Calgary
// ------------------------------------------------------------------------------------------------

function walkLine(w: CalgaryWalk): Feature<LineString, { id: string }> {
  return {
    type: 'Feature',
    properties: { id: w.id },
    geometry: { type: 'LineString', coordinates: w.coords.map(([lat, lon]: [number, number]): [number, number] => [lon, lat]) },
  };
}

function overlayBounds(o: OverlaysGeo): [[number, number], [number, number]] {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  const visit = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
      w = Math.min(w, c[0]);
      e = Math.max(e, c[0]);
      s = Math.min(s, c[1]);
      n = Math.max(n, c[1]);
    } else if (Array.isArray(c)) c.forEach(visit);
  };
  o.features.forEach((f): void => visit(f.geometry.coordinates));
  return Number.isFinite(w)
    ? [
        [w, s],
        [e, n],
      ]
    : [
        [-114.32, 50.84],
        [-113.86, 51.21],
      ];
}

function CalgaryMap({ data, walk }: { data: CalgaryData; walk: CalgaryWalk | null }): JSX.Element {
  const mapRef = useRef<MlMap | null>(null);
  const marker = useRef<Marker | null>(null);
  const [ready, setReady] = useState<boolean>(false);
  const bounds = useMemo(() => overlayBounds(data.overlays), [data]);
  const onLoad = useCallback(
    (map: MlMap): void => {
      mapRef.current = map;
      map.addSource('tracts', { type: 'geojson', data: data.overlays });
      map.addLayer({
        id: 'tracts',
        type: 'fill',
        source: 'tracts',
        paint: {
          'fill-color': [
            'match',
            ['get', 'access_category'],
            'Lowest',
            NEED_COLOUR.Lowest,
            'Low',
            NEED_COLOUR.Low,
            'Moderate',
            NEED_COLOUR.Moderate,
            'High',
            NEED_COLOUR.High,
            'Highest',
            NEED_COLOUR.Highest,
            '#23272e',
          ],
          'fill-opacity': 0.72,
        },
      });
      map.addLayer({
        id: 'tracts-edge',
        type: 'line',
        source: 'tracts',
        paint: { 'line-color': '#0a0b0e', 'line-width': 0.5, 'line-opacity': 0.7 },
      });
      const all: FeatureCollection<LineString, { id: string }> = { type: 'FeatureCollection', features: data.walks.items.map(walkLine) };
      map.addSource('walks', { type: 'geojson', data: all });
      map.addLayer({
        id: 'walks',
        type: 'line',
        source: 'walks',
        paint: { 'line-color': '#edeae4', 'line-width': 1, 'line-opacity': 0.28 },
      });
      map.addSource('sel', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'sel-casing',
        type: 'line',
        source: 'sel',
        paint: { 'line-color': '#0a0b0e', 'line-width': 8 },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });
      map.addLayer({
        id: 'sel',
        type: 'line',
        source: 'sel',
        paint: { 'line-color': '#edeae4', 'line-width': 4 },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });
      map.on('click', 'tracts', (e: MapLayerMouseEvent): void => {
        const p = e.features?.[0]?.properties;
        if (!p) return;
        const box = document.createElement('div');
        const t = document.createElement('strong');
        t.textContent = String(p.communities ?? p.name ?? '');
        const l = document.createElement('div');
        l.textContent = `${String(p.access_category ?? '')} need for access to amenities (Equity Index 2024)`;
        box.append(t, l);
        new Popup({ maxWidth: '260px' }).setLngLat(e.lngLat).setDOMContent(box).addTo(map);
      });
      setReady(true);
    },
    [data],
  );

  useEffect((): void => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const fc: FeatureCollection<LineString, { id: string }> = { type: 'FeatureCollection', features: walk ? [walkLine(walk)] : [] };
    map.getSource<GeoJSONSource>('sel')?.setData(fc);
    marker.current?.remove();
    marker.current = null;
    if (walk && walk.coords.length > 1) {
      const [lat, lon] = walk.coords[0];
      const el = pinElement(
        '▶',
        `Start of the walk${walk.near_stop ? `, ${Math.round(walk.near_stop.dist_m)} m from ${walk.near_stop.name}` : ''}`,
        true,
      );
      marker.current = new Marker({ element: el }).setLngLat([lon, lat]).addTo(map);
      const b = new LngLatBounds([lon, lat], [lon, lat]);
      walk.coords.forEach(([la, lo]: [number, number]): void => {
        b.extend([lo, la]);
      });
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      map.fitBounds(b, { padding: 120, maxZoom: 13.5, duration: reduce ? 0 : 700 });
    }
  }, [walk, ready]);

  return (
    <div className="geo-map-box">
      <GeoMap
        bounds={bounds}
        label="Map of Calgary pathways over the Equity Index 2024"
        onLoad={onLoad}
        onRemove={(): void => {
          marker.current?.remove();
          mapRef.current = null;
        }}
      />
    </div>
  );
}

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

function NeedChip({ category }: { category: string | null | undefined }): JSX.Element | null {
  if (!category) return null;
  return (
    <span className="chip need-chip" data-need={category}>
      <span className="need-swatch" data-need={category} aria-hidden="true" />
      {category} need for access to amenities (Calgary Equity Index 2024)
    </span>
  );
}

function CalgaryPanel({ data }: { data: CalgaryData }): JSX.Element {
  const storeRegion = useApp((s) => s.regionId);
  const regions = useMemo((): { id: string; name: string }[] => {
    const m = new Map<string, string>();
    data.presets.presets.forEach((p: CalgaryPreset): void => {
      m.set(p.region, p.region_name);
    });
    return Array.from(m.entries()).map(([id, name]: [string, string]) => ({ id, name }));
  }, [data]);
  const [region, setRegion] = useState<string>(regions.some((r) => r.id === storeRegion) ? storeRegion : (regions[0]?.id ?? ''));
  const [kind, setKind] = useState<'gentle' | 'steeper'>('gentle');
  const preset = data.presets.presets.find((p: CalgaryPreset): boolean => p.region === region && p.kind === kind) ?? null;
  const [pick, setPick] = useState<string | null>(null);
  useEffect((): void => setPick(null), [region, kind]);
  const row: PresetMatchRow | null = (pick ? preset?.match.top.find((t) => t.id === pick) : null) ?? preset?.match.recommended ?? null;
  const walkById = useMemo(
    (): Map<string, CalgaryWalk> => new Map(data.walks.items.map((w: CalgaryWalk): [string, CalgaryWalk] => [w.id, w])),
    [data],
  );
  const walk = row ? (walkById.get(row.id) ?? null) : null;
  const P = data.walks.bin.shape[1];
  const earthSlopes = useMemo(
    (): number[] | null => (walk ? Array.from(data.rows.subarray(walk.row * P, (walk.row + 1) * P)) : null),
    [walk, data, P],
  );
  const placeName = walk?.park ?? walk?.tract?.communities ?? row?.communities ?? row?.id ?? '';
  const steepGap = preset ? preset.slope_gap_deg : 0;

  return (
    <>
      <div>
        <CalgaryMap data={data} walk={walk} />
        <NeedLegend />
      </div>
      <div className="panel panel-pad ab-panel">
        <p className="ab-purpose">
          We use the City’s 2024 Equity Index to prioritise free outreach and walk events in neighbourhoods that show higher need for access
          to amenities.
        </p>
        <div className="cg-controls">
          <label className="field">
            <span className="field-label">Moon region</span>
            <select className="select" value={region} onChange={(e): void => setRegion(e.target.value)}>
              {regions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span className="field-label" id="cg-kind">
              Moon route
            </span>
            <div className="seg" role="group" aria-labelledby="cg-kind">
              <button type="button" aria-pressed={kind === 'gentle'} onClick={(): void => setKind('gentle')}>
                Gentle
              </button>
              <button type="button" aria-pressed={kind === 'steeper'} onClick={(): void => setKind('steeper')}>
                Steeper
              </button>
            </div>
          </div>
        </div>
        {preset && (
          <p className="caption">
            {preset.region_name}, {kind} route: {(preset.length_m / 1000).toFixed(1)} km, average slope{' '}
            {preset.mean_abs_slope_deg.toFixed(1)}°, steepest {preset.max_slope_deg.toFixed(1)}°, climb {preset.climb_m.toFixed(0)} m.
          </p>
        )}
        {row && walk ? (
          <section className="cg-match">
            <p className="caption">
              {isCalgaryMatch(row.dtw_deg) ? 'Calgary match' : 'Closest Calgary path (not a match)'}
              {!pick && preset?.match.tie_break_applied && (row.access_category === 'High' || row.access_category === 'Highest')
                ? ' · picked among near-ties for higher need for access to amenities'
                : ''}
            </p>
            <h3 className="ab-best-name">{placeName}</h3>
            <p className="muted">
              {isCalgaryMatch(row.dtw_deg)
                ? `This route’s slope profile matches the Moon route at about 20–30 m scale, with a typical slope mismatch of ${row.dtw_deg.toFixed(2)}°.`
                : `This is the closest city path, but its slope profile does not match this Moon route: the typical slope mismatch is ${row.dtw_deg.toFixed(1)}°.`}{' '}
              {(walk.length_m / 1000).toFixed(2)} km, climb {walk.climb_m.toFixed(0)} m.
            </p>
            <div className="chip-row">
              <NeedChip category={walk.tract?.access_category ?? row.access_category} />
              {walk.tract?.communities && (
                <span className="chip">{walk.tract.communities.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}</span>
              )}
            </div>
            {walk.near_stop && (
              <p className="cg-stop">
                <strong>Nearest stop:</strong> {walk.near_stop.name}, {Math.round(walk.near_stop.dist_m)} m from the start
                {walk.near_stop.routes.length ? <span className="muted"> · routes {walk.near_stop.routes.join(', ')}</span> : null}
              </p>
            )}
            <SlopeChart
              title="Slope along the route"
              moon={preset?.slope_deg ?? []}
              earth={earthSlopes}
              moonLabel={`Moon · ${preset?.region_name ?? ''}`}
              earthLabel={`Calgary · ${placeName}`}
            />
            {(kind === 'steeper' || steepGap > 3) && steepGap > 1 && (
              <p className="ab-note">
                No city path is this steep. The closest Calgary walk is {steepGap.toFixed(1)}° gentler on average, so it only echoes the
                rhythm of this route.
              </p>
            )}
          </section>
        ) : (
          <p className="muted">No Calgary match for this route.</p>
        )}
        {preset && preset.match.top.length > 0 && (
          <section>
            <h4 className="section-label">Other close paths</h4>
            <table className="data-table result-list">
              <thead>
                <tr>
                  <th>Path</th>
                  <th className="r">Slope mismatch</th>
                  <th>Need for access to amenities</th>
                </tr>
              </thead>
              <tbody>
                {preset.match.top.map((t: PresetMatchRow) => (
                  <tr key={t.id} data-active={t.id === row?.id} onClick={(): void => setPick(t.id)}>
                    <td>
                      <button type="button" className="row-btn" aria-pressed={t.id === row?.id} onClick={(): void => setPick(t.id)}>
                        {t.park ?? (t.communities ? t.communities.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : t.id)}
                      </button>
                    </td>
                    <td className="r">{t.dtw_deg.toFixed(2)}°</td>
                    <td>{t.access_category ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        <p className="caption">
          Honest limit: city paths reproduce gentle Moon traverses only; steep Moon routes have no city equivalent. This is for outreach and
          learning, not equipment testing, and it is not an accessibility rating.
        </p>
      </div>
    </>
  );
}

function NeedLegend(): JSX.Element {
  return (
    <div className="need-legend" aria-label="Equity Index 2024, accessibility and amenities domain">
      <span className="caption">Equity Index 2024 · access to amenities · higher = greater need</span>
      <span className="need-scale">
        {NEED_ORDER.map((c) => (
          <span key={c} className="need-step">
            <span className="need-swatch" data-need={c} aria-hidden="true" />
            {c}
          </span>
        ))}
      </span>
    </div>
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
      : cg.data
        ? calgaryResult(cg.data.presets.presets)
        : 'Loading Calgary’s pathways…';

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
              Moon routes on each region’s elevation model are turned into 100-point slope profiles and matched to City of Calgary pathways
              (NRCan lidar ground model, 4 m) with dynamic time warping. Ties go to paths in tracts with higher need for access to
              amenities.
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
            <div className="ab-layout" role="tabpanel">
              <CalgaryPanel data={cg.data} />
            </div>
            <Credits
              area="calgary"
              metas={[
                { file: 'walks.json', meta: cg.data.walks.meta },
                { file: 'presets.json', meta: cg.data.presets.meta },
                { file: 'calgary_overlays.geojson', meta: cg.data.overlays.meta },
              ]}
            />
          </>
        ))}
    </div>
  );
}
