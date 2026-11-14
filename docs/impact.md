# Impact: why this matters, in dollars and for the environment

Every number below is one of three kinds:

- **Sourced**: copied from the cited primary source.
- **Computed**: worked out from our own match data and a cited factor.
- **Estimate**: an order-of-magnitude figure. The formula is shown.

Regenerate with `python -m pipeline.impact`. That writes `web/public/data/impact.json`, which `ImpactPanel` displays. All facts were checked on 2026-11-14, and the hand-entered ones live in `pipeline/impact/sources.py`.

## In one paragraph

$172M of NASA landing contracts went on two landers that touched down and then tipped over (IM-1, IM-2). IM-2 came to rest inside a crater near Mons Mouton, one of the nine regions this app matches. By our estimate, a week of rehearsal on Earth for 10 people costs about $12.5k in lodging and meals. Even at ten times that, it would be under 0.3% of the smaller contract. Picking the nearest of our top three Earth matches cuts a 10-person team's flights from Calgary by 8.9 t CO₂e on average. All 57 matched sites are open ground rather than forest or wetland. Protected-area status has **not** been checked.

## 1. Money at stake (sourced)

These are NASA Commercial Lunar Payload Services (CLPS) task-order values, as of Feb 2024, from NASA OIG audit IG-24-013, Table 2.

| Mission | Task order | Outcome | Outcome source |
|---|---|---|---|
| IM-1 Odysseus (Intuitive Machines) | $122.0M (initial $81.7M) | Landed Feb 2024, tipped onto its side | OIG: "successfully landed on the lunar surface but tipped over onto its side" |
| IM-2 Athena / PRIME-1 | $50.0M (initial $47.0M) | Landed Mar 2025 inside a crater, on its side | [NASA release 25-025](https://www.nasa.gov/news-release/nasa-receives-some-data-before-intuitive-machines-ends-lunar-mission/) |
| Blue Ghost M1 (Firefly) | $101.5M (initial $93.3M) | Landed upright, Mar 2025 | [NASA release](https://www.nasa.gov/news-release/touchdown-carrying-nasa-science-fireflys-blue-ghost-lands-on-moon/) |
| Peregrine M1 (Astrobotic) | $107.9M (initial $79.5M) | Propellant leak; never attempted a landing | [Astrobotic post-mission report](https://www.astrobotic.com/wp-content/uploads/2024/08/PM1_Post-Mission-Report_Website.pdf) |

- **Headline: $172M = $122.0M (IM-1) + $50.0M (IM-2).** Peregrine is left out because its failure was a valve, not terrain.
- **IM-1 value:** NASA's 2019 award release said $77M ([link](https://www.nasa.gov/news-release/nasa-selects-first-commercial-moon-landing-services-for-artemis-program/)). The OIG figure is higher because it includes two add-on task orders.
- **Context, not added to the headline:**
  - CLPS maximum contract value: $2.6B through Nov 2028 ([NASA](https://www.nasa.gov/commercial-lunar-payload-services/)).
  - CLPS delivery task orders grew from $781.4M to $984.3M by Feb 2024, and NASA had paid $673M (OIG).
  - The VIPER rover project cost $505.4M (OIG) and was cancelled in Jul 2024.
- **ispace (Japan, not NASA):**
  - *Mission 1*, Apr 2023: crashed after the lander passed over a crater rim about 3 km high and its altitude estimate went wrong ([ispace](https://www.ispace-inc.com/2023/05/26/ispace-announces-results-of-the-hakuto-r-mission-1-lunar-landing/)). ispace booked ¥3,793M of insurance income for it ([ispace results](https://www.ispace-inc.com/2024/11/12/ispace-reports-q2-financial-results-for-fy-ending-march-2025-and-mission-2-launch-scheduled-no-earlier-than-jan-2025/)).
  - *Mission 2*, Jun 2025: crashed because of a laser range finder anomaly. Fixing it adds up to about ¥1.5B to the costs of Missions 3 and 4 ([ispace](https://www.ispace-inc.com/2025/06/24/ispace-releases-technical-cause-analysis-for-hakuto-r-mission-2/)). Insurance did not pay out ([ispace Q1 FY2027](https://www.ispace-inc.com/wp-content/uploads/2026/08/Consolidated-Financial-Results-for-the-First-Quarter-of-the-Fiscal-Year-Ending-March-31-2027.pdf)).
  - These figures are left in yen. ispace has published no official mission cost.

## 2. Cost of rehearsing on Earth (estimate)

- **No published cost exists** for the most relevant field campaigns. We searched for Desert RATS, JETT, the Mars 2020 Lander Vision System field tests, and NASA Flight Opportunities terrain-navigation flights. We do not invent one.
- **Our estimate:** 10 people × 7 days × ($110 lodging + $68 meals and incidentals) = **$12,460**.
  - Rates are the US GSA FY2026 standard CONUS per diem ([FTR Bulletin 26-01](https://www.gsa.gov/policy-regulations/regulations/federal-travel-regulation/ftr-and-related-files/gsa-per-diem-bulletin-ftr-2601)).
  - It excludes airfare, vehicles, equipment and salaries.
  - Even at 10× ($125k), it is about 0.25% of the $50M IM-2 task order.
- **Scale check (sourced):** Astrobotic's terrain-relative navigation sensor was developed under a $10M NASA Tipping Point contract ([Astrobotic](https://www.astrobotic.com/lunar-delivery/manifest/)). That covers a whole development programme, not one field week.

## 3. Travel emissions by site choice (computed)

- **Factor:** UK DESNZ 2026 GHG conversion factors, Business travel – air, *International, to/from non-UK, Economy class*.
  - **0.10916 kg CO₂e per passenger-km** with radiative forcing (contrail and other non-CO₂ warming).
  - **0.06449** without it.
  - Sources: [publication](https://www.gov.uk/government/publications/greenhouse-gas-reporting-conversion-factors-2026), [flat file v1.2](https://assets.publishing.service.gov.uk/media/6a6c9748862aaf18d9c62ac9/ghg-conversion-factors-2026-flat-format-revised.xlsx). The air values are identical to the 2025 set.
- **Distance:** haversine great-circle distance on the 6,371.0088 km mean Earth radius.
  - We add no extra uplift. The DESNZ methodology paper (para 8.38) says its 8% great-circle uplift for indirect routes and circling "is applied already to the conversion factors" ([methodology](https://assets.publishing.service.gov.uk/media/6a2940543b15d05a7ce3202e/2026-GHG-conversion-factors-methodology-report.pdf)).
- **Formula:** kg CO₂e per person = km × 2 (round trip) × factor.
  - Team saving = (km to farthest − km to nearest of the top 3) × 2 × factor × 10.

**Result.** Each region × hazard has a top 3, giving 27 rehearsals in total.

| Base | Nearest top-3, 10 people | Farthest top-3 | Mean saving | Median | Max | Nearest is also #1 |
|---|---|---|---|---|---|---|
| Calgary (51.05, −114.07) | 15.1 t | 24.0 t | **8.9 t** | 8.7 t | 20.4 t | 8 of 27 |
| Houston, NASA JSC (29.56, −95.09) | 13.6 t | 24.1 t | 10.5 t | 10.7 t | 23.1 t | 7 of 27 |

- **Compared with the #1 match** instead of the farthest, the nearest top-3 site saves 5.1 t on average from Calgary.
- **Fit trade-off:** in 19 of 27 cases the nearest site is not the best fit. You trade some fit for less travel, and the per-region rows in `impact.json` show both.
- **Limits:**
  - Straight-line distance, so real routes with connections emit more.
  - One average factor covers all flight lengths, though short flights emit more per km.
  - Ground travel is excluded.

## 4. Land and ecosystems (computed)

- **Open ground:** all 57 sites that appear in any top 3 have tree cover ≤ 10% and wetland plus mangrove ≤ 10% across the 15 km site ([ESA WorldCover 2021](https://doi.org/10.5281/zenodo.7254221)). Median tree cover is 0%.
  - **Built-up land:** every site is also ≤ 5% built-up.
  - **Why:** the screen (`pipeline/earth/screen.py`, `windows.py`) exists so the 30 m surface model measures ground, not canopy. Keeping teams off forests and wetlands is a side effect, not its design goal.
- **Protected areas: not checked.** `earth_sites.json` has no protected-area flag. Before any visit, check the [World Database on Protected Areas](https://www.protectedplanet.net/) and get local permits.

## What we deliberately did not claim

- **No dollar value for a landing prevented:** a field rehearsal does not guarantee a safe landing, and no public data links analog testing to landing success.
- **No published field-campaign cost:** none exists, so the $12.5k is labelled an estimate.
- **No yen-to-dollar conversion** for ispace, and no ispace mission cost.
