# Data contract: per-region 3D annotations

## Annotations for "Explore in 3D" (`<region_id>_annotations.json`)

Built by `python -m pipeline.moon.annotations [--force] [--region ID ...]` from
`web/public/data/regions.json`, the web tiles `moon/<id>.bin`, the shadow-mask PNGs, and the cached
`data/interim/moon/<id>_near20.npz` + `<id>_horizon30.npy`. The 150 km horizons are reused from the
cache, never recomputed. The run exits non-zero if any recomputed value disagrees with the profile.

Outputs, one set per region (9 regions) in `web/public/data/moon/`:

| File | Contents |
|---|---|
| `<id>_annotations.json` | compact JSON, < 150 KB (~40 KB in practice), `schema: "annotations/1"` |
| `<id>_slope_classes.png` | 125×125 uint8 grayscale; pixel value = slope class 0..3 (see below) |

### Positions

Every position is an object `{"px": [col, row], "xy": [x, y]}`:

* `px`: continuous tile pixel coordinates. The origin is the **top-left corner** of pixel (0,0) and
  rows run downward, so the centre of pixel (c, r) is (c+0.5, r+0.5). Range is 0..500.
  Local tile metres are `px * res_m` (x to the right, y downward).
* `xy`: projected metres (south-polar stereographic, `tile.crs` in regions.json),
  `x = origin_x + col*res_m`, `y = origin_y - row*res_m`.
* A bbox is `{"px": [col0, row0, col1, row1], "xy": [xmin, ymin, xmax, ymax]}`.
* Azimuths are degrees clockwise from grid +y (tile up). `grid-east` means the tile's right side.
  Grid north is **not** geographic north at the pole.

### Top-level keys

| Key | Meaning |
|---|---|
| `region_id`, `name`, `schema`, `generated_utc` | identification |
| `tile` | `size`, `res_m`, `origin_x`, `origin_y`, `convention`, `dem_source` |
| `rim_drops` | the biggest 1 km height changes |
| `texture` | featureless and feature-rich 1 km cells |
| `steep_mask_summary` | slope fractions and the class PNG |
| `shadow` | per-mask shadow fraction and largest dark patch |
| `safest_patch` | the largest flat landing-style patch, or `null` |
| `labels` | 4–6 short callouts for the 3D view |
| `profile_mismatches` | list of strings; empty when everything agrees with regions.json |

### `rim_drops`

Same scan as `rim.rim_jump_stats` / `jump_samples`: for every pixel and 16 directions over 180°,
dh = h(p + 1 km·u) − h(p), with the partner height interpolated bilinearly. Picks are greedy by |dh|.
After each pick, every candidate whose midpoint lies within 1.5 km of that pick's midpoint is
removed. With 1 km segments, this guarantees the picks do not overlap.

* `p95_m`, `p99_m`: recomputed percentiles. `profile_p95_m`, `profile_p99_m`: the values from
  regions.json. The UI can say "above the 95th percentile" when `above_p95` is true.
* `drops[]` (5 items): `rank`, `start`, `end`, `mid` (positions), `dh_m` (= h(end) − h(start),
  ≤ 0, because each segment is oriented from the high end to the low end), `abs_dh_m`,
  `direction_deg` (from start to end), `above_p95`, `label` (e.g. "440 m drop over 1 km").
  An endpoint can fall between pixels on diagonal directions. Its height is then the bilinear value
  at `px - 0.5`.

### `texture`

The same render as `texture.texture_stats`: `render_hillshade` with cast shadows from the cached
horizon, a 3° sun, 8 azimuths (0, 45, …, 315), and FAST-9 (threshold 20, NMS). Keypoints are
binned into 15×15 cells of 1 km by keypoint pixel index, exactly like `fast_density`.

* `empty_az_frac` per cell: the share of the 8 renders in which that cell has 0 keypoints.
* `empty_frac` = mean of `empty_az_frac` over all 225 cells. This equals
  `hazards.texture.metrics.empty_cell_frac_el3`; the tests assert agreement to 1e-5.
* `texture_empty_cells[]`: every cell with `empty_az_frac > 0`, sorted from most to least empty.
  Each cell has `i` (row, 0 = top), `j` (col), `bbox`, `empty_az_frac`, `mean_keypoints`.
  `n_cells_always_empty` counts cells that are empty in all 8 renders.
* `feature_rich_cells[]`: the 4 cells with the most keypoints, shown for contrast.

### `steep_mask_summary`

The Horn slope from `roughness.slope_deg` on the 30 m tile.

* `frac_ge_15deg`, `frac_ge_25deg`, and `class_fracs` (classes 0 <8°, 1 8–15°, 2 15–25°, 3 ≥25°),
  all at full 500×500 resolution.
* `slope_p50_deg`, `slope_p90_deg` are checked against the profile values.
* `illustrative_thresholds: true` and `thresholds_note`. These thresholds are **illustrative, not
  mission requirements**. ~8–10° is the order of the HLS landing-slope limit, and ~20–25° is the
  order of the EVA walking limit. A 30 m slope smooths out steeper metre-scale features.
* `class_png`: `<id>_slope_classes.png`, 125×125. Each pixel is the class of the **mean** slope of
  one 4×4 block (120 m), with row 0 at the top. Values 0..3 are stored raw, so the UI needs to map
  them to colours.
* `steepest_area`: the largest 8-connected ≥25° blob (falling back to ≥15° when there is none),
  stored as a blob summary.

### `shadow`

One entry per mask in `regions.json.shadow_masks` (el 1/3/5 × az 0/90/180/270): `el`, `az`, `path`,
`frac`, `sun_from`, `largest_blob`, `label`.

* `frac` = count(255) / count(≠128), read straight from the PNG.
* `largest_blob`: the largest 8-connected shadow component, stored as a blob summary.
* `label` example: "largest dark patch: 6.2 km² at a 3° sun from grid-east".

A **blob summary** has `area_km2`, `n_px`, `centroid`, `anchor`, and `bbox`. The `centroid` can fall
outside an irregular blob. The `anchor` is the blob pixel farthest from the blob's edge, so it is
always inside the blob; use it to place labels.

### `safest_patch`

Illustrative HLS-style rule: slope < 8° **and** ≥ 100 m (Euclidean distance) from every pixel with
slope ≥ 8°. Pixels beyond the tile edge are unknown and are not counted as steep. The output is the
largest 8-connected qualifying blob, stored as a blob summary. It also has `label` ("flattest patch:
X km² under 8°"), `rule`, and `total_safe_km2` (all qualifying pixels, not only the largest blob).

### `labels`

There are 4–6 labels, normally one per hazard: shadow, rim, texture, slope, safe. Each label has
`hazard`, `anchor` (position), `title`, `text`, and `ref` (pointer back into this file). The numbers
in the text are quoted from the regions.json `hazards` block: shadow_frac_el3, jump1km_p95_m,
empty_cell_frac_el3, slope p50/p90. The geometry comes from this file. Anchors:

* shadow: the 3° mask with the largest blob
* rim: midpoint of drop rank 1
* texture: the centre of the most-empty cell
* slope: the steepest area
* safe: the safest patch

### Validation (`tests/test_annotations.py`)

* All positions lie inside the tile, and `xy` is consistent with `px`.
* Each rim drop's `dh_m` equals the DEM difference at its endpoints (bilinear on the `.bin`).
* `p95_m` matches the profile.
* `empty_frac` matches regions.json.
* Mask fractions match the PNGs.
* A synthetic step-edge tile yields drops that cross the step with dh = −step.
* `jump_grid` reproduces `rim.jump_samples`.
* The safe-patch buffer behaves as specified.
* Each file is < 150 KB.
