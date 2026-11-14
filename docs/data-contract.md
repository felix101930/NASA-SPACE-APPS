# Data contract: Python pipeline → web app

All outputs go to `web/public/data/`. The pipeline writes them and the web app only reads them.
This file is the single source of truth. Change it here first, then update both sides.

## Conventions
- **Hazard ids:** `shadow` (IM-2), `rim` (Hakuto-R), `texture` (Ingenuity / IM-2 optical navigation).
  - `slope` is an extra profile metric. It is not one of the 27 searches.
- **Region ids** (9): `cabeus_b_peak`, `haworth`, `malapert_massif`, `mons_mouton_plateau`, `mons_mouton`,
  `nobile_rim_1`, `nobile_rim_2`, `de_gerlache_rim_2`, `slater_plain`.
- **Common grid:** the Moon and Earth comparison tiles are both **30 m/px, 500×500 px (15×15 km core)**, north-up.
  - Moon tiles are in south-polar stereographic metres; "up" is grid +y.
  - Earth tiles are in a local UTM zone.
- **Binary tiles:** raw little-endian `Float32`, row-major, row 0 = top (north / +y), no header.
  - Heights are in metres. NaN means no data.
- **Tile origin:** `origin_x` / `origin_y` is the **top-left CORNER of pixel (0,0)**, matching rasterio `transform.c` / `transform.f`.
  - Pixel (row r, col c) has its centre at `(origin_x + (c + 0.5)·res, origin_y − (r + 0.5)·res)`.
  - Both the Python and TypeScript profile samplers must use this convention.
- **Azimuth on grids:** measured clockwise from grid +y. On Moon polar-stereographic grids, +y is not geographic north.
- **Times:** ISO 8601 UTC with a `Z` suffix. Angles are in degrees. Sun azimuth is clockwise from north.
- **Every JSON file** carries a `"meta"` block:
  `{ "generated_utc", "pipeline_version", "sources": [ {"name","url","licence","citation"} ] }`.

## `regions.json`
```json
{ "meta": {...},
  "regions": [ {
    "id": "malapert_massif", "name": "Malapert Massif",
    "lat": -86.0, "lon": 0.0, "x_m": 0.0, "y_m": 0.0,
    "coord_quality": "pgda_site_tile" | "traced_approx",
    "coord_source": "url or citation",
    "sun": { "el_min": -1.5, "el_max": 6.5, "note": "geometric, from latitude ± 1.54° declination" },
    "tile": { "path": "moon/malapert_massif.bin", "size": 500, "res_m": 30,
              "crs": "+proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +R=1737400 +units=m",
              "origin_x": 0.0, "origin_y": 0.0 },
    "hillshade": "moon/malapert_massif_hill.png",
    "shadow_masks": [ {"el": 1.0, "az": 90, "path": "moon/malapert_massif_sh_el1_az090.png"} ],
    "hazards": {
      "shadow":  { "score": 0.0, "level": "low|med|high",
                   "metrics": { "shadow_frac_el1": 0.0, "shadow_frac_el3": 0.0, "shadow_frac_el5": 0.0,
                                "shadow_frac_timeweighted": 0.0 } },
      "rim":     { "score": 0.0, "level": "...",
                   "metrics": { "jump1km_p95_m": 0.0, "jump1km_p99_m": 0.0, "frac_track_over_500m": 0.0 } },
      "texture": { "score": 0.0, "level": "...",
                   "metrics": { "fast_per_km2_el3": 0.0, "empty_cell_frac_el3": 0.0 } },
      "slope":   { "metrics": { "slope_p50_deg": 0.0, "slope_p90_deg": 0.0,
                                "rms_dev_m": {"60":0,"120":0,"240":0,"480":0,"960":0} } }
    },
    "uncertainty": { "dem_err_p50_m": 0.0, "notes": "..." }
  } ] }
```
- A hazard `score` is in 0..1, normalised across the 9 regions (min–max) for display.
- The raw `metrics` values are the truth.

## `earth_sites.json`
```json
{ "meta": {...},
  "sites": [ { "id": "EP001", "name": "...", "country": "...", "lat": 0, "lon": 0,
    "category": "impact_crater|known_analog|decoy|...", "known_analog": true, "role": "candidate|heldout_positive|decoy",
    "bare_frac": 0.0, "worldcover_note": "...",
    "rock": { "lith": "...", "anorthosite": false, "source": "macrostrat|none" },
    "tile": { "path": "earth/EP001.bin", "size": 500, "res_m": 30, "crs": "EPSG:326xx", "origin_x": 0, "origin_y": 0 },
    "hillshade": "earth/EP001_hill.png",
    "metrics": { "...same keys as the region hazards, plus slope...": 0 },
    "image_tile_url": "GIBS/HLS template or null",
    "citations": [ {"claim": "...", "url": "..."} ] } ] }
```

## `matches.json` (27 searches = 9 regions × 3 hazards, top 3 each)
```json
{ "meta": {...},
  "matches": [ { "region_id": "malapert_massif", "hazard": "shadow", "rank": 1, "site_id": "EP042",
    "distance": 0.0,
    "lights": [ { "metric": "shadow_frac_el3", "moon": 0.31, "moon_iqr": [0.2, 0.4], "earth": 0.27,
                  "gap_text": "4 pts less shadow", "light": "green|amber|red" } ],
    "matches_text": ["..."], "mismatches_text": ["..."],
    "cannot_test": ["1/6 g gravity", "hard vacuum", "−200 °C night", "Earth skylight fills shadows"],
    "windows": [ { "start_utc": "...", "end_utc": "...", "sun_el": 2.1, "sun_az": 92.0,
                   "el_kind": "apparent (refraction applied)" } ] } ] }
```
- Never output a "% Moon-like" figure.

## `summary.json`
```json
{ "meta": {...},
  "ranking": [ { "region_id": "...", "rank": 1, "rehearsability": 0.0, "per_hazard_best_distance": {"shadow":0,"rim":0,"texture":0},
                 "reason": "one line" } ],
  "validation": {
    "shadow_vs_pgda": { "pearson_r": 0, "mae": 0, "bias": 0, "n_px": 0, "note": "" },
    "known_vs_decoy_auc": 0, "weight_stability_jaccard": 0,
    "classifier_two_sample": { "per_region_auc": {}, "top_features": [] },
    "synthetic_tests": [ {"name":"flat_plane","passed":true} ],
    "where_it_fails": ["boulders < 30 m", "..."] } }
```

## Walk
- **`walk/transects.bin`:** Float32 array of shape `[N, 100]`. Each row is a slope profile in degrees, signed along the path, resampled to 100 points.
- **`walk/transects.json`:**
  `{ meta, "n": N, "points": 100, "items": [ {"i":0,"site_id":"EP001","x0":..,"y0":..,"x1":..,"y1":..,"lat0":..,"lon0":..,"lat1":..,"lon1":..,"length_m":2000,"climb_m":0,"max_slope_deg":0} ] }`
- **Preset routes:** `walk/presets.json` is `[ {"region_id","name","moon_xy":[[x,y],...],"best":[{"i":..,"dtw":..}]} ]`.

## `method.json` (powers the "How we find analogs" explainer)
Written by the Earth stage. It may be absent; the web app then falls back to mock data.
```json
{ "meta": {...},
  "screen": { "n_draws": 314104, "n_land": 88003, "n_pool": 30000, "n_screened": 4773,
              "coverage_km2": 1070000, "coverage_pct_bare": 5.8, "seed": 0,
              "strata": [ {"lat_band": "...", "relief_class": "low|mid|high", "n": 0} ] },
  "funnel": [ {"stage": "sampled|dsm_safe|stage1_top|stage2|final_top3", "n": 0,
               "known_pass": 0, "decoy_pass": 0} ],
  "validation": { "known_median_pct": 4.7, "decoy_median_pct": 60.0, "auc": 0.80,
                  "known": [ {"id": "EP001", "name": "...", "best_rank_pct": 0.0, "dsm_safe": true} ],
                  "decoys": [ {"id": "EP115", "name": "...", "best_rank_pct": 0.0} ] },
  "points": [ {"lat": 0, "lon": 0, "pass": true, "stage": "screened|shortlist|final", "best_dist": 0.0} ],
  "example": { "region_id": "malapert_massif", "hazard": "rim", "site_id": "...",
               "moon": {"metric": 0.0}, "earth": {"metric": 0.0} } }
```
- `points`: at most about 6,000 entries, with coordinates rounded to 0.01°.

## Patchiness (added to `matches.json` and `summary.json` by `pipeline/match/patchiness.py`)
A second indicator next to the level check. It is not part of the distance, the lights or the rank.
- **Each `matches[].lights[]` row also has:** `moon_blocks` and `earth_blocks` (25 floats each: the metric on the 25 blocks of 3 km in the 15 km square, row-major from the top-left, same code as the Moon IQRs), `moon_spread` and `earth_spread` (IQR of those 25 values, in the metric's units), `spread_ratio` (= earth_spread / moon_spread; null if the Moon spread is 0), and `patchiness` (`"similar"` if 0.67 ≤ ratio ≤ 1.5, `"smoother"` below, `"patchier"` above; the thresholds are illustrative). All of these are null when the blocks are unavailable.
- **`matches[].patchiness_summary`:** `{ metric, label, patchiness, spread_ratio, earth_spread, moon_spread, text }` for the hazard's headline metric (shadow `shadow_frac_el3`, rim `jump1km_p95_m`, texture `empty_cell_frac_el3`), or null. `text` is one plain sentence, e.g. "Varies about as much as the Moon site (Earth spread 113 m vs Moon 136 m)".
- **`summary.json` `patchiness`:** `{ n_top1, n_similar_headline, by_class: {similar, smoother, patchier, unavailable}, by_hazard: {h: {n, similar}}, headline_metric, thresholds, method }`.
- **Horizon:** shadow and texture blocks use the horizon decimated to every 5th pixel on both worlds, because that is what is stored for Earth sites. On the Moon this changes block spreads by about 0.002 or less for shadow fractions.
