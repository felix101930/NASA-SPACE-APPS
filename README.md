# Moon on Earth

**Finding Earth places that stand in for the Moon's south pole.**

This is a NASA Space Apps 2026 project for the challenge *"Identify Earth Locations that Analog the Permanent Moon Base Locations and Mars"*.

## What it does
1. **Builds a danger profile for each Moon region.** For each of NASA's 9 candidate Artemis south-pole regions, we measure the dangers that hurt real landers:
   - **long low-sun shadows**, which affected IM-2;
   - **crater-rim height jumps**, which affected Hakuto-R;
   - **ground too featureless for camera navigation**, which affected Ingenuity;
   - **slope**.

   The measurements come from NASA LRO LOLA elevation data.
2. **Finds Earth places that match each danger.** We screen about 12,000 bare-land 15 km squares sampled from across Earth with the *same* measurements. For each region × danger we keep the top 3 Earth places and the dates and times when the Sun sits at the matching low angle there.
3. **Matches astronaut walks.** You draw a route on a Moon region and get an Earth path with the same ups and downs.
4. **Ranks the regions.** The summary orders the 9 regions from easiest to hardest to rehearse on Earth and shows the validation results.
5. **Adds an Alberta and Calgary view.** It covers every 15 km square in Alberta and matches Moon walks to City of Calgary pathways, prioritised with the Calgary Equity Index 2024.

**More detail:**
- Method and decisions: [docs/research-synthesis.md](docs/research-synthesis.md)
- File formats: [docs/data-contract.md](docs/data-contract.md), [docs/data-contract-alberta.md](docs/data-contract-alberta.md), [docs/data-contract-annotations.md](docs/data-contract-annotations.md)

---

## Quick start: run the website only
The website is static. It reads the precomputed files in `web/public/data/`, so you don't need Python to look at it.

**Requirements:** Node.js 24 or newer and npm 11 or newer.

```bash
cd web
npm install
npm run dev          # opens on http://localhost:5173
```

> **Note:** the 30 m Earth terrain tiles (`web/public/data/earth/*.bin`, about 270 MB) are not committed yet. Without them the Earth side of the 3D views shows an error panel. Every other screen works. To generate the tiles, run the pipeline below (`python -m pipeline.earth all`).

**Other scripts:**

| Command | What it does |
|---|---|
| `npm run build` | Type-checks, then builds to `web/dist/` |
| `npm run preview` | Serves the build locally |
| `npm run typecheck` | Runs the TypeScript checks only |
| `npm run mock` | Regenerates sample data in `web/public/mock/`. Use it only for UI work without real data. |

---

## Full setup: run the data pipeline

### 1. Requirements
- **Python 3.12.** We use [uv](https://docs.astral.sh/uv/) to install it. Python 3.14 is not supported yet by some dependencies.
- **About 10 GB of free disk** for cached downloads in `data/raw/` and `data/interim/`. Both folders are git-ignored.
- **A good internet connection.** Most inputs are read as small windows straight from cloud-optimised GeoTIFFs over HTTPS.
- **macOS or Linux.** GDAL comes inside the `rasterio` wheels, so you don't need a separate install.

```bash
uv python install 3.12
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt
source .venv/bin/activate
```

### 2. Free accounts (some steps only)

| Account | Needed for | Setup |
|---|---|---|
| **NASA Earthdata Login**: https://urs.earthdata.nasa.gov | The NASADEM cross-check and MODIS surface brightness | Add a line to `~/.netrc` (see below) |
| **NRCan EODMS**: https://www.eodms-sgdot.nrcan-rncan.gc.ca | The optional CSA RADARSAT / RCM radar panel | Add a line to `~/.netrc` (see below) |

Run this in your own terminal. It asks for the password without echoing it and keeps it out of your shell history:

```zsh
read "U?Earthdata username: "; read -s "P?Earthdata password: "; echo
printf 'machine urs.earthdata.nasa.gov login %s password %s\n' "$U" "$P" >> ~/.netrc
chmod 600 ~/.netrc; unset U P
```

For EODMS, run the same command but use the host `www.eodms-sgdot.nrcan-rncan.gc.ca`. **Never commit credentials.** `.env` and `.netrc` stay outside the repo.

Everything else needs no login: the LOLA/PGDA Moon data, Copernicus DEM on AWS, ESA WorldCover on AWS, Macrostrat, USGS, City of Calgary Open Data, the Calgary Equity Index and NRCan HRDEM.

### 3. Run the pipeline, in order
Every step is cached and idempotent: re-running it skips work that's already done. Add `--force` to recompute.

| # | Command | What it does | Approx. time (cold) |
|---|---|---|---|
| 1 | `python -m pipeline.moon all` | Places the 9 regions, cuts the LOLA windows (150 km horizons), computes the danger profile, validates against NASA PGDA illumination, and writes the 90 m fingerprints | ~7 min |
| 2 | `python -m pipeline.moon.extra_features` | Adds terrain-shape and surface-brightness features | ~1 min |
| 3 | `python -m pipeline.moon.annotations` | Writes the 3D labels: rim drops, featureless cells, slope classes, flattest patch | ~1 min |
| 4 | `python -m pipeline.earth all` | Runs the global Earth screen, adaptive sampling, documented analogs, zoom-in, re-rank, the 30 m stage 2, the NASADEM check, walk transects and `method.json` | 1.5–3 h, plus several GB of downloads |
| 5 | `python -m pipeline.alberta all` | Screens all of Alberta and builds the Moon walks in Calgary | ~20 min |
| 6 | `python -m pipeline.walkval` | Runs the walk matcher's hidden-copy validation | ~3 min |
| 7 | `python -m pipeline.match all` | Picks the final top 3 per region × danger, finds rehearsal windows, and writes the ranking and the validation summary | ~5 min |

Each step's sub-steps are listed by `--help`, for example `python -m pipeline.earth --help` (pool, screen, adaptive, documented, refine, rank, stage2, nasadem, transects, report).

Optional: `python -m pipeline.moon.usgs_regions` checks the 9 region locations against the official USGS LGRS extents (doi:10.5066/P1MEQ6UK).

### 4. Tests
```bash
python -m pytest tests -q
```
The tests include synthetic checks of the shadow, rim and texture metrics: a flat plane, a tilted plane, a cylindrical pit, a step edge, and curvature.

---

## Repository layout
```
pipeline/
  common/      shared config: paths, data URLs, constants
  metrics/     hazard metrics (horizon/shadow, rim jump, texture, roughness, shape, brightness, profiles)
  moon/        Moon regions, LOLA windows, danger profiles, PGDA validation, annotations, USGS check
  earth/       global Earth screen, stage 2 refinement, NASADEM check, walk transects, method.json
  alberta/     Alberta full screen and Moon walks in Calgary
  walkval/     walk matcher hidden-copy validation
  match/       final top-3 matches, rehearsal windows, ranking, validation summary
tests/         pytest suites
web/           React + three.js app (Vite); reads web/public/data/
data/          small committed inputs (candidate and documented analog lists, region coordinates); raw/ and interim/ caches are git-ignored
docs/          method, data contracts, research notes
```

## Main data sources
- **Moon:** NASA LRO LOLA south-pole DEM, PGDA product 90 (Barker et al. 2023); PGDA illumination product 69 (Mazarico et al. 2011); LOLA 1064 nm albedo; USGS LGRS region extents.
- **Earth:**
  - Copernicus DEM GLO-30 and GLO-90 (ESA, DLR, Airbus);
  - NASA NASADEM, used as a cross-check;
  - ESA WorldCover 2021;
  - NASA MODIS MCD43C3 albedo;
  - Macrostrat (CC-BY 4.0);
  - NASA GIBS imagery.
- **Canada:**
  - CSA RADARSAT and EODMS;
  - CSA Open Data, including the LEAD analog record;
  - NRCan HRDEM;
  - City of Calgary Open Data (Open Government Licence – City of Calgary);
  - Calgary Equity Index 2024.

Full citations and licences are listed in each output file's `meta.sources` and in the web app's credits.

## Honest limits
- The 30 m terrain can't see boulders or small craters.
- Shadows are matched by geometry only, but sky light fills Earth's shadows.
- The Earth screen is a sample of about 5–6% of bare land, not every square metre.
- No Earth place reproduces lunar gravity, vacuum or −200 °C nights.
- See the "Where it fails" section of the app's summary for the full list.
