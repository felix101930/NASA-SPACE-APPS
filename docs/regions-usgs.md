# Region centres vs. the official USGS LGRS extents

This check compares our 9 Artemis III region centres (`data/regions_coords.csv`, `web/public/data/regions.json`) with the official boundaries USGS published alongside the down-selected LGRS navigational grids.

**Result: all 9 regions are within 0.2 km of the official centroid, and every 15 x 15 km core lies fully inside its official extent. Nothing needs to move.**

## Sources

| Source | Identifier | Status (HTTP, 2026-11-14) | Used for |
|---|---|---|---|
| McClernan, M.T. (2024) *Down Selected Artemis III Candidate Landing Site Navigational Grids*, USGS data release, published 2024-12-05 | doi:[10.5066/P1MEQ6UK](https://doi.org/10.5066/P1MEQ6UK) | DOI resolves (200) to [ScienceBase 671a6fa8d34efed5620f89f8](https://www.sciencebase.gov/catalog/item/671a6fa8d34efed5620f89f8) | Primary source |
| `A3_9regions-lonlat-simplified.zip` (0.6 MB): the 9 region polygons as shapefile and GeoJSON, Moon 2000 sphere R = 1 737 400 m, lon/lat | `…/file/get/671a6fa8d34efed5620f89f8?name=A3_9regions-lonlat-simplified.zip` | 200, `application/zip`, 637 136 B. The `sciencebase.usgs.gov/manager/download/…` link returns an HTML app instead of the file | **Official extent** |
| `Mons_Mouton.zip` (68 MB, the smallest region zip). We kept only `Mons_Mouton_PolarLGRS_ACC_1km_S_Grid.*` and deleted the zip | same item | 200 | Cross-check against the 1 km grid, and a check of the LPS transform |
| `Publication_Data_Release_LGRS3.xml` (FGDC metadata) | same item | 200 | Datum: Moon 2015 sphere, semi-axis 1 737 400 m |
| usgs.gov landing page | https://www.usgs.gov/data/down-selected-artemis-iii-candidate-landing-site-navigational-grids | **403** to scripted requests (blocks bots). The DOI is used instead | none |
| data.gov / Astrogeology pages from the brief | catalog.data.gov `…navigational-grids-in-`, astrogeology `…/lunar-grid-reference-system-artemis-iii-candidate-landing-site-navigational-grids` | 200, but both describe the **older** release | not used |
| Older release: *LGRS Artemis III Candidate Landing Site Navigational Grids in ACC Format*, published 2024-11-05 | doi:10.5066/P13FD9ZD | 200. Different region set (Peak Near Shackleton, Connecting Ridge, Leibnitz Beta Plateau, Faustini Rim A, Amundsen Rim, de Gerlache Rim 1, Apollo sites, …) | Not used. Has no Slater Plain, Cabeus B or Mons Mouton Plateau |

**Licence:** USGS data is a US Government work and is in the public domain. Metadata `accconst`/`useconst`: "None". Cite the DOI.

**Download total:** about 174 MB. A failed HTTP Range probe (ScienceBase ignores Range) pulled Slater_Plain.zip once (106 MB, discarded). Mons_Mouton.zip was 68 MB. The other files were under 1 MB. Raw files are in `data/raw/usgs_lgrs/` (git-ignored).

**Data notes (anomalies, nothing acted on):**
- The `.qmd` sidecar in the boundary zip labels the layer EPSG:4326 (WGS 84). The `.prj` gives `GCS_Moon_2000`, R = 1 737 400. We used the `.prj`.
- The LGRS3 metadata XML still names an entity table `Peak_Near_Shackleton_PolarLGRS_ACC_1km_S_Grid.shp`. This is carried over from the older release.
- No hidden or embedded instructions were found in any downloaded file.

## Method (`pipeline/moon/usgs_regions.py`)

1. **Official extent.** Each region in the boundary file is a 4-corner polygon. We reproject the corners from `IAU_2015:30100` (Moon 2015 sphere, ocentric) to `MOON_CRS` (south polar stereographic, k0 = 1, R = 1 737 400).
   - LPS and `MOON_CRS` are the same projection family on the same sphere, so straight edges stay straight and reprojecting only the corners is exact.
   - The polygons come out as axis-aligned squares or rectangles in `MOON_CRS`.
   - Their planar area equals the USGS `Area_km2` attribute to 1e-4. In other words, USGS drew them in a k0 = 1 polar stereographic, the same as our grid. Six of them are exactly the PGDA-78 tile extents we already used.
2. **Transform check.**
   - lon/lat ↔ `MOON_CRS` round-trips to 1e-9°.
   - A point at lon 0°, lat −86° maps to y = 2R·tan(2°).
   - The LGRS grid `.prj` (Lunar Polar Stereographic South: k0 = 0.994, FE = FN = 500 km) agrees with the analytic `(X − 500 000)/0.994` to 0.1 mm.
3. **Grid cross-check (Mons Mouton).**
   - The union of the 289 1 km LGRS cells (17 x 17 LPS km, 292.5 km² in `MOON_CRS`) covers the 16 x 16 km official boundary.
   - The two centroids are 218 m apart, and the Hausdorff distance is 0.98 km. The grid is the boundary plus about one cell of padding.
   - The boundary file is therefore the tighter, authoritative extent.
4. **Metrics.**
   - Centroid: computed in `MOON_CRS`.
   - Area: true spherical area on the lunar sphere, from geodesic area over densified edges. It is 0.3–0.5% below the planar stereographic area.
   - `core_inside`: whether our 15 x 15 km core box at (x_m, y_m) is fully covered, intersecting, or outside the extent.
5. **Proposal.**
   - Start from the official centroid, snapped to 60 m like `pipeline.moon.regions`. Use it if the core fits there.
   - Otherwise use the nearest point to the centroid within the feasible-centre set (the polygon intersected with copies of itself shifted by the four core corners; exact for convex extents).
   - **Recommend `move`** if our core is not fully inside, or if our centre is more than 5 km from the centroid and the region is smaller than 1 500 km². For larger regions (only Mons Mouton Plateau) the offset alone does not justify moving.

## Comparison (`data/regions_usgs_compare.csv`)

| Region | our coord_quality | dist to USGS centroid (km) | core inside | USGS extent (km) | area (km², sphere) | min core margin (km) | recommend |
|---|---|---:|---|---|---:|---:|---|
| Peak near Cabeus B | traced_approx | 0.20 | full | 20.0 x 20.0 | 397.3 | 2.3 | keep |
| Haworth | pgda_site_tile | 0.03 | full | 29.8 x 29.8 | 886.6 | 7.4 | keep |
| Malapert Massif | pgda_site_tile | 0.02 | full | 21.0 x 21.0 | 439.9 | 3.0 | keep |
| Mons Mouton Plateau | traced_approx | 0.17 | full | 76.9 x 57.9 | 4429.6 | 21.4 | keep |
| Mons Mouton | pgda_site_tile | 0.03 | full | 16.0 x 16.0 | 255.2 | **0.5** | keep |
| Nobile Rim 1 | pgda_site_tile | 0.09 | full | 20.0 x 20.0 | 398.7 | 2.4 | keep |
| Nobile Rim 2 | pgda_site_tile | 0.03 | full | 20.0 x 20.0 | 397.8 | 2.5 | keep |
| de Gerlache Rim 2 | pgda_site_tile | 0.03 | full | 20.0 x 20.0 | 399.8 | 2.5 | keep |
| Slater Plain | traced_approx | 0.14 | full | 20.0 x 20.0 | 399.3 | 2.4 | keep |

`proposed_*` in the CSV is the snapped official centroid, offered as an alternative. For the six PGDA-tile regions it equals our current centre to within the 60 m snap, except Nobile Rim 1: the USGS square sits 70 m north of the PGDA Site06 tile.

## Recommendation

- **Move no regions.** The largest offset is 0.20 km (Peak near Cabeus B), 25 times under the 5 km threshold. The 15 km core lies fully inside the official extent everywhere.
- **Optional provenance upgrade.** We could set the three `traced_approx` regions (Peak near Cabeus B, Mons Mouton Plateau, Slater Plain) to the USGS centroids in the CSV: (−180 000, 70 020), (87 480, 148 020), (70 020, −49 980) m. This would only be to cite USGS as the coordinate source. Each shift is under 0.2 km, which is under 1.4% of the core width, so feature values would barely change. It is a provenance improvement, not a correction.
- **Mons Mouton has the tightest fit.** The official region is only 16 km wide, so the core has 0.5 km of margin. Any future enlargement of the core (above about 16 km) would spill outside this region.

## If any region were moved: what to re-run

Moving a centre invalidates everything keyed to that region's core window. In pipeline order:

1. **Moon** (`python -m pipeline.moon all --force`):
   - `regions`: rebuild interim `regions_coords.json` / `data/regions_coords.csv` with the new centre.
   - `windows`: near/far DEM windows, 30 m core tile, hillshade, DEM error.
   - `fingerprints`: `data/interim/moon/fingerprints_90m.json`.
   - `compute`: `web/public/data/regions.json` and the region tiles.
   - `validate`.
   - The extra shape/brightness features (`pipeline.moon.extra_features`) also read the core tile, so re-run them as well.
2. **Earth stage-1 ranking** (`python -m pipeline.earth rank`): it ranks every screened 90 m window by distance to `fingerprints_90m.json`.
   - Then re-run the stages that consume the shortlist: `stage2`, `transects`, `report`. These rewrite `earth_sites.json`.
   - Earth pool/screen tiles do not depend on Moon centres and can stay cached.
3. **Match** (`python -m pipeline.match all`): `moon_ref` is cached keyed on its input files, so it recomputes automatically when `regions.json` or the tiles change. Use `--force` to be safe.
   - This regenerates `web/public/data/matches.json` and the summary. Then refresh any web data derived from them (walks / summary screens).

Each region is computed independently, so outputs for unmoved regions stay valid. The Earth ranking and match still need a full re-run, because their outputs mix all regions.
