# Datasets

Every dataset we used is free and public. This list matches the **Data we used** table and the
**Data credits and licences** panel on the website's Summary page.

> **Challenge eligibility:** we use NASA data from this challenge's Resources list:
> **NASA LRO LOLA** (Lunar Reconnaissance Orbiter, via PGDA) for all Moon terrain, plus
> **NASA Earthdata** products (MODIS, NASADEM, HLS through GIBS).

## Moon
| Data | From | What we used it for | Licence | Link |
|---|---|---|---|---|
| Moon south-pole terrain (LRO LOLA 20 m, PGDA product 90) | NASA | Heights for all 9 regions. Every danger (shadows, rim drops, camera texture, slope) is measured from it. | NASA data, public domain | [pgda.gsfc.nasa.gov/products/90](https://pgda.gsfc.nasa.gov/products/90) |
| Artemis candidate regions map (Oct 28 2024) | NASA | The 9 regions NASA named. | NASA media, not copyrighted | [nasa.gov](https://www.nasa.gov/news-release/nasa-provides-update-on-artemis-iii-moon-landing-regions/) |
| Region outlines (USGS LGRS) | USGS | Exact outlines of the 9 regions. | USGS, public domain | [doi:10.5066/P1MEQ6UK](https://doi.org/10.5066/P1MEQ6UK) |

## Earth
| Data | From | What we used it for | Licence | Link |
|---|---|---|---|---|
| Earth terrain (Copernicus DEM GLO-30 and GLO-90) | ESA, DLR, Airbus | Heights for every Earth square, measured exactly like the Moon. | © DLR 2010–2014, © Airbus 2014–2018, provided under COPERNICUS by the EU and ESA | [registry.opendata.aws](https://registry.opendata.aws/copernicus-dem/) |
| Land cover (ESA WorldCover 2021, 10 m) | ESA | Keeps only bare ground: trees, crops and buildings would fake the terrain. | CC-BY 4.0 | [esa-worldcover.org](https://esa-worldcover.org/) |
| Ground brightness (MODIS MCD43C3) | NASA | How bright the ground is, compared with the Moon region. | NASA open data, no restrictions | [lpdaac.usgs.gov](https://lpdaac.usgs.gov/products/mcd43c3v061/) |
| Rock type (Macrostrat) | University of Wisconsin | What each Earth site is made of. | CC-BY 4.0 | [macrostrat.org](https://macrostrat.org/) |
| Satellite images (GIBS, HLS) | NASA | The pictures of each Earth site. | NASA open data, no restrictions | [GIBS docs](https://nasa-gibs.github.io/gibs-api-docs/) |
| Protected areas (Protected Planet WDPA) | UNEP-WCMC, IUCN | Flags sites inside parks and reserves, where a rehearsal may need a permit. | WDPA terms, with attribution | [protectedplanet.net](https://www.protectedplanet.net/) |
| Place names (GeoNames) | GeoNames | Names such as "154 km E of Taltal". | CC-BY 4.0 | [geonames.org](https://www.geonames.org/) |
| Maps (OpenFreeMap, OpenMapTiles, Natural Earth) | OpenStreetMap contributors, Natural Earth | Map backgrounds. | ODbL (OSM), public domain (Natural Earth) | [openstreetmap.org/copyright](https://www.openstreetmap.org/copyright) |

## Checks
| Data | From | What we used it for | Licence | Link |
|---|---|---|---|---|
| Moon sunlight map (LOLA illumination, PGDA product 69) | NASA | Checks our computed Moon shadows against NASA's own (r = 0.98). | NASA data, public domain | [pgda.gsfc.nasa.gov/products/69](https://pgda.gsfc.nasa.gov/products/69) |
| Second Earth terrain (NASADEM) | NASA | Cross-checks the Copernicus heights. | NASA open data, no restrictions | [lpdaac.usgs.gov](https://lpdaac.usgs.gov/products/nasadem_hgtv001/) |
| Known analog sites (USGS TADP and PAAD, NASA Planetary Analog Explorer, published studies) | USGS, NASA, research papers | Tests the method (real training sites must beat decoys) and tells new sites from known ones. | Public domain (USGS, NASA); papers cited in [METHOD.md](METHOD.md) | — |
| Sun position (Astropy) | Astropy project | Finds the dates and times when the sun is at the right height. | BSD-3-Clause | [astropy.org](https://www.astropy.org/) |

## Alberta & Calgary
| Data | From | What we used it for | Licence | Link |
|---|---|---|---|---|
| Calgary terrain (HRDEM lidar, 1 m) | Natural Resources Canada | Heights along Calgary's pathways. | Open Government Licence – Canada | [open.canada.ca](https://open.canada.ca/data/en/dataset/957782bf-847c-4644-a757-e383c0057995) |
| City of Calgary Open Data (pathways, parks, transit stops) | City of Calgary | The paths we match Moon walks to, and how close they are to a bus or train. | Open Government Licence – City of Calgary | [data.calgary.ca](https://data.calgary.ca/) |
| Calgary Equity Index 2024 | City of Calgary | Which neighbourhoods need access to amenities most. | Open Government Licence – City of Calgary | [data.calgary.ca](https://data.calgary.ca/) |
| Canadian protected areas (CPCAD) | Environment and Climate Change Canada | Park labels for Alberta sites. | Open Government Licence – Canada | [canada.ca](https://www.canada.ca/en/environment-climate-change/services/national-wildlife-areas/protected-conserved-areas-database.html) |

## Pitch site
| Data | From | What we used it for | Licence |
|---|---|---|---|
| Moon model (SVS 14959), Blue Marble globe | NASA | The Moon and Earth in the opening and globe scenes. | NASA media, not copyrighted |
| LRO, astronaut and SLS models | NASA 3D Resources | The 3D models in the pitch. | NASA media, not copyrighted |
| Kohler Coulee outro (HRDEM lidar 4 m, Sentinel-2 L2A, 9 Oct 2025) | NRCan, ESA Copernicus | The "This is Alberta" reveal and pull-back. | Open Government Licence – Canada; Copernicus free and open |
| Earth ground image (HLS HLSS30 v2.0, 9 Oct 2025) | NASA | The ground under the astronaut. | NASA open data, no restrictions |
| Athena on its side (March 2025) | Intuitive Machines | "Those are its feet." | Photo: Intuitive Machines |

Full citations are in each output file's `meta.sources` and in the website's **Data credits and licences** panel.
The full list of resources the challenge offered is at
[spaceappschallenge.org](https://www.spaceappschallenge.org/2026/challenges/permanent-moon-base-locations-and-mars/?tab=resources).
