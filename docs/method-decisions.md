# Method decisions: what we do, why it fits the problem, how accurate it is

This file is the source for the site's ⓘ info boxes and the "How sure are we?" section. Every number comes from our own runs (see the commit history and `docs/research-synthesis.md`).

| Our choice | Why it fits the problem | A simpler choice would… | How accurate (evidence) |
|---|---|---|---|
| Compare the whole spread of values (101 quantiles), not the average | Danger lives in the extremes: a lander is lost on the one steep patch, not the average slope | An average hides that two regions with the same mean slope differ completely in their steep parts | Every metric is compared as a full distribution (Wasserstein distance on quantiles) |
| Rim drops: the 95th and 99th percentiles of height change over 1 km, not the maximum | Hakuto-R was fooled by a big real drop, so we care about the near-worst cases | The single maximum is often one bad pixel | LOLA height error is ±0.3–0.5 m, against drops of 300–570 m. A synthetic step test recovers the exact height. |
| Drops measured over 1 km | The scale at which a descending lander's altitude reading jumps | Short distances depend on the data resolution (20 m vs 30 m) | 1 km spans 50 px on the Moon and 33 px on Earth, so the result is about the same on both |
| Shadows include terrain up to 150 km away, with the Moon's curvature | At a 1–3° sun, distant peaks shadow the site (IM-2's situation) | Looking only 15 km out makes sites 5–7 pts too bright, and up to 34 pts off for one sun direction | Against NASA PGDA sunlight (375,000 px): r = 0.979, R² = 0.92. Average error (MAE) is 2.7 percentage points and RMSE 3.6. We run 2.5 points darker on average; with that offset removed, MAE is 1.7 points. Per region: r 0.96–0.98. |
| Sun at 1°, 3° and 5° | The south-pole sun stays near the horizon | A normal sun angle would not reproduce the hazard | Computed per region from latitude. On Earth, refraction (~0.3–0.6° near the horizon) is applied, and windows below 1° are flagged. |
| Both worlds on the same 30 m grid | A fair comparison needs equal detail | Using the Moon's 20 m data makes it look 2× more trackable (36 vs 19 features/km², measured) | Same code and same resolution on both worlds |
| Camera texture counted on shaded terrain with real cast shadows | Ingenuity's camera found too little to track, and low sun hides features | Ignoring shadows overcounts trackable points about 4× (159 → 36 /km², measured) | Least certain measure: NASADEM vs Copernicus agreement is only r = 0.62 |
| Filter out trees, buildings, farmland, water and ice, but keep low scrub | Earth elevation data includes treetops and roofs, which fake the terrain | "Bare ground only" removed 9 of 13 known analogs (desert scrub is mapped as shrub) | 8 of 13 known analogs pass; all 9 decoys still fail |
| Scale each difference by the Moon region's own typical spread (IQR) | Puts metres, degrees and percentages on one scale | Raw differences let the largest-numbered unit dominate | The IQR uses the middle 50%, so outlier pixels don't skew it |
| Dropped crater-bowl counts | Tested, not assumed | Forest canopy and farmland mimic bowl shapes in the data | Known-vs-decoy separation fell from 0.80 to 0.70 with them included |
| Sampled ~12,000 bare-land squares (~14% of bare land) | Fingerprinting every square on Earth isn't feasible in a weekend | — | It's a sample. The final top-3 sites reappear in 81% of reruns with a fresh sample. |
| Second elevation dataset (NASA NASADEM) as a cross-check | Results shouldn't depend on one dataset | — | Shadow, drop and slope agree (r 0.96–1.00). Texture agrees r = 0.62, so the exact top 3 can shift (overlap 0.51). |
| Known analogs vs decoys as the validation test | A working method should rank Moon-training sites above farmland and forest | — | AUC 0.80 (13 original analogs, which were also used to choose features); 0.87 on 7 independent held-out documented sites |
| Walk matcher: height + slope comparison, not DTW | Tested by hiding a distorted copy of each Moon route among 22,000 Earth paths | DTW found the copy first only 38% of the time | Height + slope finds it first 77% of the time |
| Region locations | — | — | All 9 lie within 0.2 km of the USGS official extents (doi:10.5066/P1MEQ6UK) |

## Limits we state up front
- Features under ~60 m (boulders, small craters) are invisible at 30 m.
- Sky light softens shadows on Earth; on the Moon they are black.
- Sun below 1° is refraction-sensitive on Earth.
- On Earth this low sun lasts minutes; at the lunar pole it lasts days.
- No Earth place reproduces 1/6 g gravity, vacuum or −200 °C nights.
- Moon elevation uncertainty: ±0.3–0.5 m height, ±1.5–2.5° slope (Barker et al. 2021/2023).
