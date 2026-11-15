# Pitch website: storyboard (draft 1, 2026-11-14)

This is a plan only. Nothing is built yet.

**Rules for the site**
- It is one landing. The camera never cuts.
- Each click or scroll stop shows **10 words or fewer**. HUD numbers (altimeter, sun angle) don't count.
- Moon focus. Every on-screen claim has a receipt in the table below.
- Never say an analog "would have saved" a mission. The claim is only that the ground was not rehearsed, and Earth has ground like it.

## 1. Which failures count

A failure counts only if the **ground or the environment** surprised the mission: something you could rehearse on Earth terrain.

| Mission | Year | What the ground did | Use? | Receipt |
|---|---|---|---|---|
| IM-2 Athena (Moon, Mons Mouton) | 2025 | Low sun and long shadows. Craters looked different than in the reference imagery. Rugged terrain. Landed on its side in a crater, 250 m off target. | **Yes, lead** | Company's own account, May 2025: [The Register](https://www.theregister.com/2025/05/14/intuitive_machines_postmortem/), [Space.com](https://www.space.com/astronomy/moon/heres-why-the-private-athena-lunar-lander-toppled-over-on-the-moon). Altimeter noise also contributed (not terrain). |
| Ingenuity, flight 72 (Mars) | 2024 | Smooth, featureless sand gave its camera nothing to track. | **Yes** | [NASA JPL, 11 Dec 2024](https://www.jpl.nasa.gov/news/nasa-performs-first-aircraft-accident-investigation-on-another-world/) |
| Hakuto-R Mission 1 (Moon) | 2023 | Crossed a 3 km crater-rim cliff. The software rejected the jump as a sensor fault. Its simulations "did not adequately incorporate the lunar environment on the navigation route". | **Yes** | [ispace, 26 May 2023](https://www.ispace-inc.com/2023/05/26/ispace-announces-results-of-the-hakuto-r-mission-1-lunar-landing/) |
| IM-1 Odysseus (Moon) | 2024 | Came down fast and sideways on higher, uneven terrain, broke a leg and tipped. Main cause was a laser-rangefinder safety switch left on. | Footnote only | Press reports, no primary report found |
| InSight "mole" (Mars) | 2019–21 | Soil clumped and resisted. The probe could not dig. | Maybe (base building, not landing) | [NASA JPL, Jan 2021](https://www.jpl.nasa.gov/news/nasa-insights-mole-ends-its-journey-on-mars/) |

**Dropped (not about terrain):** Resilience / Hakuto-R Mission 2 (laser rangefinder hardware, 2025), Luna-25 (engine burn), Beresheet (gyro and engine), Chandrayaan-2's Vikram (guidance), SLIM (engine nozzle), Peregrine (fuel leak).

## 2. The Hakuto-R line: is it an overpromise?

- **True:** it thought it had landed while about 5 km up. ispace says so.
- **True:** ispace says its simulations did not properly include the terrain on the route.
- **Not true / don't say:** "our analog would have prevented it." Its root cause was software logic. A field test might have caught it, but nobody can show that.
- **Safe wording:** "Its tests never flew over that cliff." Then: "Earth has cliffs like it." That is a claim about terrain, which we can back with our rim-jump numbers.
- **Supporting receipt (precedent, not our claim):** NASA flew Mars 2020's landing-vision system on a helicopter over Death Valley in 2019 to test it on real terrain. [NASA JPL, 24 May 2019](https://www.jpl.nasa.gov/news/nasas-mars-2020-mission-drops-in-on-death-valley/)

## 3. The beats (one continuous descent)

| # | On screen (≤10 words) | What the camera does | Receipt |
|---|---|---|---|
| 1 | *Altitude: 0 m. Touchdown confirmed.* | Black screen. HUD altimeter counts down. | ispace 2023 |
| 2 | It was still 5 km up. | Camera drops; the ground is far below. | ispace 2023 |
| 3 | Hakuto-R, 2023. Its tests never flew that cliff. | Fly over a real rim on LOLA terrain; altimeter trace spikes. | ispace 2023 |
| 4 | Athena, 2025. Low sun. Long shadows. Landed sideways. | Scroll lowers the sun; shadow images flood the ground. | IM, May 2025 |
| 5 | Ingenuity, 2024. Ground too smooth to see. | Camera features dot the ground, then vanish. | NASA JPL 2024 |
| 6 | Every time, the ground wasn't rehearsed. | Pull back to the south pole. | The three above |
| 7 | Artemis lands here next. Nine regions. Same dangers. | The 9 NASA regions light up with danger profiles. | NASA, Oct 2024 release; Sanbir's danger metrics |
| 8 | You can't rehearse on the Moon. | Hold on the grey Moon. | (none needed) |
| 9 | You can rehearse on Earth. | One slope line stays; the Moon turns into Alberta beneath it. | (none needed) |
| 10 | We scanned all of Alberta. | 3,082 windows tile the province. | `alberta.json`: n_windows 3082 |
| 11 | Trees, crops, water and towns removed. | Windows drop out in labelled waves. | Fail counts: tree 2,449, crop 794, water 84, … |
| 12 | 129 left. | The survivors glow. | n_pass 129 (4.2% of area) |
| 13 | Kohler Coulee: Alberta's closest match to Slater Plain. | Zoom province → valley → ground. | best_per_hazard: AB_073_027, rim and texture |
| 14 | Draw a Moon walk. Walk it near Calgary. | A Moon route's slope line becomes a Calgary trail. | Sanbir's walk matching (DTW) |
| 15 | Our shadows match NASA's light map: r = 0.98. | Number counts up over the two maps side by side. | summary.json shadow_vs_pgda r 0.979 |
| 16 | Not the Moon: gravity, vacuum, sunsets lasting days. | Honest limits, quiet beat. | Challenge text names these limits |
| 17 | Rehearse here. Land there. | Pull back to Earth seen from the south pole. | (none) |

## 4. Numbers to keep off screen (for now)
- **Known analogs vs decoys, AUC 0.80:** only 13 known sites vs 9 decoys. Too small to headline.
- **Weight stability, Jaccard 0.91:** true but needs explaining. Keep it for Q&A.
- **Global best matches:** stronger than Alberta's (for example, rim 0.007 vs 0.199), but beat 13 is about Alberta. Decide whether the story is Alberta-only or global first.

## 5. Hook images: "Do you know what this is?"

Real photos of the wrecks exist for all three cases. The idea: show the photo with no caption, ask the room, then reveal.

| Photo | What you see | Owner / use | Link |
|---|---|---|---|
| Hakuto-R crash site, LRO before/after (taken 26 Apr 2023) | A grey patch; the "after" frame has four white specks: the wreck. Looks like nothing until you're told. Best "what is this?" image. | NASA/GSFC/ASU. NASA imagery, free to use with credit. | [Space.com](https://space.com/japan-hakuto-r-moon-lander-crash-site-found), [SpacePolicyOnline](https://spacepolicyonline.com/news/nasas-lro-images-hakuto-r-lunar-crash-site/) |
| Athena on its side in a crater (Mar 2025) | Lander lying in shadow, two legs pointing up into sunlight. The most dramatic one. | Intuitive Machines' photo. Company image, so check terms or credit them; not NASA public domain. | [PetaPixel](https://petapixel.com/2025/03/10/photo-shows-stricken-athena-moon-lander-lying-on-its-side), [Astronomy](https://www.astronomy.com/space-exploration/intuitive-machines-im-2-moon-lander-is-lying-dead-in-a-crater/) |
| Ingenuity alone on a dune, blade missing (Feb 2024) | Helicopter on a dune; a SuperCam close-up shows a rotor blade lying about 15 m away. | NASA/JPL-Caltech (Mastcam-Z: also ASU; SuperCam: also LANL/CNES). Free to use with credit. | [NASA Photojournal PIA26238](https://photojournal.jpl.nasa.gov/catalog/PIA26238), [JPL PIA26236](https://www.jpl.nasa.gov/images/pia26236-perseverance-spots-ingenuity-at-its-final-airfield/) |
| Odysseus, LRO view and its own descent photo (Feb 2024) | Footnote case only. | NASA (LRO) / Intuitive Machines (lander camera). | [NASA](https://www.nasa.gov/missions/lro/nasas-lro-images-intuitive-machines-odysseus-lander/) |

**How it plays (still 10 words or fewer):**
- Photo full screen: "Do you know what this is?"
- Click: "A lander. Hakuto-R, 2023." The camera zooms out from the specks to the cliff it crossed.
- Repeat for Athena and Ingenuity, faster each time.

**Direct image files (opened and checked 2026-11-14):**
- Athena on its side, Earth in the sky: https://petapixel.com/assets/uploads/2025/03/Lander-on-the-moon-1536x806.jpg (portrait version: `.../im-2-lander-on-moon-601x800.jpg`)
- Ingenuity mosaic, helicopter at right and its lost blade as a speck at left, 7371×2284: https://assets.science.nasa.gov/content/dam/science/psd/photojournal/pia/pia26/pia26238/PIA26238.jpg
- Hakuto-R before/after animation, debris marked A–D: https://spacepolicyonline.com/wp-content/uploads/2023/05/haukto-impact-768x768.gif (original from NASA/GSFC/ASU; get the LROC original before using)

**User verdict:** the wreck photos above are not readable to an audience. Replaced as the hook by the three below.

**Clearer hook images (checked 2026-11-14):**
1. **Curiosity's torn wheel** (Mars, NASA raw MAHLI image, sol 4844, about March 2026): holes and torn treads from sharp rocks. Anyone can read it instantly. NASA/JPL-Caltech/MSSS. Seen via [PetaPixel, Mar 2026](https://petapixel.com/2026/03/25/theres-an-even-larger-hole-in-the-wheel-of-nasas-mars-curiosity-rover/); get the original from NASA's raw-image site. NASA's account: sharp rock tore the wheels and drivers now route around rocky ground ([NASA/JPL PIA21486](https://www.jpl.nasa.gov/images/pia21486-break-in-raised-tread-on-curiosity-wheel/)).
2. **Spirit's twin in a sandbox on Earth** (JPL, June 2009, [PIA12101](https://www.jpl.nasa.gov/images/pia12101-test-rover-sinks-into-prepared-soil/)): Spirit got stuck in soft soil on Mars, so NASA buried a test rover in a matching soil mix on a 10° slope to practise the escape. This *is* the analog argument in one photo. Pairs with: "Stuck on Mars? Rebuild the ground on Earth."
3. **Cernan covered in Moon dust** (Apollo 17, 1972, NASA, via [Planetary Society](https://www.planetary.org/space-images/gene-cernan-after-moonwalk)): the Moon base problem. Cernan's debrief called dust "one of our greatest inhibitors" to operations on the Moon.

Rejected: Spirit's own photo of its belly in the sand (unreadable).

Unconfirmed: I remember an Ingenuity photo of its own shadow showing a damaged blade. Not found in this search.

## 6. Still to verify before building
- How many lunar landing attempts since 2019 failed for terrain reasons, if we want a count at all. Right now we show three named cases, not a statistic.
- Whether NASA's Artemis astronaut field tests (walking, sampling) used Earth analog sites. If so, cite it at beat 14. Not yet checked.
- That Sanbir's `summary.json` and `alberta.json` are the final pipeline output, not a snapshot that will change.
