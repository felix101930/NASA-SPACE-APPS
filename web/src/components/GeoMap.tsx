// A dark MapLibre map for data layers (GeoJSON fills and lines). The parent adds its layers in onLoad and
// keeps the map instance to update filters and data afterwards.
import { useEffect, useRef, useState, type JSX } from 'react';
import { Map as MlMap, NavigationControl } from 'maplibre-gl';
import { DARK_STYLE, resolveMissingImages, tuneDarkStyle } from './EarthMap';

interface GeoMapProps {
  /** [[west, south], [east, north]] */
  bounds: [[number, number], [number, number]];
  label: string;
  onLoad: (map: MlMap) => void;
  onRemove?: () => void;
}

export function GeoMap({ bounds, label, onLoad, onRemove }: GeoMapProps): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<boolean>(false);
  const loadRef = useRef(onLoad);
  const removeRef = useRef(onRemove);
  loadRef.current = onLoad;
  removeRef.current = onRemove;

  useEffect((): (() => void) | void => {
    if (!box.current) return;
    let map: MlMap;
    try {
      map = new MlMap({
        container: box.current,
        style: DARK_STYLE,
        bounds,
        fitBoundsOptions: { padding: { top: 32, bottom: 56, left: 32, right: 32 } },
        attributionControl: { compact: true },
      });
    } catch {
      setFailed(true);
      return;
    }
    resolveMissingImages(map);
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    map.on('load', (): void => {
      tuneDarkStyle(map);
      loadRef.current(map);
    });
    const ro = new ResizeObserver((): void => {
      map.resize();
    });
    ro.observe(box.current);
    return (): void => {
      ro.disconnect();
      removeRef.current?.();
      map.remove();
    };
    // The map is created once; bounds only set the first view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={box} className="geo-map" role="region" aria-label={label}>
      {failed && <div className="loading">Map could not start (WebGL unavailable).</div>}
    </div>
  );
}
