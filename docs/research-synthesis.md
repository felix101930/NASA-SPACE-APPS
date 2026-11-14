# Research synthesis: data, methods, stack (2026-11-14)

Challenge: "Identify Earth Locations that Analog the Permanent Moon Base Locations and Mars".
Statement: https://www.spaceappschallenge.org/2026/challenges/permanent-moon-base-locations-and-mars/

**Status labels**
- **VERIFIED**: we made a real request today and saw it work.
- **UNVERIFIED**: from documentation or memory only.

## Product (four jobs plus a summary)
1. **Learn from failures.** A danger profile for each of NASA's 9 candidate south-pole regions. The dangers are:
   - shadows at low sun;
   - crater-rim height jumps;
   - how well a camera can navigate;
   - slope and roughness.
2. **Places to test landing.** For each region and danger (27 searches), find the top 3 Earth windows, with dates and times when the sun matches.
3. **Practise an astronaut walk.** The user draws a route on a Moon region. We match its slope profile to Earth transects using dynamic time warping (DTW).
4. **Summary.** Rank the 9 regions from easiest to hardest to rehearse on Earth.

## Data decisions

### Moon elevation (DEM)
- **Source:** PGDA product 90 "A New View of the Lunar South Pole from LOLA" (Barker et al. 2023, PSJ, doi:10.3847/PSJ/acf3e1).
- **File:** `LDEM_80S_20MPP_ADJ.TIF`, 20 m per pixel, covering 80–90°S.
- **VERIFIED:** the file is a cloud-optimised GeoTIFF (COG). We opened it with rasterio `/vsicurl/`, and a 15 km window read takes about 5 s.
- **Projection:** `+proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +R=1737400`.
- **Grid:** 30400×30400 pixels, float32, no-data value NaN.
- **URL:** https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/
- **Companion files:**
  - `LDSM_*` slope;
  - `_ERR` error;
  - `_HILL` hillshade;
  - `LDEM_83S_10MPP_ADJ` 10 m version (heavily interpolated).
- **Gotcha:** a wrong filename still returns HTTP 200, as a 3789-byte "soft 404" HTML page. Always check the byte size.

### Moon cross-check from a partner agency
- **Source:** JAXA Kaguya LALT south-pole grid, about 240 m resolution, simple-cylindrical projection.
- **URL:** https://data.darts.isas.jaxa.jp/pub/pds3/sln-l-lalt-5-topo-gt-sp-img-v2.0/data/LALT_GT_SP_IMG.IMG
- **Access:** a 65 MB file with no range reads, so it must be downloaded whole (P2).

### Shadow validation
- **Source:** PGDA product 69 (Mazarico).
- **Files:**
  - `AVGVISIB_85S_060M_201608.TIF`: average sun visibility at 60 m, 34 MB. VERIFIED.
  - `LPSR_85S_060M_201608.TIF`: permanent shadow.
- **URL:** https://pgda.gsfc.nasa.gov/data/MoonIllumination/
- **Gotcha:** use the plain `.TIF` files. The `_COG.TIF` links are soft 404s.

### Region coordinates
- **Gap:** NASA has published no machine-readable outlines or centre points for the October 2024 set of 9 regions.
- **Partial source:** PGDA product 78 ROI shapefiles cover sites 06 (Nobile Rim 1), 11 (de Gerlache rim), 20 (Leibnitz β, now Mons Mouton), 23 (Malapert), Haworth and DM2 (Nobile Rim 2).
- **Still to trace:** Peak near Cabeus B, Slater Plain, and the Mons Mouton / Mons Mouton Plateau split. Trace these from the NASA image map in the October 28, 2024 release and **label them approximate**.

### Earth elevation (DEM)
- **Source:** Copernicus DEM GLO-30 COGs on AWS.
- **VERIFIED:** range reads work, and no login is needed.
- **URL:** https://copernicus-dem-30m.s3.amazonaws.com/
- **Alternatives:**
  - NASADEM is cited as a fallback only. It needs an Earthdata login and comes as zips, not COGs.
  - JAXA AW3D30 via the OpenTopography VRT can serve as an optional cross-check.

### Bare-ground mask
- **Source:** ESA WorldCover 2021 v200, 10 m.
- **VERIFIED:** anonymous range read returns HTTP 206.
- **URL pattern:** `https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_<N51W117>_Map.tif`
- **Classes:**
  - keep 60 (bare / sparse vegetation), and possibly 100 (moss / lichen);
  - exclude 10, 40, 50, 70 and 80.
- **Why it matters:** Copernicus GLO-30 is a surface model that includes trees and buildings, so this mask is mandatory.

### Rock type
- **Source:** Macrostrat, `https://macrostrat.org/api/v2/geologic_units/map?lat=..&lng=..&response=long`
- **VERIFIED:** returns data, licence CC-BY 4.0.
- **Coverage:** worldwide, but coarse outside North America.
- **Gotcha:** the `lith=` filter does not work. Match the text "anorthosite" in the `lith` and `descrip` fields instead.

### Sun position
- **Tool:** astropy `get_sun` with `AltAz`.
- **Moon:** use geometric elevation, since there is no atmosphere.
- **Earth targets:** add refraction (about 0.3° at 2° elevation).
- **Penumbra:** flag the solar semi-diameter of 0.27°.

### Basemaps (no API key)
- **Earth:**
  - OpenFreeMap styles. VERIFIED: CORS `*`.
  - NASA GIBS WMTS. VERIFIED: CORS `*`.
  - The HLS layer goes to zoom 12, about 30 m.
- **Moon:** Moon Trek `WAC_POLE_ILL_PCT_SOUTH_100M` WMTS. It uses a custom CRS, so alignment is untested. Our own hillshade is safer.

### Canadian radar panel (P2)
- **Source:** RADARSAT-1 COGs on AWS (`radarsat-r1-l1-cog`), anonymous, Open Government Licence – Canada.
- **Caveats:**
  - C-band HH from 1996–2013, not comparable to Mini-RF (S-band, circular polarisation).
  - RCM data needs an EODMS account, so it is out of scope.

### Skipped
- JAXA G-Portal
- ESA Open Science Catalog
- Mini-RF (no verified polar mosaic)
- 1 m LROC NAC tiles (3.7 GB each)

## Method decisions (numeric probes in `scratchpad/probe-methods`)

### Shadow fraction
- **Algorithm:** a horizon map using 72 azimuths at 1-pixel steps with bilinear sampling and lunar curvature (Mazarico et al. 2011; Gläser et al. 2014).
- **Buffer:** a 15 km core plus at least 15 km of buffer on every side is mandatory. Without it the result is off by 2–3 points.
- **Runtime:** about 5 s per window with numba.
- **Sun range:** use each site's real sun elevation (latitude-dependent, with a declination of ±1.54°). Weight by time, and also report fixed elevations of 1, 3, 5 and 7°.
- **Tests:**
  - flat plane gives 0;
  - a tilted plane flips between shadowed and lit at the right elevation;
  - a cylindrical pit matches the analytic shadow area to within about 1 pixel at the rim.

### Rim jump (Hakuto-R)
- **Metric:** `J = |h(x+1 km) − h(x)|` along transects in 16 directions.
- **Report:**
  - the 95th and 99th percentiles (P95 and P99);
  - the fraction of track kilometres above an illustrative threshold.
- **Wording:** ispace has not published its threshold, so do not imply we know it.

### Camera navigation (Ingenuity, IM-2)
- **Metric:** FAST keypoint density on a hillshade **that includes cast shadows**, after resampling both worlds to 30 m. Also report the share of empty 1 km cells.
- **Caveat:** this is only a proxy for high-altitude terrain-relative navigation, not final descent.

### Scale
- Compare everything on a common 30 m grid in absolute units.
- Add a multi-baseline roughness measure ν(L) at 60–960 m.

### Similarity
- **Distance:** a 1-D Wasserstein distance for each metric, normalised by the Moon region's interquartile range.
- **Danger score:** the mean of the distances for that danger's metrics.
- **Display:** a traffic light for each metric plus the signed gap. Never show a "% Moon-like" figure.

### Walk
- DTW on slope profiles, with a 10% Sakoe-Chiba band, run in a Web Worker.
- Earth candidates are straight transects (12–16 directions; 1, 2 and 5 km) from the candidate pool.

### Machine learning
- **Decision:** no XGBoost or random forest in the main pipeline, because there are no labels.
- **One validation panel only:** a classifier two-sample test (Lopez-Paz & Oquab 2017).
  - Train logistic regression or a small random forest to tell Moon tiles from Earth tiles, on 1 km tiles.
  - Use GroupKFold by window to avoid leakage.
  - Report the AUC and the feature importances.
- **Also skip:** surrogate models and clustering, which add nothing here.

### Validation
- Rank known analogs above decoys, measured as ROC-AUC.
- Perturb the weights by ±20% and measure top-3 stability with the Jaccard index.
- Run the synthetic tests above.
- Include a "where it fails" section:
  - boulders smaller than one pixel;
  - Earth skylight fills shadows;
  - vegetation in the surface model;
  - low sun lasts minutes on Earth versus days on the Moon.

### Compute
- Under 15 minutes in total. Downloading and cropping is the real cost.

## Earth site selection method (decided 2026-11-14, method A)
The search is Moon-first, global and in two stages.

1. **Moon fingerprints.** For each of the 9 regions, compute fingerprints at 90 m and at 30 m:
   - slope;
   - relief;
   - rim jump over 1 km;
   - roughness ν(L);
   - local low-sun shadow fraction.
2. **Stage 1, global screen.**
   - Sample 4,000–6,000 random 15 km windows over land between 60°S and 83°N. The sampling is seeded and stratified by latitude band.
   - Keep only bare-ground windows: WorldCover classes 60 + 100 must cover at least 60%, and snow/ice (class 70) less than 30%.
   - Compute the same fingerprint from GLO-90.
   - Rank windows by distance to the Moon fingerprints, separately for each region × hazard.
3. **Stage 2, refinement.** Take the union of the top ~15 windows per region × hazard, about 100–150 windows. Recompute their full metrics at 30 m with the far-field horizon, then derive the top-3 matches and the sun rehearsal windows.
4. **Validation.** The 126-row researched list is not used to choose sites; it is the test set.
   - Known analogs should rank high in stage 1, and decoys low.
   - Report their percentile positions.
   - Check that the top-3 results stay stable when the random seed changes.

## Earth candidate pool (validation set)
- **File:** `scratchpad/probe-earthpool/candidates.csv`, 126 rows. Coordinates come from Wikipedia; 13 rows have none yet.
- **Contents:**
  - 14 known analogs, held out for validation;
  - 10 decoys;
  - 36 impact craters;
  - 12 anorthosite sites;
  - 10 high-Arctic sites.
- **Unverified fields:** rock type, why each site is an analog, and bare-ground confidence. Verify these against WorldCover and the DEM.

## Frontend
- **Stack:** Vite 8, React 19, TypeScript, three 0.187, @react-three/fiber 9.8, drei 10.7, maplibre-gl 6.18, recharts 3.10, zustand 5.1.
  - These are `npm view` versions as of today. Check that the peer dependency ranges agree.
- **Moon terrain:** one PlaneGeometry heightmap mesh per region tile. Map libraries do not support Moon coordinates.
- **Shadows:**
  - the three.js DirectionalLight shadow map is the riskiest part at 1–5° sun elevation;
  - fall back to precomputed shadow masks from Python at a few sun angles.
- **Route drawing:** draw on a 2D hillshade canvas first, then show the route as a line in 3D.
- **Data:** static files loaded as Float32 or Int16 binaries with fetch → ArrayBuffer. Hosting is Vercel or GitHub Pages.

## Competitors (around 10 entries on GitHub)
- Every competitor ranks sites by overall similarity.
- None builds a danger profile from real failures, rehearsal dates and times, or route matching.
- **Closest:** azrialahmad/earth-analog-explorer. It compares 12 sites against Shackleton, Malapert and Jezero, includes a low-sun share, and has no hazards, routes or 3D.
- **ShadowAstra:** works at a coarse 55 km scale.
- **Only rival with rock type:** Max1-CE.

## Failure facts: FINAL stage wording (triple-checked 2026-11-14; supersedes the list below)
- **Hakuto-R M1:** "Hakuto-R crossed a crater-rim cliff about 3 km high. Its software rejected the sudden altitude jump as a sensor error and estimated it was on the surface while still about 5 km up."
  - Source: ispace, 26 May 2023, https://www.ispace-inc.com/2023/05/26/ispace-announces-results-of-the-hakuto-r-mission-1-lunar-landing/. We read the page directly and its wording matches.
- **IM-2 Athena:** "Intuitive Machines' CEO said altimeter signal noise, long shadows from low-angle sunlight, and navigation imagery taken from 100 km that didn't match how craters look lower down all contributed."
  - Source: IM Q1 2025 earnings call, 13 May 2025, as reported by The Register and Spaceflight Now (14 May 2025).
  - This is the company's own account. No NASA or independent root-cause report has been published. IM's 8-K and 10-Q give no cause.
- **Ingenuity Flight 72:** "NASA's most likely explanation is that a lack of surface texture over steep, relatively featureless sand ripples gave Ingenuity's navigation system too little information to work with."
  - Source: NASA JPL, 11 Dec 2024. Keep the "most likely" hedge.
- **Heading:** "Three missions where terrain and lighting fooled the navigation".
  - Do not say "Why these four", because there are three missions.
  - Do not include ispace Mission 2 (2025, laser rangefinder hardware) or IM-1 (2024, a safety switch not enabled) under this heading. Neither was a terrain failure.

## Failure facts: safe wording for the pitch (earlier draft)
- **Hakuto-R** ([ispace, 2023-05-26](https://www.ispace-inc.com/2023/05/26/ispace-announces-results-of-the-hakuto-r-mission-1-lunar-landing/)): the lander passed over a crater-rim cliff about 3 km high. Its software rejected the altitude jump as a sensor error, so it thought it had landed while still about 5 km up.
- **IM-2:** "IM said on its May 2025 earnings call" that altimeter noise and long low-sun shadows contributed. Its optical navigation used reference imagery from about 100 km up, which did not show how craters look at low altitude. Source: The Register, 2025-05-14. No primary source has been found.
- **Ingenuity** ([JPL, 2024-12-11](https://www.jpl.nasa.gov/news/nasa-performs-first-aircraft-accident-investigation-on-another-world/)): "Lack of surface texture gave the navigation system too little information to work with". The release describes "steep, relatively featureless sand ripples".
- **IM-1:** a safety-enable wiring oversight disabled the laser rangefinders. IM said the lander was moving slightly sideways at touchdown, caught a leg and tipped over. This comes from press-conference statements; no primary document has been found.
- **NASA Lander Vision System** ([JPL, 2019-05-24](https://www.jpl.nasa.gov/news/nasas-mars-2020-mission-drops-in-on-death-valley/)): flown on a helicopter over Death Valley in 2019.

## Open technical risk: far-field shadowing
- **The problem.** At sun elevations of 0.5–1.5°, distant relief dominates shadowing. For example, a 5 km massif with the sun at 1° casts a shadow about 290 km long. A 15 km buffer may therefore under-count shadow.
- **The fix under test:**
  - include curvature in the horizon calculation (−d²/2R);
  - search the horizon at several resolutions, using 20 m data near the window and a coarser overview farther out;
  - test search radii of 15, 30, 60, 100 and 150 km.
- **Validation.** Compare against PGDA AVGVISIB (product 69). If our numbers disagree with it, trust PGDA and use its products directly for the Moon side.
- **Earth windows** follow the same rule, with the far field from GLO-90 or downsampled GLO-30, and R_eff ≈ 7/6 × 6371 km.
- **RESULT (2026-11-14): use a 150 km horizon search radius.**
  - **Setup:** 20 m data out to 15 km, then the 160 m or 320 m overview, with curvature on.
  - **Why not 15 km:** it makes the cores 5–7 pts too bright, and single sun azimuths are off by up to 34 pts. Beyond 150 km nothing changes.
  - **Agreement with PGDA AVGVISIB at 150 km** (r = Pearson correlation, MAD = mean absolute difference):

    | Site | r | MAD | Bias |
    |---|---|---|---|
    | Shackleton rim | 0.92 | 0.029 | −0.013 |
    | de Gerlache rim | 0.96 | 0.030 | −0.028 |
    | Malapert | 0.94 | 0.029 | −0.026 |

  - **At a 15 km radius** r drops to 0.65–0.85.
  - **Absolute bias:** our results are 1.3–2.9 pts darker than PGDA.
  - **Which source to use:**
    - Take long-term illumination and any absolute "% illuminated" claim from PGDA.
    - Use our own computation for shadows at a specific sun position, for masks and for relative ranking.
  - **Earth stage 2:** 150 km radius, capped at about 200 km, with R_eff = 7/6 × 6371 km. The stage-1 shadow proxy stays local and is labelled `shadow_frac_local_*`.
  - **Scripts:** `scratchpad/probe-buffer`.

## Labelling and citation rules
- **Region coordinates.** Label traced coordinates "approximate, traced from NASA map" and cite the NASA figure from the Oct 28, 2024 release.
- **Earth candidate pool.** Wikipedia coordinates are acceptable as locators only. Every claim about a site needs a primary or peer-reviewed citation.
- **Licences for the References field:**
  - Copernicus DEM: ESA, attribution required.
  - ESA WorldCover: CC-BY 4.0.
  - Macrostrat: CC-BY 4.0.
  - OpenFreeMap / OSM: ODbL.
  - LOLA / PGDA: cite the data papers.
  - NASA GIBS: acknowledgement requested.

## Submission rules (guides dated 2026-11-13)
- **Demo:** up to 7 slides including the title, or a video of up to 30 seconds.
- **Links:** public, with no login.
- **Language:** English.
- **References:** list every external resource in the References field.
- **Judging:** Impact, Creativity, Validity, Relevance and Presentation, each scored 1–5.
- **Deadline:** 2026-11-15, 23:59 local time.
