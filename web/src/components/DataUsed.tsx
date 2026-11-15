import type { JSX } from 'react';

/* High-level "Data we used" table for the Summary page: what each major dataset is, who makes it and what we
   used it for, in plain words. Full citations, licences and links stay in the credits panel below it
   (lib/credits.ts); keep the two in step when a source is added. */

interface DataRow {
  data: string;
  from: string;
  use: string;
}

interface DataGroup {
  title: string;
  rows: DataRow[];
}

const GROUPS: readonly DataGroup[] = [
  {
    title: 'Moon',
    rows: [
      {
        data: 'Moon south-pole terrain (LRO LOLA, 20 m)',
        from: 'NASA',
        use: 'Heights for all 9 regions. Every danger (shadows, rim drops, camera texture, slope) is measured from it.',
      },
      { data: 'Artemis candidate regions', from: 'NASA, USGS', use: 'Where the 9 regions are and their outlines.' },
    ],
  },
  {
    title: 'Earth',
    rows: [
      {
        data: 'Earth terrain (Copernicus DEM, 30 m and 90 m)',
        from: 'ESA, Airbus',
        use: 'Heights for every Earth square, measured exactly like the Moon.',
      },
      {
        data: 'Land cover (ESA WorldCover 2021)',
        from: 'ESA',
        use: 'Keeps only bare ground: trees, crops and buildings would fake the terrain.',
      },
      { data: 'Ground brightness (MODIS)', from: 'NASA', use: 'How bright the ground is, compared with the Moon region.' },
      { data: 'Rock type (Macrostrat)', from: 'University of Wisconsin', use: 'What each Earth site is made of.' },
      { data: 'Satellite images (GIBS, HLS)', from: 'NASA', use: 'The pictures of each Earth site.' },
      {
        data: 'Protected areas (Protected Planet)',
        from: 'UNEP-WCMC, IUCN',
        use: 'Flags sites inside parks and reserves, where a rehearsal may need a permit.',
      },
      {
        data: 'Place names and maps (GeoNames, Natural Earth, OpenStreetMap)',
        from: 'Open data projects',
        use: 'Names such as “154 km E of Taltal” and the map backgrounds.',
      },
    ],
  },
  {
    title: 'Checks',
    rows: [
      {
        data: 'Moon sunlight map (LOLA illumination)',
        from: 'NASA',
        use: 'Checks our computed Moon shadows against NASA’s own.',
      },
      { data: 'Second Earth terrain (NASADEM)', from: 'NASA', use: 'Cross-checks the Copernicus heights.' },
      {
        data: 'Known analog sites (USGS TADP and PAAD, NASA Planetary Analog Explorer, published studies)',
        from: 'USGS, NASA, research papers',
        use: 'Tests the method (real training sites must beat decoys) and tells new sites from known ones.',
      },
      { data: 'Sun position (Astropy)', from: 'Astropy project', use: 'Finds the dates and times when the sun is at the right height.' },
    ],
  },
  {
    title: 'Alberta & Calgary',
    rows: [
      { data: 'Calgary terrain (HRDEM lidar, 1 m)', from: 'Natural Resources Canada', use: 'Heights along Calgary’s pathways.' },
      {
        data: 'City of Calgary Open Data (pathways, parks, transit stops)',
        from: 'City of Calgary',
        use: 'The paths we match Moon walks to, and how close they are to a bus or train.',
      },
      { data: 'Calgary Equity Index 2024', from: 'City of Calgary', use: 'Which neighbourhoods need access to amenities most.' },
      {
        data: 'Canadian protected areas (CPCAD)',
        from: 'Environment and Climate Change Canada',
        use: 'Park labels for Alberta sites.',
      },
    ],
  },
];

export function DataUsed(): JSX.Element {
  return (
    <section className="sum-section" aria-labelledby="data-h">
      <h2 id="data-h">Data we used</h2>
      <p className="caption du-lead">Every dataset is free and public. Full citations and licences are under “Data credits and licences” below.</p>
      <div className="du-scroll">
        <table className="du-table">
          <thead>
            <tr>
              <th scope="col">Data</th>
              <th scope="col">From</th>
              <th scope="col">What we used it for</th>
            </tr>
          </thead>
          {GROUPS.map((g: DataGroup) => (
            <tbody key={g.title}>
              <tr className="du-group">
                <th scope="colgroup" colSpan={3}>
                  {g.title}
                </th>
              </tr>
              {g.rows.map((r: DataRow) => (
                <tr key={r.data}>
                  <th scope="row">{r.data}</th>
                  <td className="du-from">{r.from}</td>
                  <td>{r.use}</td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </section>
  );
}
