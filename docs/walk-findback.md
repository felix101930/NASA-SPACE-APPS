# Walk matcher find-back test

**Question:** if a lunar walk had an exact twin on Earth, would the astronaut-walk search find it?

**Method (from Felix's METHOD.md):** draw a walk on the Moon, make a slightly damaged copy of it,
hide the copy among the ~22,000 real Earth walks, and see where the search ranks it. Rank 1 means
the search put the hidden copy above every real Earth walk.

Re-run with `python -m pipeline.walkval`. It takes about 2.5 minutes and writes
`web/public/data/walk/findback.json`. Tests: `pytest tests/test_walkval.py`. The script reads the
Earth walks and Moon tiles fresh each time, so re-run it whenever the Earth stage rewrites
`walk/transects.*`. The figures below come from the run on 2026-11-14 (22,000 Earth transects).

## What the test does

- **300 Moon test walks.** Seeded, spread evenly over the 9 Moon tiles. Each is 1 to 4 km long;
  half are straight and half have one turn. Each walk is profiled exactly as the app does it: 100
  points of signed slope along the path, using `pipeline/metrics/profile.py`.
- **The hidden copy is damaged in three ways:**
  - **Height noise.** 2 m of random error is added to every 30 m elevation pixel. That is about
    Copernicus GLO-30's stated relative accuracy. Slope is then re-measured from the noisy heights.
  - **Length stretch.** A random half of the walk is stretched, so the copy is 5% longer and its
    hills sit slightly out of place.
  - **Direction.** Half of the copies are stored walked backwards.
- **Each copy is stored as Float32**, like a real row of `transects.bin`.

## Matchers compared

| Matcher | What it is | Top-1 | Top-5 | Median rank | ms / query* |
|---|---|---|---|---|---|
| `dtw_slope` | The browser's search: banded DTW (10%) on slope, both directions | 39% | 60% | 3 | 1,096 (22,000 rows) |
| `dtw_slope_znorm` | The browser's "Compare shape only" option | 13% | 21% | 114 | 981 |
| `euclid_slope` | Plain point-by-point difference on slope | 57% | 74% | 1 | 3.8 |
| **`euclid_height_slope`** | Point-by-point difference on relative height **and** slope | **77%** | **86%** | **1** | 8.1 |
| `dtw_app` | The browser's full pipeline: Walk.tsx prefilter, then DTW | 39% | 47% | 10 | 149 (~2,900 rows) |

\*Single-threaded numba on the build laptop, scanning every row in both directions. The browser
also drops rows early once they cannot reach its top 5, so its real DTW time is lower.

**Winner: `euclid_height_slope`.** For the summary panel: *"The matcher found a damaged, hidden
copy of the Moon walk first 77% of the time, and in its top 5 86% of the time. With 3-4 km walks
it was first 99% of the time."* The app's current method (DTW on slope) found it first 39% of the
time.

## Where it works and where it fails

- **Longer walks are much easier.** The winner was first in 47% of 1-2 km walks, 88% of 2-3 km
  walks and 99% of 3-4 km walks. DTW scored 17%, 35% and 67%.
  - On a short walk, 2 m of noise is a large share of the real slope signal. The profile samples
    every 10-40 m, so noise changes the measured slope a lot.
- **Height helps because it smooths out the noise.** Relative height is the running sum of slope,
  so random slope errors largely cancel, while the real shape of hills and dips survives.
- **DTW's flexibility works against it here.** Warping lets every Earth walk bend to fit the query,
  so unrelated walks score almost as well as the true twin. DTW only beats plain slope matching
  when the copy is stretched by 10% and noise is low (1 m: 82% vs 70%).
- **The "Compare shape only" option is the weakest.** Rescaling a nearly flat walk to unit spread
  magnifies its noise.
- **Regions differ.** The flat Slater Plain is the hardest (winner 61%). Peaks and massifs are the
  easiest (Cabeus B peak 94%, Malapert 88%).

## Robustness sweep (top-1)

| Noise | Stretch | DTW (app) | Euclid slope | Height + slope |
|---|---|---|---|---|
| 1 m | 0% | 85% | 94% | 97% |
| 1 m | 10% | 82% | 70% | 88% |
| 2 m | 5% | 39% | 57% | 77% |
| 2 m | 10% | 36% | 36% | 71% |
| 5 m | 0% | 1% | 9% | 34% |

The noise model is pessimistic. Each pixel gets its own independent error, which is harder on slope
than the smoother, spatially correlated errors a real DEM has.

## The app's prefilter misses reversed matches

The browser first narrows the search to walks of the nearest length class with a similar climb and
steepest slope. That prefilter compares the query's climb with the Earth walk's climb **in the
direction it was stored**. If the best match is the same walk walked backwards, its climb is the
stored walk's descent. The real twin is then thrown out before DTW ever sees it.

- In this test, the prefilter removed **61% of the reversed copies but only 6% of the forward
  ones**.
- That is most of the gap between `dtw_slope` (39% / 60%) and `dtw_app` (39% / 47% top-5).
- **Suggested fix in `web/src/screens/Walk.tsx`:** accept a row when either its climb or its
  descent fits the window. This needs a `descent_m` value per transect, or it can be computed from
  the row.

## Quality of the best real Earth match

These figures are for the clean Moon walks with the hidden copy removed, so they show how close the
best real Earth walk is.

| Setting | Median height difference (RMSE) | Median steepest-slope difference | Steepest slope within 5° |
|---|---|---|---|
| App pipeline (DTW) | 22 m (p90 60 m) | 1.8° | 87% |
| Winner, whole library | 13 m (p90 27 m) | 2.3° | 81% |

- `transects.bin` stores no heights, so Earth heights are rebuilt by adding up the slopes. On the
  Moon walks that rebuild is off by a median of 0.2 m, which is negligible.

## Is the app's DTW choice justified?

**Not by this test.**

- On the same rows, DTW on slope found the hidden copy first less often than a plain difference on
  slope (39% vs 57%).
- It is about 300 times slower.
- Adding relative height to a plain difference raises the hit rate to 77%, at about 8 ms for the
  whole library.
- DTW only helps when the twin is clearly stretched and the data is clean.

Recommended changes:

1. Switch to height + slope matching. A warping band of 2-3% could be added if stretch tolerance
   matters.
2. Fix the reversed-direction bug in the prefilter.

## Not done

- **Matrix profile (stumpy `aamp`).** With fixed 100-point walks, a full-window matrix profile is
  the same as the Euclidean matcher. Shorter windows match pieces of a walk rather than the whole
  walk, so stumpy was not added.
