# Pitch handover

Everything someone needs to run, present or edit the pitch on their own. The script is in [SCRIPT.md](SCRIPT.md). [STORYBOARD.md](STORYBOARD.md) is an early draft: the site no longer follows its beat table, but its sources and "don't say" rules still apply.

## What the pitch is

A 4-minute talk with a live demo in the middle:

| Part | Time | Who | What runs |
|---|---|---|---|
| Opening, beats 1–12 | 0:00–1:10 | Presenter | Pitch site (`pitch/`) |
| Live demo | 1:10–3:10 | Sanbir | Web app (`web/`) |
| Close, beats 13–17 | 3:10–3:57 | Presenter | Pitch site again |

The pitch site is one continuous 3D camera move: down to the Moon's south pole, the Athena photo, the $138M loss, the lander tally, the Artemis IV launch, the nine regions, then the turn to Earth (Kohler Coulee, Alberta). After the demo it shows the pipeline frame, the Kohler "Gotcha, this is Alberta" reveal, and the close.

## Run it

The pitch site is static files with no build step. It loads three.js and Lenis from public CDNs, so **the presenting laptop needs internet**.

```bash
cd pitch
python3 -m http.server 8000
```

Open `http://localhost:8000/?demo=<demo URL>`.

Start the demo web app in a second terminal:

```bash
cd web
npm install
npm run dev
```

**Set `?demo=` every time.** The "Live demo →" button at the hand-off opens that URL. Without it the button goes to `http://localhost:5174/`, but `npm run dev` normally starts on 5173. Use the deployed Vercel URL if there is one, for example `http://localhost:8000/?demo=https://<your-app>.vercel.app/summary`.

## Presenting

- **→, ↓, Space, Page Down or a click:** go to the next beat. A clicker that sends Page Down works.
- **←, ↑, Page Up:** go back one beat.
- Each move plays at a steady speed (1.4–6 s). Wait for it to stop before you click again.
- The mouse wheel also scrolls freely. Use the keys on stage so every stop lands on a caption.
- Wait for the "Acquiring signal" bar to finish before you start. It loads the Moon terrain and models.
- Rehearse once on the real laptop and projector. The site uses WebGL, and a weak GPU makes the camera stutter.

## Files

| File | What it holds |
|---|---|
| `index.html` | Page layout: overlays (photo, money, tally, launch, outro), HUD, credits footer |
| `app.js` | Beat timings, captions (`CAPS`), camera path, sun angle per beat, presenter keys |
| `launch.js` | Artemis IV launch inset |
| `earth_ground.js` | Earth ground at Kohler Coulee (NASA HLS image) |
| `style.css` | All styling |
| `assets/data/` | Moon terrain (Mons Mouton), Alberta tile `AB_073_027`, shadow images, `pipeline_frame.json` |
| `assets/img/outro/` | Kohler Coulee outro frames: Moon look, real colours, 24 pull-back frames |
| `assets/models/` | Moon, LRO, lander, astronaut and SLS models (NASA 3D Resources, NASA SVS) |

**To change a caption,** edit `CAPS` in `app.js`. `a` and `b` are where the caption appears and disappears within its beat (0 to 1). Then update the matching **On screen** line in `SCRIPT.md`.

## Numbers on screen and where they come from

| Claim | Value | Source |
|---|---|---|
| Landers since 2019 | 12 tried, 5 upright, 3 not upright, 4 crashed | `web/src/content.ts` `LANDING_ATTEMPTS` (missions that began powered descent) |
| Athena loss | $138M | Team estimate: 95% of NASA's $145M IM-2 total (≈12 of 240 planned hours worked) |
| Shadows vs NASA light map | r = 0.98 | `web/public/data/summary.json` `validation.shadow_vs_pgda.pearson_r` = 0.9794 (6 regions inside 85–90°S) |
| Best world shadow match, Mons Mouton Plateau | 154 km E of Taltal, Chile | `summary.json` ranking, site `R00100` |
| Alberta coverage | 3,082 windows, 129 bare enough | `web/public/data/alberta/alberta.json` `coverage` |
| Kohler Coulee vs Moon, shadowed directions at sun 1° | 78% vs 75% | `alberta.json` searches, `mons_mouton_plateau` / `shadow`, rank 1 (`AB_073_027`) |
| Kohler Coulee distance | ≈100 km south of Calgary (21 km SW of Nanton) | `alberta.json` site name and coordinates |
| No prior analog study found | 33 of 57 sites | Receipt file is **not in the repo** (see open items) |

## Open items before pitch day

1. **"33 of 57" has no receipt in the repo.** `SCRIPT.md` points to `experiments/results/novelty_check_webapp_2026-11-14.md`, which isn't committed. Commit it, or drop the number from beat 13.
2. **The $145M IM-2 figure has no link.** The footer cites SpacePolicyOnline. Add the exact URL to `SCRIPT.md`.
3. **Set the demo URL** (see Run it).
4. **Internet on stage.** If the venue Wi-Fi is unreliable, download three.js 0.169.0 and Lenis 1.1.13 into `pitch/vendor/` and point the import map in `index.html` and the Draco path in `app.js` at them.
5. **Q&A detail for r = 0.98:** it covers the 6 regions that lie inside NASA's 85–90°S light map, not all 9.

## Wording rules

- Say "no prior analog study found in the catalogs and literature we checked". Never say "first" or "never found before".
- Never say an Earth analog "would have saved" a mission. The claim is that the ground wasn't rehearsed, and Earth has ground like it.
- Name the limits: shape and light only, not gravity, vacuum or dust, and nobody has visited the sites yet.
