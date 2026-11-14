// Calgary map: Equity Index 2024 tracts (need for access to amenities), every pathway route, the top-5 event pins and the
// planner's selection. Hover shows a small tooltip; a click picks the neighbourhood for the planner.
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import {
  LngLatBounds,
  Marker,
  type ExpressionSpecification,
  type GeoJSONSource,
  type Map as MlMap,
  type MapLayerMouseEvent,
} from 'maplibre-gl';
import type { Feature, FeatureCollection, LineString } from 'geojson';
import { GeoMap } from '../../components/GeoMap';
import type { CalgaryWalk, OverlaysGeo } from '../../types/alberta';
import { communityList, minutesWalk } from './planner';
import { NEED_COLOUR, pinElement, type NeedFilter } from './shared';

export interface MapPin {
  rank: number;
  lonLat: [number, number];
  title: string;
}

export interface CalgaryMapProps {
  overlays: OverlaysGeo;
  walks: CalgaryWalk[];
  /** Highlighted route (planner or matcher). */
  walk: CalgaryWalk | null;
  selectedTract: string | null;
  pins: MapPin[];
  activePin: number | null;
  onPin: (rank: number) => void;
  onTract: (ctuid: string) => void;
  needFilter: NeedFilter;
  unreachedOnly: boolean;
  unreachedIds: string[];
  /** Tracts with a suitable route (null while the planner index is building). */
  reached: Set<string> | null;
  /** Each change fits the map to the highlighted route and the selected tract. */
  fitKey: number;
}

interface Hover {
  label: string;
  category: string | null;
  ctuid: string;
}

function walkLine(w: CalgaryWalk): Feature<LineString, { id: string }> {
  return {
    type: 'Feature',
    properties: { id: w.id },
    geometry: { type: 'LineString', coordinates: w.coords.map(([lat, lon]: [number, number]): [number, number] => [lon, lat]) },
  };
}

function extendWith(b: LngLatBounds, c: unknown): void {
  if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') b.extend([c[0], c[1]]);
  else if (Array.isArray(c)) c.forEach((x: unknown): void => extendWith(b, x));
}

function overlayBounds(o: OverlaysGeo): [[number, number], [number, number]] {
  const b = new LngLatBounds();
  o.features.forEach((f): void => extendWith(b, f.geometry.coordinates));
  if (b.isEmpty()) {
    return [
      [-114.32, 50.84],
      [-113.86, 51.21],
    ];
  }
  return [
    [b.getWest(), b.getSouth()],
    [b.getEast(), b.getNorth()],
  ];
}

function startElement(w: CalgaryWalk): HTMLDivElement {
  const box = document.createElement('div');
  box.className = 'cg-start';
  const dot = document.createElement('span');
  dot.className = 'cg-start-dot';
  dot.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'cg-start-label';
  const ns = w.near_stop;
  label.textContent = ns ? `Start · stop ${Math.round(ns.dist_m)} m (${minutesWalk(ns.dist_m)} min)` : 'Start';
  box.title = ns ? `Route start, ${Math.round(ns.dist_m)} m from ${ns.name}` : 'Route start';
  box.append(dot, label);
  return box;
}

export function CalgaryMap(props: CalgaryMapProps): JSX.Element {
  const { overlays, walks, walk, selectedTract, pins, activePin, onPin, onTract, needFilter, unreachedOnly, unreachedIds, reached, fitKey } =
    props;
  const mapRef = useRef<MlMap | null>(null);
  const startMarker = useRef<Marker | null>(null);
  const pinMarkers = useRef<Marker[]>([]);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const onTractRef = useRef(onTract);
  onTractRef.current = onTract;
  const [ready, setReady] = useState<boolean>(false);
  const [hover, setHover] = useState<Hover | null>(null);
  const bounds = useMemo(() => overlayBounds(overlays), [overlays]);

  const onLoad = useCallback(
    (map: MlMap): void => {
      mapRef.current = map;
      map.addSource('tracts', { type: 'geojson', data: overlays });
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
          'fill-opacity-transition': { duration: 200 },
        },
      });
      map.addLayer({
        id: 'tracts-edge',
        type: 'line',
        source: 'tracts',
        paint: { 'line-color': '#0a0b0e', 'line-width': 0.5, 'line-opacity': 0.7 },
      });
      const all: FeatureCollection<LineString, { id: string }> = { type: 'FeatureCollection', features: walks.map(walkLine) };
      map.addSource('walks', { type: 'geojson', data: all });
      map.addLayer({
        id: 'walks',
        type: 'line',
        source: 'walks',
        paint: { 'line-color': '#edeae4', 'line-width': 1, 'line-opacity': 0.2 },
      });
      map.addLayer({
        id: 'tracts-unreached',
        type: 'line',
        source: 'tracts',
        filter: ['==', ['get', 'ctuid'], '__none__'],
        paint: { 'line-color': '#f3b54a', 'line-width': 2, 'line-dasharray': [2, 1.5] },
      });
      map.addLayer({
        id: 'tracts-hover',
        type: 'line',
        source: 'tracts',
        filter: ['==', ['get', 'ctuid'], '__none__'],
        paint: { 'line-color': '#b9b5ae', 'line-width': 1.5 },
      });
      map.addLayer({
        id: 'tracts-sel',
        type: 'line',
        source: 'tracts',
        filter: ['==', ['get', 'ctuid'], '__none__'],
        paint: { 'line-color': '#edeae4', 'line-width': 2.5 },
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
        paint: { 'line-color': '#f3b54a', 'line-width': 4 },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });
      map.on('click', 'tracts', (e: MapLayerMouseEvent): void => {
        const id = e.features?.[0]?.properties?.ctuid;
        if (typeof id === 'string') onTractRef.current(id);
      });
      map.on('mousemove', 'tracts', (e: MapLayerMouseEvent): void => {
        const p = e.features?.[0]?.properties;
        const tip = tipRef.current;
        if (tip) {
          tip.style.transform = `translate(${Math.round(e.point.x + 14)}px, ${Math.round(e.point.y + 14)}px)`;
        }
        if (!p || typeof p.ctuid !== 'string') return;
        const ctuid = p.ctuid;
        map.getCanvas().style.cursor = 'pointer';
        setHover((h: Hover | null): Hover | null => {
          if (h?.ctuid === ctuid) return h;
          const names = communityList(typeof p.communities === 'string' ? p.communities : '');
          return {
            ctuid,
            label: names.length ? names.join(', ') : `Census tract ${String(p.name ?? '')}`,
            category: typeof p.access_category === 'string' ? p.access_category : null,
          };
        });
      });
      map.on('mouseleave', 'tracts', (): void => {
        map.getCanvas().style.cursor = '';
        setHover(null);
      });
      setReady(true);
    },
    [overlays, walks],
  );

  // Need-level filter and the "highest need, not yet reached" toggle dim everything else.
  useEffect((): void => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const conds: ExpressionSpecification[] = [];
    if (needFilter !== 'All') conds.push(['==', ['get', 'access_category'], needFilter]);
    if (unreachedOnly) conds.push(['in', ['get', 'ctuid'], ['literal', unreachedIds]]);
    map.setPaintProperty('tracts', 'fill-opacity', conds.length ? ['case', ['all', ...conds], 0.85, 0.1] : 0.72);
    map.setFilter('tracts-unreached', unreachedOnly ? ['in', ['get', 'ctuid'], ['literal', unreachedIds]] : ['==', ['get', 'ctuid'], '__none__']);
  }, [needFilter, unreachedOnly, unreachedIds, ready]);

  useEffect((): void => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setFilter('tracts-hover', ['==', ['get', 'ctuid'], hover?.ctuid ?? '__none__']);
  }, [hover, ready]);

  useEffect((): void => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setFilter('tracts-sel', ['==', ['get', 'ctuid'], selectedTract ?? '__none__']);
  }, [selectedTract, ready]);

  // Numbered pins for the top event locations.
  useEffect((): void => {
    const map = mapRef.current;
    if (!map || !ready) return;
    pinMarkers.current.forEach((m: Marker): void => {
      m.remove();
    });
    pinMarkers.current = pins.map((p: MapPin): Marker => {
      const el = pinElement(String(p.rank), p.title, p.rank === activePin);
      el.addEventListener('click', (ev: MouseEvent): void => {
        ev.stopPropagation();
        onPin(p.rank);
      });
      return new Marker({ element: el }).setLngLat(p.lonLat).addTo(map);
    });
  }, [pins, activePin, onPin, ready]);

  // Highlighted route and its start (labelled with the walk to the stop).
  useEffect((): void => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const fc: FeatureCollection<LineString, { id: string }> = { type: 'FeatureCollection', features: walk ? [walkLine(walk)] : [] };
    map.getSource<GeoJSONSource>('sel')?.setData(fc);
    startMarker.current?.remove();
    startMarker.current = null;
    if (walk && walk.coords.length > 1 && activePin === null) {
      const [lat, lon] = walk.coords[0];
      startMarker.current = new Marker({ element: startElement(walk), anchor: 'left', offset: [-7, 0] }).setLngLat([lon, lat]).addTo(map);
    }
  }, [walk, activePin, ready]);

  // Fit on request: route + selected tract, else the whole city.
  useEffect((): void => {
    const map = mapRef.current;
    if (!map || !ready || fitKey === 0) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const b = new LngLatBounds();
    if (walk) walk.coords.forEach(([la, lo]: [number, number]): void => void b.extend([lo, la]));
    const f = selectedTract ? overlays.features.find((x): boolean => x.properties.ctuid === selectedTract) : undefined;
    if (f) extendWith(b, f.geometry.coordinates);
    if (b.isEmpty()) map.fitBounds(bounds, { padding: 24, duration: reduce ? 0 : 700 });
    else map.fitBounds(b, { padding: { top: 64, bottom: 64, left: 64, right: 160 }, maxZoom: 14.5, duration: reduce ? 0 : 700 });
    // Only a new fitKey triggers a fit; the selection it reads is the one current at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, ready]);

  const hoverReached = hover && reached ? reached.has(hover.ctuid) : null;

  return (
    <div className="geo-map-box cg-map">
      <GeoMap
        bounds={bounds}
        label="Calgary neighbourhoods by need for access to amenities (Equity Index 2024), with pathway routes. Click a neighbourhood to plan a walk."
        onLoad={onLoad}
        onRemove={(): void => {
          startMarker.current?.remove();
          pinMarkers.current.forEach((m: Marker): void => {
            m.remove();
          });
          mapRef.current = null;
        }}
      />
      <div ref={tipRef} className="cg-tip" hidden={!hover} aria-hidden="true">
        {hover && (
          <>
            <strong>{hover.label}</strong>
            <span>
              {hover.category ? `${hover.category} need` : 'Need not recorded'}
              {hoverReached === null ? '' : hoverReached ? ' · reached' : ' · not yet reached'}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
