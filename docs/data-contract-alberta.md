# Data contract: Alberta screen + "Moon walks in Calgary"

Producer: `pipeline/alberta/` (`python -m pipeline.alberta all [--force]`). Consumer: the web app.
All conventions in `docs/data-contract.md` still apply: every JSON file has a `meta` block, binary tiles are
row-major little-endian Float32 with row 0 = north, the origin is the top-left corner, and angles are in degrees.
Missing or non-finite numbers are written as `null`.

| File (under `web/public/data/`) | What it holds | Approx. size |
|---|---|---|
| `alberta/alberta.json` | Coverage, 27 region×hazard top-5 lists, metric lights, global comparison, site details | 0.2 MB |
| `alberta/alberta_windows.geojson` | All 3,082 province windows: pass/fail and best distance (province map) | 1.8 MB |
| `alberta/<id>.bin` | 30 m heights, 500×500 Float32 LE (one per refined site) | 1 MB each |
| `alberta/<id>_hill.png` | Hillshade of the same tile (8-bit grey, az 315°, alt 35°) | ~140 kB each |
| `calgary/walks.bin` | Float32 LE `[N, 100]` signed slope profiles (deg) | N×400 B |
| `calgary/walks.json` | Metadata for each walk (row i = `walks.bin` row i) | ~2–3 MB |
| `calgary/calgary_overlays.geojson` | 288 Equity Index tracts for the choropleth | 0.3 MB |
| `calgary/presets.json` | 18 Moon routes (9 regions × gentle/steeper) and their Calgary matches | 0.1 MB |

---

## `alberta/alberta.json`

```jsonc
{
  "meta": {
    "generated_utc": "...Z", "pipeline_version": "alberta-0.1",
    "sources": [ {"name","url","licence","citation"} ],   // Natural Earth, WorldCover, Copernicus DEM, LOLA (moon fp), CPCAD, GeoNames
    "method": { "tiling", "landcover", "fingerprint", "distance", "scalar_scales", "scalar_scales_source",
                "refine", "names", "parks" },               // human-readable strings, plus the scales dict
    "elapsed_s": { "screen": s, "refine": s, "export": s, "calgary": s }
  },
  "coverage": {
    "n_windows": 3082,            // every 15 km cell of the EPSG:3400 grid that touches Alberta (a full census)
    "n_pass": 129,                // pass the DSM-safe WorldCover rule
    "pct_area_pass": 4.2,         // share of Alberta's area covered by passing windows (clipped to the province)
    "province_km2": 663224, "pct_province_covered": 100.0, "tiled_km2": 693450,
    "fail_reason_counts": {"tree":..,"built":..,"crop":..,"water":..,"wet":..,"snow":..,"land":..},  // a window can fail for several reasons
    "n_fingerprinted": 3082,      // all windows get a 90 m fingerprint; only passing ones are eligible
    "n_eligible": 129
  },
  "best_per_hazard": {            // the smallest distance across the 9 regions, per hazard
    "shadow": { "region", "region_name", "id", "name", "lat", "lon", "distance",
                "park_label": null | "terrain comparison & visit — equipment testing not permitted without authorization",
                "named_parks": [], "global_best_distance": 0.10 },
    "rim": {...}, "texture": {...}
  },
  "searches": [                   // 27 entries (9 regions × shadow/rim/texture)
    { "region": "slater_plain", "region_name": "Slater Plain", "hazard": "rim", "n_eligible": 129,
      "top": [                    // up to 5, ascending distance
        { "rank": 1, "id": "AB_073_027", "distance": 0.199,
          "lights": [             // one per distance component of this hazard (see below)
            { "component": "jump1km", "label": "1 km height jump, P95 (rim / boulder-step proxy)",
              "unit": "m" | "frac" | "deg",
              "moon": 182.3, "alberta": 99.7,           // scalar values at 90 m (Moon fingerprint vs Alberta)
              "scale": 75.2, "scale_source": "Moon IQR of the 101-quantile distribution" | "IQR over the global earth screen population",
              "term": 0.42,                             // the normalised component of the distance
              "light": "green" | "amber" | "red",       // term <= 0.5 green, <= 1.5 amber, otherwise red
              "gap": "Alberta 100 m vs Moon 182 m: close to the Moon (distribution gap 0.42 × scale)" } ],
          "metrics_30m_vs_moon": { "<metric key>": {"moon": 182.7, "alberta": 102.2} } | null
              // 30 m compute_all values for this hazard's contract keys (data-contract.md), vs regions.json
        } ],
      "global_screen": {          // omitted if the earth stage-1 files are missing
        "best_distance", "best_id", "best_lat", "best_lon", "n_eligible",
        "alberta_best_rank_among_global",   // 1 + number of global eligible windows strictly closer than Alberta's best
        "ratio_alberta_to_global", "note" },
      "terrain_only_best": {      // the closest window on terrain alone; FAILS the land-cover rule, NOT eligible
        "id", "distance", "name", "lat", "lon", "dsm_pass", "fail": ["tree"], "park_label", "named_parks", "note" }
    } ],
  "sites": {                      // every window that appears in any top-5 list
    "AB_073_027": {
      "id", "name": "Kohler Coulee · 21 km SW of Nanton", "lat", "lon",
      "nearest_town_1000": {"name","dist_km","dir","pop","admin1","feature_code"},
      "nearest_place": {...}, "nearest_terrain_feature": {...},
      "frac_in_ab": 1.0,          // share of the 15 km window inside Alberta
      "window_3400": {"x0", "y1", "size_m": 15000},   // EPSG:3400 top-left corner of the census cell
      "worldcover": {"tree","shrub","grass","crop","built","bare","snow","water","wet","moss","land","valid"},
      "park": { "in_protected_area": false, "areas": [{"name","type","frac"}], "named_parks": [],
                "label": null | "terrain comparison & visit — equipment testing not permitted without authorization",
                "status_source": "CPCAD (ECCC) polygons; overlap = share of the 15 km window" },
      "fingerprint_90m": { "slope_p50_deg", "slope_p90_deg", "relief_m", "jump1km_p95_m", "jump1km_p99_m",
                           "frac_track_over_500m", "nu_180", "nu_360", "nu_720", "nu_1440",
                           "shadow_frac_local_el1", "shadow_frac_local_el3", "shadow_frac_local_el5", "elev_mean_m" },
      "tile": { "path": "alberta/AB_073_027.bin", "size": 500, "res_m": 30.0, "crs": "EPSG:32612",
                "origin_x", "origin_y", "origin_note", "true_north_grid_az_deg" } | null,
      "hillshade": "alberta/AB_073_027_hill.png" | null,
      "metrics_30m": { ...compute_all keys (data-contract.md), with extras... } | null,
      "core_relief_m": 430.0
    } }
}
```

Notes for the UI:
- **Distances.** These are the global earth screen's stage-1 distances, on the same scales. Lower is more
  Moon-like, and values are comparable with `global_screen.best_distance`. Do not compare raw distances across
  hazards.
- **Shadow at 90 m.** This is the local proxy (`shadow_frac_local_*`, window + 15 km buffer, no far field).
  The 30 m `metrics_30m.shadow_frac_el*` include the far field out to 150 km, so the two numbers differ.
- **Tile placement.** A site's tile is centred on the window centre but uses a local UTM grid. Its census cell
  (`window_3400`) is in EPSG:3400, so the two squares are rotated slightly relative to each other.

## `alberta/alberta_windows.geojson`

A FeatureCollection with `meta` at the top level. There is one Polygon feature per census window, with
coordinates in lon/lat taken from the four EPSG:3400 corners.

`properties`:
`id`, `name`, `lat`, `lon`, `pass` (DSM-safe), `eligible` (pass + fingerprint ok + nodata < 5 %),
`fail` ("tree,crop"...), `frac_in_ab`, `best_distance` (minimum over the 27 searches; eligible windows only, else
null), `best_distance_terrain_only` (same, for every window), `best_hazard`, `best_region`, `d_shadow`, `d_rim`,
`d_texture` (minimum over regions, terrain only), `in_protected_area`, `wc_tree`, `wc_crop`, `wc_grass`, `wc_bare`.

## `calgary/walks.bin` + `calgary/walks.json`

- `walks.bin`: Float32 LE, shape `[N, 100]`. Each row is a signed slope profile in degrees (+ = climbing in
  the direction of travel) at 100 points equally spaced along the walk. Row i belongs to `items[i]`
  (`items[i].row == i`).

```jsonc
{
  "meta": { ..., "method": {"profile","dtm","scale_factor_K","seed","orientation","grades"}, "licence_note" },
  "bin": {"path": "calgary/walks.bin", "dtype": "float32-le", "shape": [N, 100]},
  "stats": { "n_routes", "n_generated", "dropped": {"nodata","steep_artifact"},
             "pct_start_within_400m_of_active_stop", "median_length_m", "median_mean_abs_slope_deg",
             "p95_max_grade_pct", "pct_in_park", "pct_bridge_repaired", "pct_in_highest_or_high_need_tract",
             "elapsed_s" },
  "notes": "honest caveats (Moon slopes are steeper; outreach, not testing; not accessibility-certified)",
  "items": [ {
    "id": "YYC00042", "row": 42,
    "coords": [[lat, lon], ...],          // ≤ 50 points, simplified; NOTE the order is [lat, lon]
    "park": "Nose Hill Park" | null,      // City Parks Site containing most of the route's edges
    "length_m", "climb_m", "descent_m",   // from the 100-point profile
    "max_grade_pct", "mean_grade_pct",    // |tan(slope)| × 100 over the 100-point profile (free by-products)
    "mean_abs_slope_deg", "regional_frac", // share of length on REGIONAL pathways
    "bridge_repaired": false,             // DTM dip under a bridge/overpass interpolated across
    "near_stop": { "name", "stop_id", "routes": ["3 Sandstone / Elbow Drive", ...], "dist_m" },  // nearest ACTIVE stop to the start
    "tract": { "ctuid", "name", "communities", "access_domain_score", "access_category",
               "transit_score", "walk_score", "park_proximity" } | null   // Equity Index 2024 tract of the route midpoint
  } ]
}
```

- **Accessibility labels are not produced.** Per the project's scope decision there are no
  `paved`/`gentle_paved`/≤5 %/≤8.33 % flags. Inclusion comes from transit proximity (`near_stop`) and from
  the Equity Index (`tract`), which is also the preset tie-break.
- **Equity Index direction (need, not access).** The City of Calgary states: "When interpreting the total equity
  score and domain scores, a higher score means greater inequities and needs and more barriers to equity"
  (https://www.calgary.ca/research/calgary-equity-index.html; the 2024 version inverted the earlier scoring).
  So `access_domain_score` / `access_category` measure **need**: `Highest` = greatest barriers to access and
  amenities. The preset tie-break prefers `Highest`, then `High` (order in `CAT_RANK`, `calgary_walks.py`).
  In the 2024 data this domain has Spearman ρ = −0.83 with the index's Transit Score and −0.88 with its Walk Score,
  so the highest-need tracts are mostly outer suburbs with weak transit.
- **Orientation.** Walks are oriented so the start is the end nearer an ACTIVE stop.

## `calgary/calgary_overlays.geojson`

288 Polygon/MultiPolygon features in lon/lat, simplified to about 9 m. `properties`: `ctuid`, `name`,
`communities`, `access_domain_score` (Accessibility & Amenities domain score), `access_category`
(`Lowest|Low|Moderate|High|Highest`; Highest = greatest need, see above), `transit_score`, `walk_score`, `park_proximity`.

## `calgary/presets.json`

```jsonc
{ "meta": {..., "method": {"moon_routes","dtw","candidates","tie_break"}}, "notes": "...",
  "presets": [ {                          // 18 = 9 regions × {gentle, steeper}
    "region", "region_name", "kind": "gentle" | "steeper", "percentile_of_tile_routes": 10 | 60,
    "length_m": 1500, "moon_xy": [[x0, y0], [x1, y1]],   // straight route on moon/<region>.bin, polar-stereographic m
    "mean_abs_slope_deg", "max_slope_deg", "climb_m", "slope_deg": [100 values], "n_tile_candidates",
    "slope_gap_deg",                      // Moon mean |slope| − recommended Calgary walk mean |slope|
    "match": {
      "recommended": Row,                 // after the tie-break (Highest/High need first, then transit)
      "strict_best": Row,                 // lowest DTW
      "tie_break_applied": bool, "n_in_tie_band", "n_length_compatible",
      "top": [Row × 5]                    // by DTW
    } } ] }
// Row = { "id", "row", "dtw_deg", "length_m", "park", "mean_abs_slope_deg",
//         "near_stop": {"name","dist_m","routes"}, "access_category", "access_domain_score",
//         "tract", "communities" }
```

- **DTW.** Sakoe–Chiba band of 10 samples on the 100-point slope profiles. The cost is |Δslope| in degrees,
  averaged over the warping path, so `dtw_deg` reads as the typical slope mismatch.
- **Tie band.** Walks within 10 % (+0.05°) of the best DTW are treated as ties.

## `calgary/equity.json` (Calgary Equity Index analysis)

Producer: `pipeline/alberta/equity_analysis.py` (`python -m pipeline.alberta equity [--force]`; also runs after
`calgary` and `all`). Reads `walks.json`/`walks.bin`, `presets.json` and the cached Equity Index layer 2
(Accessibility & Amenities domain with `TOTAL_POPULATION`, plus the Total Equity Score, Human and Social
Wellbeing and Community Belonging and Safety domains, cached as `data/raw/alberta/calgary/equity_<key>.geojson`).
About 20 kB. Equity Index direction: higher score = **greater need** (see above).

Definitions:
- **Suitable route**: starts within 400 m of an ACTIVE stop **and** matches at least one of the 18 Moon presets
  with banded DTW **< 1.0°** (same matcher as `presets.json`: Sakoe–Chiba radius 10, candidates 0.6–1.6× the
  Moon route's length; same threshold as the UI's "Calgary match").
- **Covered tract**: at least one suitable route has its midpoint in the tract (`walks.json` `tract`).
- **Event score** (top 5): `need × transit × quality`, one route per tract (its best `transit × quality`), starts
  ≥ 2 km apart (greedy in rank order). `need` = percentile of the Accessibility & Amenities score among the
  288 tracts (0–1); `transit` = 0.5·(1 − stop distance/400 m) + 0.5·min(routes at the stop, 4)/4 (school-term specials numbered 600–899 not counted; `near_stop.routes` lists the others, `n_school_routes` counts them);
  `quality` = 1 − DTW/1°. Ties: tract id, then route id.
- **Minutes' walk**: ceil(distance / 80 m per min), an assumed 4.8 km/h pace.

```jsonc
{
  "meta": { ..., "method": {"suitable_route","covered_tract","need","population","event_score","minutes_walk",
                            "nearest_suitable","robustness","scale_note"}, "cei_source", "cei_quote", "licence_note" },
  "headline": "40 of 57 highest-need neighbourhoods have a Moon-walk route that starts within 400 m of a bus or train stop",
  "summary": { "n_tracts": 288, "n_routes", "n_routes_in_a_tract", "n_routes_near_stop", "n_routes_moon_match",
               "n_routes_suitable", "n_tracts_covered", "suitable_by_moon_route": {"<region>:<kind>": n},
               "n_suitable_matching_a_steeper_moon_route": 0 },
  "coverage": [                      // 5 rows, Highest -> Lowest (Accessibility & Amenities category)
    { "category", "n_tracts", "n_with_any_route", "n_covered", "pct_covered",
      "population", "population_covered", "pct_population_covered", "n_suitable_routes" } ],
  "coverage_total_equity": [ ...same rows by Total Equity Score category (robustness check)... ],
  "gap": { "high_need": {"categories": ["Highest","High"], "n_tracts", "n_covered", "pct_covered",
                         "population", "population_covered", "pct_population_covered"},
           "low_need": {...Low/Lowest...}, "gap_pct_points", "direction": "higher"|"lower"|"about the same",
           "statement": "plain-language sentence" },
  "top_events": [ { "rank", "ctuid", "tract", "communities", "place", "park", "access_category",
                    "access_domain_score", "need_percentile", "population", "route_id", "length_m",
                    "near_stop": {"name","dist_m","minutes_walk","routes","n_school_routes"},
                    "moon_match": {"region","region_name","kind","dtw_deg"},
                    "factors": {"need","transit","quality"}, "score", "why" } ],   // 5, score descending
  "uncaptured_highest": { "n", "reasons": {"no_route","far_from_stop","no_slope_match"},
    "tracts": [ { "ctuid", "tract", "communities", "population", "access_domain_score", "n_routes_sampled",
                  "reason", "why",
                  "nearest_suitable": {"route_id","place","ctuid","dist_km","stop_name","stop_dist_m"} } ] }
}
```

- `route_id` and `nearest_suitable.route_id` are `walks.json` ids (row = `walks.bin` row).
- `communities` drops the City's residual sub-area codes (e.g. `03W`); a tract with no named community shows
  `Census tract <NAME>`. `nearest_suitable.dist_km` is straight-line, tract centroid → route start.
- Coverage depends on where City pathways exist and on the 2,762-route sample; "not covered" means no suitable
  route **in this sample**, not that the neighbourhood has no pathways.

## `alberta/standing.json` (written by `pipeline/match/alberta_standing.py`)
Every Alberta site with a 30 m tile, scored with the final-round matcher (`pipeline.match.matches`: the same terms, weights, Moon IQR scales, shape and brightness features) for every region × danger.
- `rows[]`: `{site_id, region_id, hazard, distance, rank_measured, n_measured, rank_picks, n_picks, world_best_distance, world_best_site, missing_terms}`.
- `rank_measured` = 1 + the number of sites measured in detail (`earth_sites.json`, 324) that are strictly closer for that region × danger. `rank_picks` is the same among the sites in `matches.json` (57). A `rank_picks` of `n_picks + 1` means it is behind every pick.
- Alberta sites are scored but not added to the candidate pool: this is where they *would* stand, and `matches.json` is unchanged.
- The stage-1 figure in `alberta.json` (`global_screen.alberta_best_rank_among_global`, for example #347 of 6,139) is a different, coarser comparison: 90 m fingerprints against every eligible screened window.
