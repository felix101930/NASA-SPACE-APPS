// Readable place names for Earth sites.
// The pipeline names remote squares after the nearest town ("1023 km N of Upernavik"). Past ~100 km that
// says more about the gazetteer than about the place, so we show a region instead and keep the precise
// name in a tooltip. The reverse geocoder's `country` can also be wrong far from towns (a square in
// north-east Greenland labelled "Svalbard and Jan Mayen" because Jan Mayen was the nearest town), so a
// small lat/lon lookup runs first and `country` is only the fallback.

export interface PlaceName {
  /** What to show. */
  label: string;
  /** Country or wider region shown as a subtitle, or null when the label already says it. */
  sub: string | null;
  /** Precise name + coordinates, for a tooltip. */
  title: string;
  /** True when the label replaced a remote "N km X of town" name. */
  remote: boolean;
}

interface Box {
  name: string;
  lat: [number, number];
  lon: [number, number];
}

// Checked in order; first hit wins. Boxes are deliberately coarse and only cover where the pipeline's
// remote squares actually fall.
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

const REMOTE = /^(\d+) km .* of /;
const REMOTE_KM = 100;

function regionFor(lat: number, lon: number): string | null {
  for (const b of BOXES) {
    if (lat >= b.lat[0] && lat <= b.lat[1] && lon >= b.lon[0] && lon <= b.lon[1]) return b.name;
  }
  return null;
}

export function fmtLatLon(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(2)}° ${ns}, ${Math.abs(lon).toFixed(2)}° ${ew}`;
}

export function placeName(name: string, country: string, lat: number, lon: number): PlaceName {
  const coords = fmtLatLon(lat, lon);
  const m = REMOTE.exec(name);
  const km = m ? Number(m[1]) : 0;
  if (m && km > REMOTE_KM) {
    const region = regionFor(lat, lon) ?? (country || 'Remote site');
    return { label: region, sub: null, title: `${name} · ${coords}`, remote: true };
  }
  return { label: name, sub: country || null, title: `${name}${country ? `, ${country}` : ''} · ${coords}`, remote: false };
}
