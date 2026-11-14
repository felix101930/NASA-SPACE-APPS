# Extra analog features: terrain shape and surface brightness

New, optional fingerprint features for the analog search. They are built on the same conventions as `pipeline/metrics`:
- grids are north-up, with row 0 at grid +y;
- the origin is the top-left corner;
- units are metres, and NaN means no data.

Moon values are in `data/interim/moon/fingerprints_extra.json`. To rebuild them, run `python -m pipeline.moon.extra_features --force`, which takes about 10 s.

| Module | Purpose |
|---|---|
| `pipeline/metrics/shape.py` | Bowl-shaped depressions, hypsometry, aspect statistics and curvature. Uses numpy and scipy, plus a small numba fill kernel. |
| `pipeline/metrics/brightness.py` | Moon LOLA 1064 nm albedo, Earth MODIS albedo, and the within-world rank. |
| `tests/test_shape.py`, `tests/test_brightness.py` | Synthetic tests. These run offline. |

## 1. Definitions

All shape lengths are given in metres, so 90 m and 30 m results share units. A coarser grid still smooths away small bowls.

### Bowl-shaped depressions

These are `shape_depr_*` values, from `depressions()`.

**How a depression is found**
1. The DEM is filled with a priority flood (Barnes et al. 2014). Water can drain only through the tile border or through pixels next to NaN.
2. Each 8-connected region where `fill depth = filled − dem > 0` counts as one closed depression. Its outline is the spill contour.

**A depression is kept only if all three of these hold**
- Depth is at least `max(2 m, 0.05·res)`. That is 2 m at 30 m and 4.5 m at 90 m.
- The equivalent diameter `D = 2√(A/π)` is between 3 px and 3 km.
- `depth/D ≥ 0.02`.

**Outputs**
- Count per 100 km² of valid area.
- The fraction of the area that lies inside depressions.
- The medians of D, depth and d/D.
- 101 quantiles of D and of depth. These are `[]` when there are no depressions.

**Limits**
- On Earth, most such bowls are sinks, dolines, kettles, playas or DEM artefacts, not impact craters. We only use their statistics, so we call them "bowl-shaped depressions".
- Nested craters count once, at the outer spill level.
- Bowls cut by the tile edge, and breached craters, are not counted.

### Hypsometry

These are `shape_hypso_*` values.
- `HI = (mean − min)/(max − min)` (Strahler 1952).
- A robust version uses p1/p99 in place of min/max.
- `shape_hypso_norm_height` gives 101 quantiles of `(h − min)/(max − min)`, which is the hypsometric curve.

Reading the values:
- A tilted plane gives 0.5.
- A peak-dominated tile is below 0.5.
- A bowl-dominated tile is above 0.5.

### Aspect

These are `shape_aspect_*` values. Aspect is the downslope azimuth, measured clockwise from grid +y, using Horn gradients. Only pixels with slope above 2° are used.

| Output | Meaning |
|---|---|
| `R` | Mean resultant length. 0 means slopes face all directions; 1 means one direction. |
| `R2` | Axial resultant, computed on 2θ. It is high for ridges and valleys, which face two opposite ways. |
| `mean_dir_deg` | Mean downslope direction. |
| `hist8` | 8-bin histogram, with bins centred on 0°, 45°, … |
| `hist8_aligned` | The same histogram rotated so the largest bin comes first. Use this one for Moon–Earth comparisons, because Moon grid +y is not geographic north. |

### Curvature

These are `shape_lap|prof|plan_{270m,1080m}_*` values, in units of 1/km.

**Method**
- Zevenbergen–Thorne second derivatives.
- The finite-difference step is `k = round(scale/res)` px, after a box filter of the same width.
- Scales are 270 m and 1080 m. At 90 m that means k = 3 and 12; at 30 m, k = 9 and 36.

**Sign convention: convex is positive**
- Peaks, ridges and crater rims are greater than 0.
- Bowls and valleys are less than 0.
- `lap = −(z_xx + z_yy)`.
- Profile curvature is measured along the slope line.
- Plan curvature is measured across it, and only where slope is above 2°.

**Outputs**
- Scalars: p05, p50 and p95, plus `convex_frac`.
- 101 quantiles for `lap` and `prof` at each scale.

### Brightness

These are `bright_*` values.

**Moon**
- Source: LOLA normal albedo at 1064 nm, from zero-phase laser returns, so it covers permanently shadowed regions (PSRs) too.
- Resolution: 1 km/px, giving 225 px per 15 km core.

**Earth**
- Source: MODIS MCD43C3 v061 white-sky albedo on the 0.05° climate-modelling grid (CMG).
- A pseudo-1064 nm value is interpolated between band 2 (858 nm) and band 5 (1240 nm): `a = 0.4613·b2 + 0.5387·b5`.
- Two dates are combined per cell: 2023-01-15 and 2023-07-15. Snow-free retrievals (≤ 10 % snow) are preferred.
- A 15 km window covers 3–4 × 3–4 cells.

**Comparing the two worlds**
- The Moon and Earth albedos differ in wavelength, illumination geometry and definition. **Never compare raw values.**
- Each window mean is converted to a **percentile rank within its own world**, among 15 km window means. This is `brightness_rank_feature()`, which also returns a robust log z-score.

**Reference populations**
- Moon: 15 km blocks south of 80° S. IQR is 0.311–0.333.
- Earth: preferably the screened window population, passed in by the caller. The fallback is `earth_reference()`: snow-free land blocks between 60° S and 75° N (751 k blocks, IQR 0.226–0.323).

**Why the CMG rather than the 500 m MCD43A3**
- One global file per date serves every window from memory. MCD43A3 would need about 300 sinusoidal tiles per date for 5–15 k windows.
- In practice, two downloads of about 190 MB each took about 1 min in total.

## 2. Hazard assignment (proposal)

| Feature | Hazard | Reason |
|---|---|---|
| Depression density and area fraction, d/D, D quantiles | **rim** (and general terrain) | Each bowl has a rim. These features set how often a 1 km track crosses one. |
| Curvature at 270 m and 1080 m (`lap`, `prof`), hypsometric curve and HI | **rim** (and general terrain) | Sharp convex breaks are rims and crests. HI separates massifs (low) from basins (high). |
| Aspect `R`, `R2` | **shadow** | Strongly oriented slopes put large areas in shadow at once when the sun is on the far side. Isotropic terrain spreads shadow over azimuth. |
| Brightness rank | **shadow**, **texture** | Dark ground lowers image SNR in low sun. Contrast between shadow and lit ground depends on albedo. |

## 3. Recommended distance

Use the same style as `pipeline/earth/rank_stage1.py`.

**Distribution features**
- Use `quantile_distance(earth_q, moon_q, floor)`. This is W1, the mean |ΔQ| over 101 quantiles, divided by `max(Moon IQR, floor)`.
- Floors are in `shape.SCALE_FLOORS`. Examples: 0.05 for normalised height, 0.05/km for curvature at 270 m, 90 m for D.

**Scalars**
- Compute |Δ| divided by the IQR of that scalar over the screened Earth population.
- Suggested floors: 1.0 for `depr_per_100km2`, 0.01 for `depr_area_frac`, 0.05 for `aspect_R` and `R2`, 0.05 for HI.

**Brightness**
- Use `brightness_distance(rank_e, rank_m) = |Δrank| / 0.5`. The value 0.5 is the population IQR of a rank.

**Combining with the existing metrics**
- Add the new terms as **one** averaged sub-term per hazard, for example `rim = mean(existing terms…, mean(shape terms))`. This keeps the validated metrics dominant.
- Re-check the known-vs-decoy AUC before and after adding them.

**Depression quantiles**
- If either side has no depressions, the quantile list is `[]` and the W1 term is NaN. Drop that term, and keep the density term.

**Mixing resolutions**
- Compare 90 m with 90 m, and 30 m with 30 m only. Use the matching `90m` or `30m` block from `fingerprints_extra.json`.

## 4. Runtime per window (Apple Silicon, one core)

| Step | Time |
|---|---|
| `shape_features`, 90 m core (166 × 166 px) | about 0.05 s. For 15 k windows that is about 13 min on one core; it parallelises trivially. |
| `shape_features`, 30 m core (500 × 500 px) | about 0.13 s |
| Earth brightness | about 0.14 ms/point, plus about 2 s for `load_cmg()`. The first run also downloads 2 × 190 MB, about 1 min. |
| Moon, all 9 regions × 2 resolutions + brightness | about 9 s |

## 5. Functions for earth-builder to call

```python
from pipeline.metrics.shape import shape_features, quantile_distance, SCALE_FLOORS, SHAPE_HAZARD_KEYS
from pipeline.metrics.brightness import (earth_brightness, earth_brightness_batch, earth_reference,
                                         brightness_rank_feature, brightness_distance)

shape_features(dem: np.ndarray, res_m: float, curv_scales_m=(270.0, 1080.0), min_slope_deg=2.0,
               min_depth_m=None, min_diam_px=3.0, max_diam_m=3000.0, min_depth_ratio=0.02
               ) -> {"scalars": dict[str, float | list[float]], "quantiles_101": dict[str, list[float]]}
    # dem = the core only (90 m: the same 166x166 core as fingerprint_dem; 30 m: 500x500), no buffer.

earth_brightness(lat: float, lon: float, window_km: float = 15.0, cmg=None) -> dict
    # bright_mean, bright_p10/p50/p90, bright_n_px, bright_snow_frac, bright_sw_mean, bright_quantiles_101
earth_brightness_batch(points: Iterable[tuple[float, float]], window_km=15.0, use_cache=True,
                       with_quantiles=False) -> list[dict]      # cache: data/raw/brightness/earth_points_cache.json
earth_reference(window_km=15.0, lat_range=(-60.0, 75.0)) -> list[float]   # 101 quantiles (fallback reference)
brightness_rank_feature(value: float, reference: Sequence[float]) -> {"bright_rank": float, "bright_z": float}
    # reference = 101 quantiles OR the raw sample of screened Earth window means (preferred)
brightness_distance(rank_earth: float, rank_moon: float) -> float
quantile_distance(earth_q, moon_q, floor) -> float
```

The Moon side reads `regions[rid]["90m"|"30m"]["scalars"|"quantiles_101"]` and `regions[rid]["brightness"]["scalars"]["bright_rank"]`. JSON `null` means NaN.

## 6. Moon values

| Region | Bowls/100 km² 90 m (n) | Bowls/100 km² 30 m (n) | HI | Aspect R / R2 (90 m) | lap 270 m p05/p95 (1/km, 30 m) | Albedo 1064 nm | Rank |
|---|---|---|---|---|---|---|---|
| cabeus_b_peak | 2.2 (5) | 8.4 (19) | 0.60 | 0.13 / 0.35 | −0.30 / 0.45 | 0.326 | 0.62 |
| haworth | 3.1 (7) | 60.0 (135) | 0.62 | 0.19 / 0.18 | −0.42 / 0.39 | 0.325 | 0.60 |
| malapert_massif | 2.2 (5) | 20.0 (45) | 0.60 | 0.17 / 0.73 | −0.36 / 0.44 | 0.316 | 0.39 |
| mons_mouton_plateau | 12.1 (27) | 53.8 (121) | 0.53 | 0.22 / 0.09 | −0.59 / 0.49 | 0.316 | 0.39 |
| mons_mouton | 8.5 (19) | 30.2 (68) | 0.76 | 0.19 / 0.27 | −0.55 / 0.50 | 0.329 | 0.69 |
| nobile_rim_1 | 3.1 (7) | 13.8 (31) | 0.71 | 0.41 / 0.37 | −0.39 / 0.50 | 0.319 | 0.46 |
| nobile_rim_2 | 4.9 (11) | 17.3 (39) | 0.70 | 0.21 / 0.10 | −0.50 / 0.51 | 0.311 | 0.26 |
| de_gerlache_rim_2 | 2.2 (5) | 22.7 (51) | 0.47 | 0.70 / 0.51 | −0.39 / 0.46 | 0.339 | 0.84 |
| slater_plain | 3.6 (8) | 24.9 (56) | 0.65 | 0.25 / 0.07 | −0.38 / 0.41 | 0.329 | 0.69 |

## 7. Sources (verified 2026-11-14)

### Moon albedo
- **Product:** PDS `LDAM_50S_1000M_FLOAT` (LRO-L-LOLA-4-GDR-V1.0).
- **URL:** https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/float_img/ldam_50s_1000m_float.img
- **Verification:** HTTP 200, 25,644,096 B. Mirrored at imbrium.mit.edu.
- **Licence:** PDS, public domain.
- **Citation:** Lemelin et al. 2016, Icarus 273:315, doi:10.1016/j.icarus.2016.02.006.
- **Grid check:** the polar-grid convention was checked by reading the PDS `LDEM_75S_240M` with the same code and comparing it with the PGDA 240 m DEM. RMS was 2 m at zero offset, against 35 m or more for a one-pixel shift.
- **Do not use:** the `LDRM_*` files are *roughness*, not reflectance, despite the name.

### Earth albedo
- **Product:** MODIS MCD43C3 v061, LP DAAC (doi:10.5067/MODIS/MCD43C3.061). Found with a CMR granule search and downloaded with an Earthdata login from `~/.netrc`.
- **Granules:** `MCD43C3.A2023015.061.2023024104905`, verified by download (191 MB), and `MCD43C3.A2023196.061.2023215170711`, verified by download (191 MB).
- **Licence:** no restrictions; cite the DOI.

## 8. Caveats

- **Vegetation is bright at 1064 nm.** In the global land reference, the Amazon ranks about 0.5, like the Atacama. Rank Earth windows against the **screened, bare-ground population** rather than `earth_reference()`.
- **Earth brightness is coarse.** It is a ~5.6 km CMG mean. It describes the window as a whole, not texture within it.
- **Moon brightness is also coarse:** 1 km. The Moon regions span only 0.31–0.34 in albedo, so ranks are sensitive to the reference domain.
- **Depression counts are not crater counts.** They depend on resolution. Haworth, for example, has 7 at 90 m and 135 at 30 m. Copernicus forest canopy and water bodies can create or hide sinks, so apply the existing bare-fraction filter first.
- **Aspect histograms are frame-dependent.** Use `R`, `R2` and `hist8_aligned` only.
