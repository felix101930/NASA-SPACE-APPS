// NASA GIBS HLS (Sentinel-2, 30 m) imagery for the Earth twin. HLS is published per acquisition day, so a
// given spot only has pixels every few days, and some of those are cloud. We probe the 256 px tile under the
// path for recent days and take the most recent one that is mostly filled and mostly cloud-free.

const LAYER = 'HLS_S30_Nadir_BRDF_Adjusted_Reflectance';
const MATRIX = 'GoogleMapsCompatible_Level12';
export const HLS_MAX_ZOOM = 12;

export function hlsTileUrl(date: string): string {
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${LAYER}/default/${date}/${MATRIX}/{z}/{y}/{x}.png`;
}

export const HLS_CREDIT = 'Imagery: NASA GIBS, HLS Sentinel-2 (S30)';

function tileXY(lat: number, lon: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n);
  return { x: Math.min(Math.max(x, 0), n - 1), y: Math.min(Math.max(y, 0), n - 1) };
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Days to try, newest first: daily for six weeks, then every 4 days back to about five months. */
function candidateDays(now: Date): string[] {
  const out: string[] = [];
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (let k = 3; k <= 160; k += k < 45 ? 1 : 4) out.push(isoDay(new Date(start.getTime() - k * 86400000)));
  return out;
}

interface TileScore {
  filled: number;
  cloud: number;
}

/** Share of opaque pixels and, of those, the share that look like cloud (bright and grey). */
async function scoreTile(url: string, signal: AbortSignal): Promise<TileScore | null> {
  const res = await fetch(url, { signal, mode: 'cors' });
  if (!res.ok) return null;
  const blob = await res.blob();
  if (blob.size < 4000) return { filled: 0, cloud: 0 }; // empty tiles are a few hundred bytes
  const bmp = await createImageBitmap(blob);
  const S = 64;
  const cv = new OffscreenCanvas(S, S);
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(bmp, 0, 0, S, S);
  bmp.close();
  const px = ctx.getImageData(0, 0, S, S).data;
  let opaque = 0;
  let cloud = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 200) continue;
    opaque++;
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    if (Math.min(r, g, b) > 200 && Math.max(r, g, b) - Math.min(r, g, b) < 30) cloud++;
  }
  return { filled: opaque / (S * S), cloud: opaque ? cloud / opaque : 0 };
}

const cache = new Map<string, Promise<string | null>>();

/** Most recent HLS day with a mostly filled, mostly clear tile over (lat, lon); null if none. */
export function findHlsDay(lat: number, lon: number): Promise<string | null> {
  const { x, y } = tileXY(lat, lon, HLS_MAX_ZOOM);
  const key = `${x}/${y}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = (async (): Promise<string | null> => {
    const days = candidateDays(new Date());
    const ctrl = new AbortController();
    const BATCH = 8;
    for (let i = 0; i < days.length; i += BATCH) {
      const batch = days.slice(i, i + BATCH);
      const scores = await Promise.all(
        batch.map(
          (d: string): Promise<TileScore | null> =>
            scoreTile(
              `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${LAYER}/default/${d}/${MATRIX}/${HLS_MAX_ZOOM}/${y}/${x}.png`,
              ctrl.signal,
            ).catch((): null => null),
        ),
      );
      const k = scores.findIndex((s: TileScore | null): boolean => s !== null && s.filled > 0.85 && s.cloud < 0.25);
      if (k >= 0) {
        ctrl.abort();
        return batch[k];
      }
    }
    return null;
  })();
  cache.set(key, p);
  p.catch((): void => {
    cache.delete(key);
  });
  return p;
}
