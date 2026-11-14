// One naming rule for Earth sites on every screen (Earth matches, 3D side by side, walk, summary).
// The precise pipeline name ("109 km SE of Bor-Udzuur, Mongolia") is always what we show. For remote sites
// (more than 100 km from the reference town) a wider region ("Western Mongolia") is added as a secondary
// label and in the tooltip; it never replaces the precise name.

export interface PlaceInput {
  name: string;
  country?: string | null;
  lat?: number | null;
  lon?: number | null;
  /** Region label from the pipeline (admin-1, country) when it provides one. */
  region_label?: string | null;
  admin1?: string | null;
}

export interface PlaceName {
  /** Precise name with country, always shown. */
  label: string;
  /** Wider region for remote sites, shown as secondary text; null when not remote or unknown. */
  region: string | null;
  /** Tooltip: precise name, region and coordinates. */
  title: string;
  /** True when the reference town is more than 100 km away. */
  remote: boolean;
}

interface Box {
  name: string;
  lat: [number, number];
  lon: [number, number];
}

// Checked in order; first hit wins. Coarse boxes covering where the pipeline's remote squares fall.
const BOXES: readonly Box[] = [
  { name: 'Queen Elizabeth Islands, Nunavut, Canada', lat: [79, 84], lon: [-125, -64.5] },
  { name: 'Queen Elizabeth Islands, Nunavut, Canada', lat: [74.5, 79], lon: [-125, -74] },
  { name: 'Baffin Island, Nunavut, Canada', lat: [62, 74.5], lon: [-91, -61] },
  { name: 'North Greenland', lat: [81, 84], lon: [-64.5, -10] },
  { name: 'North-east Greenland', lat: [69, 81], lon: [-45, -10] },
  { name: 'North-west Greenland', lat: [74, 81], lon: [-74, -45] },
  { name: 'Putorana Plateau, Siberia, Russia', lat: [66, 71.5], lon: [86, 101] },
  { name: 'Koryak Highlands, Russia', lat: [59, 64.5], lon: [163, 177] },
  { name: 'Sakha Republic (Yakutia), Russia', lat: [56, 74], lon: [105, 162] },
  { name: 'Western Mongolia', lat: [42, 52], lon: [87, 100] },
  { name: 'Puna de Atacama, Argentina', lat: [-27.5, -22], lon: [-68.6, -65.5] },
];

const OFFSET = /^(\d+)\s*km\s+[NSEW]{1,3}\s+of\s+/i;
const REMOTE_KM = 100;

function regionFor(lat: number, lon: number): string | null {
  for (const b of BOXES) {
    if (lat >= b.lat[0] && lat <= b.lat[1] && lon >= b.lon[0] && lon <= b.lon[1]) return b.name;
  }
  return null;
}

function finite(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function fmtLatLon(lat: number, lon: number, digits: number = 2): string {
  return `${Math.abs(lat).toFixed(digits)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(digits)}° ${lon >= 0 ? 'E' : 'W'}`;
}

export function placeName(site: PlaceInput | null | undefined, fallbackId: string = ''): PlaceName {
  if (!site || !site.name) {
    const label = fallbackId ? `Earth square ${fallbackId}` : 'Earth square';
    return { label, region: null, title: label, remote: false };
  }
  const country = site.country?.trim() || null;
  const label = country && !site.name.endsWith(country) ? `${site.name}, ${country}` : site.name;
  const m = OFFSET.exec(site.name);
  const remote = m !== null && Number(m[1]) > REMOTE_KM;
  const lat = site.lat;
  const lon = site.lon;
  const pos: [number, number] | null = finite(lat) && finite(lon) ? [lat, lon] : null;
  let region: string | null = null;
  if (remote) {
    region =
      site.region_label?.trim() ||
      (pos ? regionFor(pos[0], pos[1]) : null) ||
      (site.admin1 && site.admin1 !== country ? site.admin1 : null);
    if (region && country && region === country) region = null;
  }
  const coords = pos ? fmtLatLon(pos[0], pos[1]) : '';
  const title = [label, region, coords].filter((s: string | null): s is string => Boolean(s)).join(' · ');
  return { label, region, title, remote };
}
