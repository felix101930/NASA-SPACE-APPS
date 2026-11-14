import { useEffect, useRef, useState, type JSX } from 'react';
import { LngLatBounds, Map as MlMap, Marker, NavigationControl, setWorkerUrl, type GeoJSONSource } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

// MapLibre 6 resolves its worker next to its own module; after bundling that path is wrong, so set it.
setWorkerUrl(workerUrl);

export interface MapPoint {
  id: string;
  lat: number;
  lon: number;
  label: string;
  title: string;
  active: boolean;
}

export interface MapLine {
  id: string;
  coords: [number, number][]; // [lon, lat]
}

// OpenFreeMap's dark vector style keeps the basemap quiet so the pins carry the screen.
const STYLE = 'https://tiles.openfreemap.org/styles/dark';

/** Small paint overrides so the basemap sits on the app's own surface colours. */
function tuneDarkStyle(map: MlMap): void {
  if (map.getLayer('background')) map.setPaintProperty('background', 'background-color', '#121419');
  if (map.getLayer('water')) map.setPaintProperty('water', 'fill-color', '#0b0d11');
  for (const id of ['landcover_glacier', 'landcover_ice_shelf']) {
    if (map.getLayer(id)) map.setPaintProperty(id, 'fill-color', '#181b21');
  }
}

interface Props {
  points: MapPoint[];
  lines?: MapLine[];
  onSelect?: (id: string) => void;
  /** Change to refit the view to the points/lines. */
  fitKey: string;
  maxZoom?: number;
}

export function EarthMap({ points, lines = [], onSelect, fitKey, maxZoom = 6 }: Props): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markers = useRef<Marker[]>([]);
  const [ready, setReady] = useState<boolean>(false);
  const [failed, setFailed] = useState<boolean>(false);

  useEffect((): (() => void) | void => {
    if (!box.current) return;
    let map: MlMap;
    try {
      map = new MlMap({
        container: box.current,
        style: STYLE,
        center: [0, 20],
        zoom: 1.2,
        attributionControl: { compact: true },
        cooperativeGestures: false,
      });
    } catch {
      setFailed(true);
      return;
    }
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    map.on('load', (): void => {
      tuneDarkStyle(map);
      setReady(true);
    });
    // Keep the canvas in step with its container (layout can change after first paint).
    const ro = new ResizeObserver((): void => {
      map.resize();
    });
    ro.observe(box.current);
    map.on('error', (): void => undefined);
    // The dark style references a few pattern sprites it doesn't ship; give them a transparent pixel.
    map.setMissingStyleImageResolver((id: string): void => {
      if (!map.hasImage(id)) map.addImage(id, { width: 1, height: 1, data: new Uint8Array(4) });
    });
    mapRef.current = map;
    return (): void => {
      ro.disconnect();
      markers.current.forEach((m: Marker): void => {
        m.remove();
      });
      markers.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // markers
  useEffect((): void => {
    const map = mapRef.current;
    if (!map) return;
    markers.current.forEach((m: Marker): void => {
      m.remove();
    });
    markers.current = points.map((p: MapPoint): Marker => {
      const el = document.createElement('button');
      el.className = 'pin';
      el.type = 'button';
      if (p.active) el.setAttribute('aria-current', 'true');
      el.textContent = p.label;
      el.title = p.title;
      el.setAttribute('aria-label', p.title);
      el.dataset.active = String(p.active);
      el.addEventListener('click', (ev: MouseEvent): void => {
        ev.stopPropagation();
        onSelect?.(p.id);
      });
      return new Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map);
    });
  }, [points, onSelect]);

  // lines
  useEffect((): void => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const data: FeatureCollection = {
      type: 'FeatureCollection',
      features: lines.map((l: MapLine): Feature => ({
        type: 'Feature',
        properties: { id: l.id },
        geometry: { type: 'LineString', coordinates: l.coords },
      })),
    };
    const src = map.getSource('paths') as GeoJSONSource | undefined;
    if (src) src.setData(data);
    else {
      map.addSource('paths', { type: 'geojson', data });
      map.addLayer({ id: 'paths-casing', type: 'line', source: 'paths', paint: { 'line-color': '#0a0b0e', 'line-width': 7 } });
      map.addLayer({ id: 'paths', type: 'line', source: 'paths', paint: { 'line-color': '#edeae4', 'line-width': 3.5 } });
    }
  }, [lines, ready]);

  // fit to the pins (and lines) whenever the set changes, and once the style has loaded
  useEffect((): void => {
    const map = mapRef.current;
    if (!map) return;
    const coords: [number, number][] = [
      ...points.map((p: MapPoint): [number, number] => [p.lon, p.lat]),
      ...lines.flatMap((l: MapLine): [number, number][] => l.coords),
    ];
    if (coords.length === 0) return;
    const b = new LngLatBounds(coords[0], coords[0]);
    coords.forEach((c: [number, number]): void => {
      b.extend(c);
    });
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    map.fitBounds(b, { padding: 64, maxZoom, duration: ready && !reduce ? 600 : 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, ready]);

  return (
    <div ref={box} aria-label="Map of Earth sites" role="region">
      {failed && <div className="loading">Map could not start (WebGL unavailable).</div>}
    </div>
  );
}
