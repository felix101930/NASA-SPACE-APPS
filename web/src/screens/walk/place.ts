// Place helpers for Earth walk sites. Naming goes through the app-wide rule in lib/placeName.ts.
import { placeName, type PlaceName } from '../../lib/placeName';

export interface SiteInfo {
  name: string;
  country: string | null;
  lat?: number | null;
  lon?: number | null;
}

/** The app-wide place name for a walk site: precise name always, wider region only as secondary text. */
export function sitePlace(site: SiteInfo | undefined, fallbackId: string): PlaceName {
  return placeName(site, fallbackId);
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
