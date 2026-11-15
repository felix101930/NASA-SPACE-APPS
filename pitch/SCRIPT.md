# Pitch script (4:00)

Pace: about 150 words a minute. Pitch parts are about 2:00 in total, and the live demo is about 2:00.
Each section is one click. The time is when the click happens. **On screen** is the caption the audience sees.

---

### 1 · 0:00 · Name flash during descent
**On screen:** TEAM KINETIC

> Hello everyone, we are Team Kinetic, from Calgary. Watch the ground.

### 2 · 0:05 · Moon south pole
**On screen:** March 2025. The Moon's south pole.

> March 2025. A NASA-funded lander is coming down near the Moon's south pole.

### 3 · 0:10 · Photo
**On screen:** Recognize this? → Those are its feet.

> Recognize this?
> *(pause, one beat)*
> Those are its feet.

### 4 · 0:16 · Athena on its side
**On screen:** Athena. NASA-funded. Landed on its side.

> This is Athena. It landed on its side in a crater. It worked for about twelve hours, out of ten planned days.

### 5 · 0:23 · Low sun
**On screen:** Low sun. Long shadows. → Craters didn't look like its reference maps.

> Why? The company's own review says the sun sits very low at the south pole, and the long shadows challenged its landing system. And from low altitude, the craters didn't look like the orbiter images it was built on.

### 6 · 0:37 · Money
**On screen:** $138 million. Lost when Athena tipped over.

> By our estimate, that's about 138 million dollars of NASA's money, lost.

### 7 · 0:42 · Landing record
**On screen:** Since 2019, 12 landers tried. Only 5 stayed upright.

> And it's not just Athena. Since 2019, twelve landers have tried. Only five stayed upright.

### 8 · 0:48 · People next
**On screen:** Next landing has people on board.

> The next landing near the south pole, Artemis Four, has people on board.
> *(let the launch play)*

### 9 · 0:56 · Regions
**On screen:** Nine candidate regions. Athena fell in one.

> NASA has nine candidate regions for that landing. Athena fell in one of them.

### 10 · 1:01 · The problem
**On screen:** You can't rehearse on the Moon.

> And you can't rehearse on the Moon.

### 11 · 1:05 · Earth
**On screen:** So we found where you can.

> So we found where you can. Here, on Earth.

### 12 · 1:08 · Hand-off
**On screen:** Let us show you.

> Let us show you. Sanbir?

---

## Live demo · 1:10 to 3:10 (Sanbir, about 2:00)

Speak in plain words. Say "no prior analog study found in the catalogs and literature we checked", never "first" or "never found before".

- **Moon danger profiles (about 20 s).** Nine regions, each scored on three dangers: low-sun shadows, crater-rim height jumps, and surface texture for camera navigation. Point at Mons Mouton Plateau, where Athena came down.
- **Click Mons Mouton Plateau → Earth matches (about 25 s).** The top 3 Earth sites for each danger, all at least 50 km from any catalogued analog. The best shadow match in the world is 154 km east of Taltal, Chile. Show one green/amber light, Moon number vs Earth number.
- **3D side by side (about 20 s).** The same sun angle on both terrains. Lower the sun toward 1°, and the shadows grow on both.
- **Astronaut walk (about 15 s).** A walk route on the Moon, matched by its up-and-down profile to a trail on Earth.
- **Alberta & Calgary (about 20 s).** We tiled the whole province: 3,082 windows. 129 are bare enough. Kohler Coulee, near Nanton, is Alberta's best shadow match for Mons Mouton Plateau.
- **Be honest on one weak spot (about 5 s).** For this region, crater-rim jumps are only a partial match. The app says so.
- **End on Summary (about 15 s).** All nine regions ranked by how well Earth can rehearse them, with the weakest danger named for each. Stop here and hand back.

---

### 13 · 3:10 · Pipeline frame
**On screen:** Pipeline frame (`assets/data/pipeline_frame.json`)

> NASA's LOLA terrain for the Moon, bare 30-metre terrain for Earth. We cast shadows at low sun and compare. Our Moon shadows match NASA's own light map at 0.98. For 33 of our 57 sites, no prior analog study found in the catalogs and literature we checked. The gaps: it's shape and light, not gravity or dust, and we haven't visited yet.

### 14 · 3:32 · Kohler as the Moon
**On screen:** Next time, we land safely.

> Next time, we land safely.

### 15 · 3:35 · Reveal
**On screen:** Gotcha. This is Alberta.

> Gotcha. This is Alberta. Same hills, real colours.

### 16 · 3:40 · Pull back
**On screen:** Kohler Coulee · 100 km south of Calgary

> Kohler Coulee, 100 kilometres south of Calgary. It's not the world's best match; that one is in Chile. But it's Alberta's best, and it's close: with the sun one degree up, 78 percent of directions are shadowed here, and 75 on the Moon.

### 17 · 3:53 · Map
**On screen:** Rehearse here. Land there.

> Rehearse here. Land there. Thank you.

*(end about 3:57)*

---

## Receipts for spoken numbers

| Claim | Source in repo |
|---|---|
| Lander on its side; worked about 12 of 240 planned hours | `pitch/index.html` money source line |
| Low sun, long shadows, craters vs reference imagery | Intuitive Machines post-mission review, May 2025 (`STORYBOARD.md`, The Register / Space.com links) |
| $138M | Team estimate: 95% of NASA's $145M IM-2 award (`pitch/index.html`, `pitch/app.js`). There is no link for the $145M in the repo. |
| 12 tried, 5 upright (plus 4 crashed, 3 not upright) | `web/src/content.ts` LANDING_ATTEMPTS |
| Nine regions; Athena inside Mons Mouton Plateau | NASA, Oct 2024; LROC position (`pitch/app.js`) |
| r = 0.98 shadows vs NASA light map | `web/public/data/summary.json` validation.shadow_vs_pgda.pearson_r 0.9794 |
| 80% known vs decoy (13 vs 9) | summary.json known_vs_decoy_auc 0.795 (0.737 at 30 m, 33 known) |
| 88% overlap under ±20% weights | summary.json weight_stability_jaccard 0.8813 |
| 33 of 57 sites | `experiments/results/novelty_check_webapp_2026-11-14.md` (9 established, 8 within 50–100 km, 7 in studied regions, 33) |
| 154 km E of Taltal is world best shadow match for Mons Mouton Plateau | summary.json ranking (R00100, distance 0.151) and `impact.json` |
| Kohler Coulee 78/47/26% vs Moon 75/54/33% at sun 1/3/5° | `web/public/data/alberta/alberta.json` searches, mons_mouton_plateau shadow, rank 1 |
| 3,082 windows, 129 pass | alberta.json coverage |
