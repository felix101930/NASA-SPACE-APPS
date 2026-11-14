// One credits list for the whole app. Each data file's meta.sources is folded into a canonical entry when it
// names the same source; sources we know the results depend on but no file lists (MODIS brightness, USGS LGRS,
// OpenStreetMap) are always present. Anything a file lists that isn't canonical is kept as an extra.
import type { Meta, MethodFile } from '../types/contract';
import { isObj } from '../types/contract';

/** Which part of the app a source feeds. */
export type CreditArea = 'moon' | 'earth' | 'walk' | 'alberta' | 'calgary';

export interface Credit {
  key: string;
  /** Short name for the one-line footer. */
  short: string;
  name: string;
  /** What we use it for, in plain words. */
  use: string;
  url: string;
  licence: string;
  citation?: string;
  areas: CreditArea[];
  /** Data files that list this source in meta.sources. */
  files: string[];
}

interface Canon extends Omit<Credit, 'files'> {
  match: RegExp | null;
}

const CANON: readonly Canon[] = [
  {
    key: 'lola',
    short: 'NASA LRO LOLA',
    name: 'NASA LRO LOLA south-pole elevation and illumination (PGDA products 90 and 69)',
    use: 'Moon heights for every region tile; product 69 checks our shadows',
    url: 'https://pgda.gsfc.nasa.gov/products/90',
    licence: 'NASA data, public domain',
    citation: 'Barker et al. (2023) PSJ 4:183; Mazarico et al. (2011) Icarus 211:1066',
    areas: ['moon', 'walk', 'alberta', 'calgary'],
    match: /PGDA product (90|69)|LDEM_|AVGVISIB|LOLA 20 m DEM/i,
  },
  {
    key: 'lgrs',
    short: 'USGS LGRS',
    name: 'USGS Lunar Geospatial Reference System region extents',
    use: 'Artemis candidate region outlines',
    url: 'https://doi.org/10.5066/P1MEQ6UK',
    licence: 'USGS, public domain',
    citation: 'doi:10.5066/P1MEQ6UK',
    areas: ['moon'],
    match: /LGRS|P1MEQ6UK/i,
  },
  {
    key: 'artemis',
    short: 'NASA Artemis regions map',
    name: 'NASA Artemis III candidate landing regions map (Oct 28 2024)',
    use: 'the 9 regions NASA named; the first crewed south-pole landing is now planned for Artemis IV',
    url: 'https://www.nasa.gov/news-release/nasa-provides-update-on-artemis-iii-moon-landing-regions/',
    licence: 'NASA media, not copyrighted',
    areas: ['moon'],
    match: /Artemis III candidate/i,
  },
  {
    key: 'copernicus',
    short: 'Copernicus DEM',
    name: 'Copernicus DEM GLO-30',
    use: 'Earth heights (30 m)',
    url: 'https://registry.opendata.aws/copernicus-dem/',
    licence: '© DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA',
    areas: ['earth', 'walk', 'alberta'],
    match: /Copernicus DEM/i,
  },
  {
    key: 'modis',
    short: 'NASA MODIS',
    name: 'NASA MODIS MCD43C3 albedo',
    use: 'ground brightness, used in ranking',
    url: 'https://lpdaac.usgs.gov/products/mcd43c3v061/',
    licence: 'NASA open data, no restrictions',
    areas: ['earth'],
    match: /MODIS|MCD43/i,
  },
  {
    key: 'nasadem',
    short: 'NASA NASADEM',
    name: 'NASA NASADEM',
    use: 'cross-check of the Earth heights',
    url: 'https://lpdaac.usgs.gov/products/nasadem_hgtv001/',
    licence: 'NASA open data, no restrictions',
    areas: ['earth'],
    match: /NASADEM/i,
  },
  {
    key: 'worldcover',
    short: 'ESA WorldCover',
    name: 'ESA WorldCover 10 m 2021',
    use: 'throws out trees, crops, buildings, water and ice',
    url: 'https://esa-worldcover.org/',
    licence: 'CC-BY 4.0',
    areas: ['earth', 'alberta'],
    match: /WorldCover/i,
  },
  {
    key: 'macrostrat',
    short: 'Macrostrat',
    name: 'Macrostrat geologic map units',
    use: 'rock type at each Earth site',
    url: 'https://macrostrat.org/',
    licence: 'CC-BY 4.0',
    areas: ['earth'],
    match: /Macrostrat/i,
  },
  {
    key: 'gibs',
    short: 'NASA GIBS',
    name: 'NASA GIBS imagery (HLS)',
    use: 'satellite imagery under the walk map',
    url: 'https://nasa-gibs.github.io/gibs-api-docs/',
    licence: 'NASA open data, no restrictions',
    areas: ['earth', 'walk'],
    match: /GIBS/i,
  },
  {
    key: 'geonames',
    short: 'GeoNames',
    name: 'GeoNames gazetteer',
    use: 'place names for Earth sites',
    url: 'https://www.geonames.org/',
    licence: 'CC-BY 4.0',
    areas: ['earth', 'walk', 'alberta'],
    match: /GeoNames/i,
  },
  {
    key: 'equity',
    short: 'Calgary Equity Index 2024',
    name: 'City of Calgary Equity Index 2024',
    use: 'need for access to amenities, by neighbourhood',
    url: 'https://data.calgary.ca/',
    licence: 'Open Government Licence – City of Calgary',
    areas: ['calgary'],
    match: /Equity Index/i,
  },
  {
    key: 'calgary',
    short: 'City of Calgary Open Data',
    name: 'City of Calgary Open Data (pathways, parks, transit stops)',
    use: 'the city paths, parks and stops we match against',
    url: 'https://data.calgary.ca/',
    licence: 'Open Government Licence – City of Calgary',
    areas: ['calgary'],
    match: /City of Calgary/i,
  },
  {
    key: 'hrdem',
    short: 'NRCan HRDEM',
    name: 'NRCan HRDEM (CanElevation) lidar ground model',
    use: 'Calgary path heights',
    url: 'https://open.canada.ca/data/en/dataset/957782bf-847c-4644-a757-e383c0057995',
    licence: 'Open Government Licence – Canada',
    areas: ['calgary'],
    match: /HRDEM|NRCan/i,
  },
  {
    key: 'osm',
    short: 'OpenStreetMap',
    name: 'OpenFreeMap basemap, OpenMapTiles, © OpenStreetMap contributors',
    use: 'map backgrounds',
    url: 'https://www.openstreetmap.org/copyright',
    licence: 'ODbL',
    areas: ['earth', 'walk', 'alberta', 'calgary'],
    match: /OpenStreetMap|OpenFreeMap/i,
  },
];

/** Not data sources: our own pipeline outputs. */
const SKIP = /this project's pipeline/i;

export interface MetaRef {
  file: string;
  meta: Meta | undefined;
}

/** True when method.json carries a NASADEM cross-check with data in it. */
export function hasNasademCheck(method: MethodFile | null | undefined): boolean {
  if (!method || !('nasadem_check' in method)) return false;
  const v: unknown = method.nasadem_check;
  return isObj(v) && Object.values(v).some((x: unknown): boolean => x !== null && x !== undefined);
}

/**
 * Canonical credits (optionally limited to some areas) with the files that cite them, followed by any
 * extra sources the files list that aren't canonical.
 */
export function buildCredits(metas: MetaRef[], opts: { areas?: CreditArea[]; nasadem: boolean }): Credit[] {
  const canon: Credit[] = CANON.filter((c: Canon): boolean => (c.key === 'nasadem' ? opts.nasadem : true)).map(
    ({ match: _m, ...c }: Canon): Credit => ({ ...c, files: [] }),
  );
  const extras = new Map<string, Credit>();
  for (const { file, meta } of metas) {
    for (const s of meta?.sources ?? []) {
      if (SKIP.test(s.name)) continue;
      const i = CANON.findIndex((c: Canon): boolean => c.match !== null && c.match.test(s.name));
      const hit = i >= 0 ? canon.find((c: Credit): boolean => c.key === CANON[i].key) : undefined;
      if (hit) {
        if (!hit.files.includes(file)) hit.files.push(file);
        continue;
      }
      if (i >= 0) continue; // canonical but switched off (e.g. NASADEM without data)
      const prev = extras.get(s.name);
      if (prev) {
        if (!prev.files.includes(file)) prev.files.push(file);
      } else {
        extras.set(s.name, {
          key: `x:${s.name}`,
          short: s.name,
          name: s.name,
          use: '',
          url: s.url,
          licence: s.licence,
          citation: s.citation || undefined,
          areas: [],
          files: [file],
        });
      }
    }
  }
  const scoped = opts.areas
    ? canon.filter((c: Credit): boolean => c.files.length > 0 || c.areas.some((a: CreditArea): boolean => opts.areas?.includes(a) ?? true))
    : canon;
  return [...scoped, ...extras.values()];
}

/** Short names of the canonical credits, for a one-line footer. */
export function shortCredits(credits: Credit[]): string[] {
  return credits.filter((c: Credit): boolean => !c.key.startsWith('x:')).map((c: Credit): string => c.short);
}
