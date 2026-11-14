// Earth map for the matched path: fits to the path, draws it, and zooms to the start on click.
// Local to the walk screen because it needs camera control and an imagery layer that EarthMap does not have.
import { useEffect, useRef, useState, type JSX } from 'react';
import { LngLatBounds, Map as MlMap, Marker, NavigationControl, ScaleControl, type GeoJSONSource } from 'maplibre-gl';
import type { FeatureCollection, LineString } from 'geojson';
import { DARK_STYLE, resolveMissingImages, tuneDarkStyle } from '../../components/EarthMap';
import { findHlsDay, HLS_CREDIT, HLS_MAX_ZOOM, hlsTileUrl } from './gibs';

declare global {
  interface Window {
    /** Dev-only handle so scripted checks can read the camera. */
    __walkMap?: MlMap;
  }
}

export interface TwinPath {
  key: string;
  start: [number, number]; // [lon, lat]
  end: [number, number];
  label: string;
}

type Imagery = 'map' | 'satellite';
type ImageryState = { kind: 'off' } | { kind: 'probing' } | { kind: 'on'; day: string } | { kind: 'none' };

const FIT_MAX_ZOOM = 13;
const START_ZOOM = 15;

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function fitPath(map: MlMap, p: TwinPath, animate: boolean): void {
  const b = new LngLatBounds(p.start, p.start).extend(p.end);
  map.fitBounds(b, { padding: { top: 72, bottom: 48, left: 56, right: 56 }, maxZoom: FIT_MAX_ZOOM, duration: animate && !reducedMotion() ? 700 : 0 });
}

function lineData(p: TwinPath | null): FeatureCollection<LineString> {
  return {
    type: 'FeatureCollection',
    features: p ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [p.start, p.end] } }] : [],
  };
}

export function TwinMap({ path }: { path: TwinPath | null }): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markers = useRef<Marker[]>([]);
  const pathRef = useRef<TwinPath | null>(path);
  const [ready, setReady] = useState<boolean>(false);
  const [failed, setFailed] = useState<boolean>(false);
  const [imagery, setImagery] = useState<Imagery>('map');
  const [img, setImg] = useState<ImageryState>({ kind: 'off' });
  const [zoomedIn, setZoomedIn] = useState<boolean>(false);
  pathRef.current = path;

  useEffect((): (() => void) | void => {
    if (!box.current) return;
    let map: MlMap;
    try {
      map = new MlMap({
        container: box.current,
        style: DARK_STYLE,
        center: pathRef.current?.start ?? [0, 20],
        zoom: pathRef.current ? 11 : 1.2,
        attributionControl: { compact: true },
        cooperativeGestures: false,
        maxZoom: 16,
      });
    } catch {
      setFailed(true);
      return;
    }
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new ScaleControl({ unit: 'metric', maxWidth: 120 }), 'bottom-left');
    resolveMissingImages(map);
    map.on('error', (): void => undefined);
    map.on('load', (): void => {
      tuneDarkStyle(map);
      map.addSource('twin', { type: 'geojson', data: lineData(pathRef.current) });
      map.addLayer({ id: 'twin-casing', type: 'line', source: 'twin', paint: { 'line-color': '#0a0b0e', 'line-width': 8 }, layout: { 'line-cap': 'round' } });
      map.addLayer({ id: 'twin-line', type: 'line', source: 'twin', paint: { 'line-color': '#edeae4', 'line-width': 3.5 }, layout: { 'line-cap': 'round' } });
      setReady(true);
    });
    const ro = new ResizeObserver((): void => {
      map.resize();
    });
    ro.observe(box.current);
    mapRef.current = map;
    if (import.meta.env.DEV) window.__walkMap = map;
    return (): void => {
      ro.disconnect();
      markers.current.forEach((m: Marker): void => {
        m.remove();
      });
      markers.current = [];
      map.remove();
      mapRef.current = null;
      if (import.meta.env.DEV && window.__walkMap === map) window.__walkMap = undefined;
    };
  }, []);

  // Path: fit the camera (no need to wait for the style), redraw the line and markers.
  useEffect((): void => {
    const map = mapRef.current;
    if (!map) return;
    markers.current.forEach((m: Marker): void => {
      m.remove();
    });
    markers.current = [];
    setZoomedIn(false);
    if (!path) return;
    map.resize();
    fitPath(map, path, true);
    const startEl = document.createElement('button');
    startEl.type = 'button';
    startEl.className = 'wk-start-pin';
    startEl.innerHTML = '<span aria-hidden="true"></span>Start';
    startEl.title = 'Zoom in on the start of the path';
    startEl.setAttribute('aria-label', `Start of the path at ${path.label}. Zoom in.`);
    startEl.addEventListener('click', (ev: MouseEvent): void => {
      ev.stopPropagation();
      const zoomIn = map.getZoom() < START_ZOOM - 0.5;
      if (zoomIn) map.flyTo({ center: path.start, zoom: START_ZOOM, duration: reducedMotion() ? 0 : 900 });
      else fitPath(map, path, true);
      setZoomedIn(zoomIn);
      startEl.title = zoomIn ? 'Show the whole path' : 'Zoom in on the start of the path';
    });
    const endEl = document.createElement('span');
    endEl.className = 'wk-end-pin';
    endEl.title = 'End of the path';
    markers.current = [
      new Marker({ element: endEl }).setLngLat(path.end).addTo(map),
      new Marker({ element: startEl, anchor: 'bottom', offset: [0, -4] }).setLngLat(path.start).addTo(map),
    ];
    const src = map.getSource('twin') as GeoJSONSource | undefined;
    src?.setData(lineData(path));
  }, [path]);

  useEffect((): void => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource('twin') as GeoJSONSource | undefined)?.setData(lineData(pathRef.current));
  }, [ready]);

  // Imagery: find a clear recent HLS day for this spot, else stay on the dark map.
  useEffect((): (() => void) | void => {
    const map = mapRef.current;
    const removeLayer = (): void => {
      if (!map) return;
      if (map.getLayer('hls')) map.removeLayer('hls');
      if (map.getSource('hls')) map.removeSource('hls');
    };
    if (!map || !ready || imagery === 'map' || !path) {
      removeLayer();
      setImg({ kind: 'off' });
      return;
    }
    let alive = true;
    setImg({ kind: 'probing' });
    const mid: [number, number] = [(path.start[0] + path.end[0]) / 2, (path.start[1] + path.end[1]) / 2];
    findHlsDay(mid[1], mid[0])
      .then((day: string | null): void => {
        if (!alive) return;
        removeLayer();
        if (!day) {
          setImg({ kind: 'none' });
          return;
        }
        map.addSource('hls', {
          type: 'raster',
          tiles: [hlsTileUrl(day)],
          tileSize: 256,
          maxzoom: HLS_MAX_ZOOM,
          attribution: `${HLS_CREDIT}, ${day}`,
        });
        map.addLayer({ id: 'hls', type: 'raster', source: 'hls', paint: { 'raster-opacity': 0.92 } }, 'twin-casing');
        setImg({ kind: 'on', day });
      })
      .catch((): void => {
        if (alive) setImg({ kind: 'none' });
      });
    return (): void => {
      alive = false;
    };
  }, [imagery, ready, path]);

  const imgNote =
    img.kind === 'probing'
      ? 'Looking for a clear NASA satellite pass…'
      : img.kind === 'on'
        ? `${HLS_CREDIT}, ${img.day}`
        : img.kind === 'none'
          ? 'No clear NASA satellite pass here in the last five months; showing the map.'
          : null;

  return (
    <div className="wk-map">
      <div ref={box} className="wk-map-canvas" role="region" aria-label={path ? `Map of the Earth path at ${path.label}` : 'Map of Earth'}>
        {failed && <div className="loading">Map could not start (WebGL unavailable).</div>}
      </div>
      <div className="wk-map-tools">
        <div className="seg seg-sm" role="group" aria-label="Map background">
          <button type="button" aria-pressed={imagery === 'map'} onClick={(): void => setImagery('map')}>
            Map
          </button>
          <button type="button" aria-pressed={imagery === 'satellite'} onClick={(): void => setImagery('satellite')}>
            Satellite
          </button>
        </div>
        {zoomedIn && path && (
          <button
            type="button"
            className="btn btn-sm wk-map-fit"
            onClick={(): void => {
              const map = mapRef.current;
              if (!map) return;
              fitPath(map, path, true);
              setZoomedIn(false);
            }}
          >
            Whole path
          </button>
        )}
      </div>
      <p className="caption wk-map-note" aria-live="polite">
        {imgNote ?? 'Click Start to zoom in on where the walk begins.'}
      </p>
    </div>
  );
}
