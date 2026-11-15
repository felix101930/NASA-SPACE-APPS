# Results (2026-11-14)

Method fixed in advance in `METHOD.md`; every change made during the run is listed there under "Changes" (15 items).
Data: organizer-listed sources only (LRO LOLA from PDS, ASTER GDEM v3 and VIIRS NDVI from NASA Earthdata). Region outlines from USGS. Analog catalogs and ESA WorldCover are used for checking only, never for scoring.

## Job 1: Site profile of the 9 Artemis candidate landing regions
Median over each region's 3.84 km windows (LOLA 20 m, measured on a 30 m grid). Full table: `results/danger_profiles.csv`; every window: `results/moon_windows.csv`.

| Region | Windows | Landable ground* | Median slope | Shadow at 3 deg sun | Avg. sunlight | Earth visible |
|---|---|---|---|---|---|---|
| Slater Plain | 81 | **29%** | 7.6 deg | 45% | 25% | 30% |
| Nobile Rim 2 | 81 | 13% | 10.6 deg | 49% | 29% | 41% |
| Haworth | 196 | 12% | 9.3 deg | 47% | 27% | 39% |
| Mons Mouton Plateau | 1131 | 11% | 10.3 deg | 49% | 36% | 76% |
| Mons Mouton | 49 | 10% | 10.5 deg | 50% | 33% | 45% |
| de Gerlache Rim 2 | 81 | 6% | 12.3 deg | 47% | 35% | 51% |
| Nobile Rim 1 | 81 | 2% | 17.4 deg | 50% | 30% | 22% |
| Peak Near Cabeus B | 81 | ~0% | 18.6 deg | 48% | 38% | 29% |
| Malapert Massif | 81 | ~0% | 19.0 deg | 49% | 40% | 74% |

*Slope under 8 deg and at least 100 m from steeper ground (NASA HLS rule, Wueller et al. 2026).
Crater-edge method contest (fixed rule): the slope-break method tracks 240 m roughness (Spearman 0.25), the depression detector does not (-0.07). Slope-break kept.

## Jobs 2 and 4: model contest (one combined match per Moon site; base criteria)
Earth pool: 3,921 bare, dry windows in 508 boxes on every continent except Antarctica, plus 82 catalogued analog sites for testing.

| Model | V1 known analogs (AUC, 90% CI) | V2 held-out Moon (AUC) | V3 stability (Spearman) |
|---|---|---|---|
| **DINOv2 (terrain rendered at low sun)** | **0.76 (0.73-0.78)** | 0.999 | 0.87 |
| TabPFN (GPU) | 0.76 (0.72-0.78) | 0.999 | 0.56 |
| CatBoost | 0.74 (0.72-0.77) | 1.000 | 0.75 |
| Random forest | 0.69 | 1.000 | 0.45 |
| k-nearest (baseline) | 0.67 | 0.995 | 0.89 |
| One-class SVM | 0.67 | 0.997 | 0.89 |
| Mahalanobis | 0.61 | 0.999 | 0.78 |
| LightGBM | 0.57 | 1.000 | 0.54 |
| Isolation Forest | 0.57 | 0.998 | 0.73 |
| XGBoost | 0.53 | 0.999 | 0.68 |

Site-profile features. Base features: same winner (DINOv2 does not use the feature set), runner-up TabPFN (V1 0.73). Full table: `results/model_contest.csv`.

**Winner by the fixed rule: DINOv2.** What the tests say:
- V2 is near 1.0 for every model: Moon windows are easy to tell apart from Earth windows, so V2 does not separate the models.
- V1 (re-finding known Moon analogs among random bare ground) does: DINOv2, TabPFN and CatBoost lead. Known analogs were chosen for geology, not terrain, so this is a weak test.
- Gradient-boosted models (XGBoost, LightGBM) and random forest are unstable between window sizes (V3 0.45-0.68).

## Job 2: New Earth analogs to test landing (top 3 per Moon site)
Every spot passed: at least 50 km from all 90 catalogued analogs, a literature check, and a ground check (ice < 30%, water <= 5%, vegetation <= 20%).
Wording for all of them: "no prior analog study found in the catalogs and literature we checked".
Test date: the 2027 date with the most minutes of sun between 1.5 deg and the region's maximum sun elevation. Full table with matched values and time windows: `results/job2_test_sites.csv`.

| Moon site | #1 | #2 | #3 |
|---|---|---|---|
| Haworth | Patagonian steppe NE of Lago San Martin, Argentina (-48.76, -72.08) | Cumberland Peninsula, Baffin Island (67.63, -67.52) | Northern Hoggar, Algeria (25.18, 6.04) |
| Malapert Massif | Sierra Negra north flank, Galapagos (-0.76, -91.18) | Northern Hoggar, Algeria | Southern Tarim foothills near Koramlik, Xinjiang (37.79, 87.18) |
| Mons Mouton | Aksai Chin plateau (34.78, 78.73) | West Ellesmere Island, Trold Fiord (78.39, -84.50) | NW Axel Heiberg Island, Horizon Peak (80.03, -94.33) |
| Mons Mouton Plateau | Nepal-Tibet border near Araniko Chuli, Dolpa (29.18, 83.56) | Northern Hoggar, Algeria | Aksai river near Guozha Co (34.89, 80.93) |
| Nobile Rim 1 | Northern Hoggar, Algeria | West Ellesmere Island, Huff Ridge (78.39, -84.15) | Aksai Chin plateau (34.78, 78.68) |
| Nobile Rim 2 | SW Axel Heiberg Island, Good Friday Bay (78.74, -92.43) | Cerro Bravo area, San Juan, Argentina (-28.76, -69.36) | Aksai river near Guozha Co |
| Peak Near Cabeus B | Sierra Negra north flank, Galapagos | Cerro Bravo area, San Juan (-28.73, -69.36) | Northern Hoggar, Algeria |
| Slater Plain | Northern Hoggar, Algeria | Cumberland Peninsula, Baffin Island | SW Axel Heiberg Island |
| de Gerlache Rim 2 | Cumberland Peninsula, Baffin Island | Northern Hoggar, Algeria | SW Axel Heiberg Island |

Example dates: Galapagos 2027-01-01, 06:14-06:42 and 17:36-18:04 local; Northern Hoggar early January, about 07:34-08:00 and 17:20-17:50; high Arctic mid-August, around local midnight (several hours of low sun).

## Job 4: New Earth analogs for a base
DINOv2 also wins the base contest, and it does not use the base criteria, so the base list is the same as the landing list (`results/job4_base_sites.csv`). A base-specific list would need the runner-up (TabPFN on base criteria); not done yet.

## Job 3: Route twin (walk or rover drive)
300 random Moon routes (1-4 km) against 70,928 straight Earth paths. A distorted copy of each route (2 m noise, 5% stretch, random reversal) was hidden among them.

| Matcher | Found 1st | In top 5 | Height error of best real Earth match (median) |
|---|---|---|---|
| **Height profile** | **72%** | **89%** | 10.6 m |
| Height + slope | 63% | 81% | 10.8 m |
| DTW (10% band) | 40% | 63% | 14.5 m |
| Matrix profile | 15% | 19% | 20.1 m |

Short routes (under 2 km) are harder (57% vs 80%). An independent run by our teammate (22,000 paths, `sanbir` branch) reached the same conclusion: height matching beats DTW.

## What is weak (read before presenting)
- **The same spots win for many sites.** Northern Hoggar is in the top 3 for 7 of 9 regions. The winning model finds "the most Moon-like bare ground on Earth" more than a twin for each site.
- **Shadows only use terrain within 2 km.** At 1.5-3 deg sun, distant mountains matter. Our teammate's 150 km horizon method agrees with NASA's sunlight maps (r = 0.98) and is better here.
- **V1 is a weak test** (known analogs were chosen for geology); V2 does not separate models.
- **30 m Earth terrain:** boulders and craters under ~60 m are not compared.
- **Access:** Aksai Chin is disputed and practically closed; the Galapagos spot is in a national park; the Dolpa spot is at ~5,500 m with seasonal snow.
- **Novelty is only as good as the search:** web and catalog searches, not a full Google Scholar/ADS review. 4 earlier candidates were dropped as near known analogs (Katmai, Eureka, Grottedal, Atacama core).
