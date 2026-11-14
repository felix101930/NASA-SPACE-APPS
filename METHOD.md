# Method (fixed before any result was computed)

Written 2026-11-14, before any feature, score or ranking existed. Changes after this point are listed at the bottom with a reason.

## Data (organizer-listed sources only)
| Use | Product | Source |
|---|---|---|
| Moon terrain | LOLA LDEM_80S_20M (20 m, polar stereographic) | PDS Geosciences (LRO) |
| Moon sunlight, Earth visibility, permanent shadow | LOLA AVGVISIB_75S_120M, AVGVISIB_75S_120M_EARTH, LPSR_75S_120M | PDS Geosciences (LRO), extras |
| Earth terrain | ASTER GDEM v3 (30 m) | NASA Earthdata (LP DAAC) |
| Earth bare-ground screen | VIIRS VNP13C2 monthly NDVI (0.05 deg), July and January 2026 | NASA Earthdata |
| Region outlines | USGS LGRS navigation-grid extents of the 9 regions (traced from LROC QuickMap) | USGS ScienceBase |
| Answer key (checking only, never training input) | USGS TADP, USGS PAAD, NASA and literature field-test sites | catalogs |

Moon terrain is resampled from 20 m to 30 m (block mean) so both bodies are measured on the same 30 m grid with the same code.

## Unit of analysis
A 3.84 km square window (128 px at 30 m). Moon windows tile each region with a 1.92 km step. Earth windows are sampled inside bare sub-boxes.

## Job 1: danger profile (per window, then summarized per region)
**A. Slope and crater edges**
- Landable fraction: share of pixels with slope < 8 deg that are at least 100 m from any pixel with slope >= 8 deg (Wueller et al. 2026, HLS rule).
- Slope median and 90th percentile at 30 m; slope 90th percentile at 120 m.
- Roughness at 240 m and 960 m baselines: 1.4826 x median absolute deviation of height minus a local mean surface (after Barker et al. 2023).
- Crater-edge density, two competing methods: (M1) slope-break: share of pixels where slope changes by > 10 deg across 60 m; (M2) depression detector: count per km2 of closed depressions >= 3 m deep and >= 0.02 km2 (sink fill). Checked against the LOLA-visible crater rims by agreement between methods (rank correlation across windows); M1 is kept unless M2 correlates better with roughness at 240 m (the scale of craters 100-500 m).

**B. Shadows (geometry, computable on both bodies)**
- Cast-shadow fraction: share of pixels in shadow, by ray casting on the terrain, at sun elevation 1.5, 3 and 6 deg, averaged over 8 azimuths.
- Moon-only context (not matched to Earth): mean sunlight, Earth visibility, permanent-shadow share (PDS products).

**C. Camera navigation**
- Lit-feature density: corner features per km2 in the lit part of the terrain rendered at sun 3 deg (8 azimuths).
- Lit share at sun 3 deg.
- Sun-shift sensitivity: share of pixels whose lit/shadow state changes when the sun azimuth moves 12.9 deg (one Earth day on the Moon), sun 3 deg.

## Job 4: base criteria (per window)
Largest connected area with slope < 5 deg (km2); share of window with slope < 20 deg (walking limit); viewshed share within 2 km from the window's flattest point at 10 m height; relief (max minus min height). Moon-only: sunlight, Earth visibility, permanent shadow within 2 km.

## Earth pool
- Bare cells: peak NDVI (max of July and January 2026) between 0.02 and 0.15.
- Sub-boxes of 0.12 deg placed in bare cells, spread over all continents; each gives up to 9 windows.
- Known analog sites get their own windows (centred on the site) for checking.

## Models compared (Jobs 2 and 4), same features in, one score out
1. Standardized distance to the region's Moon windows (k = 5 nearest, robust z-scores). Baseline.
2. Mahalanobis distance (robust covariance).
3. Isolation Forest (trained on Moon windows only).
4. One-class SVM (RBF, trained on Moon windows only).
5. Random forest, Moon vs Earth.
6. XGBoost, Moon vs Earth.
7. LightGBM, Moon vs Earth.
8. CatBoost, Moon vs Earth.
9. TabPFN, Moon vs Earth (if it installs and runs).
10. Image model: DINOv2-small embedding of the terrain rendered at sun 3 deg; cosine similarity to the region's Moon windows.
Classifier scores for Earth windows are out-of-fold (5 folds, grouped by 1-deg cell) so no Earth window is scored by a model that saw it.

## Validation (Jobs 2 and 4)
- **V1 known-analog recovery:** AUC of known Moon-analog windows vs bare background windows. 90% bootstrap interval.
- **V2 find-back:** 20% of each region's Moon windows held out in spatial blocks; AUC of held-out Moon windows vs Earth windows.
- **V3 stability:** Spearman correlation of Earth scores between 3.84 km and 1.92 km windows.
- **Winner rule:** rank models by the mean of V1 and V2 AUC. A learned model replaces the baseline only if its V2 AUC 90% lower bound is above the baseline's V2 AUC.

## Job 2 output
For each region x danger (A, B, C): top 3 Earth windows, at least 50 km apart and at least 50 km from any catalogued analog. Test dates and times: for 2027, the date with the most minutes of sun between 1.5 deg and the region's maximum sun elevation, with the local time windows (astropy).

## Job 3: route twin
- Moon test routes: 300 random straight and two-leg routes of 1-4 km inside the regions; profile = height relative to start and slope, every 30 m.
- Earth candidates: straight paths in 16 directions through Earth window centres.
- Matchers: Euclidean on height profile; Euclidean on height and slope; DTW (10% band); non-normalized matrix profile (stumpy aamp).
- **Find-back test:** a distorted copy of each Moon route (height noise 2 m, 5% stretch, random reversal) is hidden among the Earth paths; score = top-1 and top-5 recall. Winner = highest top-1 recall; ties broken by speed.
- Quality: height RMSE and max-slope difference of each route's best real Earth match.

## Limits stated in advance
- Earth DEM is 30 m: features under ~60 m (boulders, small craters) are not compared.
- ASTER GDEM has artifacts (pits and spikes); roughness at 30 m is noisier on Earth than on the Moon.
- Shadows are matched by geometry only; Earth shadows are lit by the sky.
- Cast shadows use terrain within the window plus a 2 km margin; distant mountains are not included.
- Known analogs were chosen for geology or operations, not for these dangers, so V1 is a weak test.

## Changes after this point
All made during the run, before any final ranking was looked at unless stated.
1. **Moon 20 m to 30 m:** light Gaussian smoothing (sigma 0.6 px) then bilinear sampling, instead of a strict block mean (20 does not divide 30 evenly).
2. **Permanent-shadow map decoding:** the label says value = DN x 0.000025 + 0.5, so DN -20000 = not in permanent shadow, +20000 = permanent shadow.
3. **Answer key size:** the public USGS TADP API returns only 4 sites. The answer key is 33 NASA/ESA/literature field sites + 45 USGS PAAD sites + 4 TADP sites (82; all have terrain windows). V1 uses only the sites whose basis is a Moon analog (field sites marked "moon"); PAAD sites are Mars aeolian analogs and are used only in the 50 km novelty filter.
4. **Crater-edge contest result (pre-registered rule, not a change):** M1 slope-break correlates with roughness at 240 m (Spearman 0.25), M2 depressions do not (-0.07). M1 kept; M2 dropped from the danger A feature set.
5. **TabPFN:** the current TabPFN release needs a vendor account and API key, which we did not create. We used the open TabPFN v2 weights (package 2.0.9), CPU only. To fit in time: context of 400 Moon + 600 Earth windows, 4 ensemble members, and Earth scores out-of-sample by two fits on disjoint Earth contexts instead of 5 grouped folds.
6. **DINOv2:** renders at 4 sun azimuths (0, 90, 180, 270 deg), not 8, mean embedding; score = mean cosine similarity to the 5 nearest training Moon windows.
7. **Camera-feature details:** each render is auto-exposed (divided by the 99th percentile of lit pixels), Harris corners with k = 0.05, sigma = 1 px, absolute threshold 0.01, minimum spacing 2 px.
8. **V2 spatial blocks:** 7.68 km x 7.68 km blocks, drawn at random until at least 20% of a region's windows are held out.
9. **Earth pool result:** 4,433 bare windows in 508 boxes (2 per 5-deg cell that has bare ground). No Antarctic box passed the bare screen (ice has NDVI below 0.02), so Antarctica is not in the pool.
10. **Job 3 implementation:** DTW uses a rolling two-row table (same result, less memory). The matrix profile compares first differences of height (so a height offset does not matter) along each whole 4 km line. Hidden copies of routes longer than ~3.8 km, once stretched 5%, are longer than a line, so they are trimmed to the central 4.02 km.
11. **Job 2 is one combined match per Moon site (team decision, made after a per-danger dry run and before any combined ranking was computed):** Job 1 is renamed "site profile" (a description of each site, not only its dangers). Job 2 matches all site-profile measurements together (terrain: landable share, slopes, roughness, crater edges M1; light: cast shadow at 1.5/3/6 deg; camera: lit features, lit share, sun-shift), giving 9 searches with 3 Earth spots each instead of 27. Job 4 keeps the base criteria. The model contest runs on these two feature sets.
12. **Water gate (found by the novelty check, before the final contest):** some Earth windows were 50-72% sea. VIIRS cells are 5.5 km wide, so coastal cells passed the bare screen, and ASTER shows water as perfectly flat ground, which fakes "flat base" and shadow matches. Windows with more than 5% of pixels at or below 1 m height, or more than 5% in perfectly flat patches larger than 0.1 km2, are removed: 3,921 of 4,433 bare windows remain. Classical models are retrained on the dry pool. TabPFN was already running on the full pool, so its Earth scores are kept for dry windows only (water windows stayed among its training negatives).
13. **Ice check:** there is no per-window ice layer in the listed datasets, so ice is checked after ranking: any final spot whose window is 30% or more snow/ice (ESA WorldCover 10 m, used for checking only) is dropped.
14. **Catalog extended from the literature check:** the novelty agents found analog sites missing from our catalog (Valley of Ten Thousand Smokes, Eureka, LUNARK/Moriusaq, Nuussuaq spherule bed, Pozo Bravo, Puga/Chumathang, Tso Kar). They were added (89 sites), so the 50 km novelty filter now excludes them. This removed a Katmai spot that the first 9-model pick had ranked first for 7 regions.
15. **TabPFN on GPU:** a separate CUDA environment was set up, so TabPFN runs with the original plan (all training windows, 5 grouped folds) instead of the reduced CPU setup in change 5.
