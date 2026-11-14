// Place names for Earth walk sites, with the remote-name rule used across the app's lists.

export interface SiteInfo {
  name: string;
  country: string | null;
}

export interface PlaceLabel {
  /** What to show in tight lists. */
  short: string;
  /** The precise name (for tooltips and the verdict). */
  full: string;
  /** True when the short form hides a far-off reference town. */
  remote: boolean;
}

const OFFSET = /^(\d+)\s*km\s+(N|NE|E|SE|S|SW|W|NW|NNE|ENE|ESE|SSE|SSW|WSW|WNW|NNW)\s+of\s+(.+)$/i;

/**
 * "105 km SW of Pond Inlet" reads as a precise place, but more than 100 km from the reference town it
 * mostly says "nowhere near anything". Lists then show the country, with the precise name in a tooltip.
 */
export function placeLabel(site: SiteInfo | undefined, fallbackId: string): PlaceLabel {
  if (!site) return { short: `Earth square ${fallbackId}`, full: `Earth square ${fallbackId}`, remote: false };
  const full = site.country && !site.name.endsWith(site.country) ? `${site.name}, ${site.country}` : site.name;
  const m = OFFSET.exec(site.name);
  if (m && Number(m[1]) > 100) {
    return { short: site.country ? `Remote ${site.country}` : `Remote area near ${m[3]}`, full, remote: true };
  }
  return { short: full, full, remote: false };
}

/** Compass word for the direction of travel from (lat0, lon0) to (lat1, lon1). */
export function headingWord(lat0: number, lon0: number, lat1: number, lon1: number): string {
  const r = Math.PI / 180;
  const y = Math.sin((lon1 - lon0) * r) * Math.cos(lat1 * r);
  const x = Math.cos(lat0 * r) * Math.sin(lat1 * r) - Math.sin(lat0 * r) * Math.cos(lat1 * r) * Math.cos((lon1 - lon0) * r);
  const deg = ((Math.atan2(y, x) / r) + 360) % 360;
  const words = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  return words[Math.round(deg / 45) % 8];
}

export function fmtKm(m: number): string {
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

export function fmtLatLon(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(3)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(3)}° ${lon >= 0 ? 'E' : 'W'}`;
}
