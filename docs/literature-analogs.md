# Documented lunar analog sites (agency-sourced catalog)

Data file: `data/literature_analogs.csv` (47 rows, LA001–LA047). Compiled 2026-11-14.

## 1. Method

**Scope (as narrowed mid-task).** This catalog uses only official space-agency and government sources: NASA (including JPL and NTRS), USGS, ESA, CSA (including Government of Canada news), JAXA/ISAS, ISRO, CNSA/CMSA (via CASC/Xinhua) and DLR. Peer-reviewed literature mining was dropped. We used a paper only when it is hosted by an agency (NTRS, the ISAS symposium PDF, or NASA SP-2015-626 via the Apollo Lunar Surface Journal). Wikipedia and Wikidata supply coordinates only. We did not mine the Europlanet site list (out of time; most of its sites are Mars analogs).

**Sources searched:**
- NASA:
  - Apollo geology training: Phinney's appendices, via the ALSJ at `apollojournals.org/alsj/ap-geotrips.pdf`; a dated, crew-level list of every field trip from 1964 to 1972.
  - JETT3 (2022) and JETT5 (2024) Artemis field tests.
  - D-RATS 2022 Quicklook (NTRS).
  - FINESSE (SSERVI).
  - Artemis II geology training in Iceland and Labrador.
  - The 2025 astronaut-candidate class field training (2026).
  - Mars 2020 Lander Vision System test (JPL).
  - ATHLETE at Moses Lake (NTRS).
  - Ames, Marshall and Glenn lunar test facilities.
  - NASA Analog Missions page.
- USGS: the Terrestrial Analogs page and the Apollo field guide record.
- ESA: PANGAEA and PANGAEA-X; Lofoten image release; LEAD (with CSA).
- CSA: the Iceland/Kamestastin article, the LEAD page, the Analogue Terrain page, and the 2012 Mauna Kea release.
- DLR: ARCHES 2022, ROBEX 2017, LUNA facility.
- JAXA/ISAS: 2011 Izu-Oshima rover test.
- ISRO: the Making of Chandrayaan-3 page; the HOPE (Ladakh) page, which was reviewed and excluded.
- CASC/Xinhua: Lanyue test at Huailai.

**Inclusion criteria:**
- An agency source states that the site was used for lunar (or Moon-and-Mars) astronaut training, rover or sensor testing, ISRU, lunar geology science, or lunar lighting simulation.
- Mars-only analogs were excluded: ISRO HOPE/Tso Kar (ISRO describes it as an early-Mars analog), Atacama, CHAPEA, and others.
- Indoor sites are included only as `facility` rows, with no coordinates.
- Non-agency facilities were excluded: the Tottori dunes field is run by the prefecture, and the Hangzhou lunar test field is run by a startup.

**Coordinates.** Wikipedia GeoData or Wikidata P625 only, with the URL in `coord_source_url`. We invented no coordinates. Cinder Lake, Black Point Lava Flow, the Black Mesa crater field and the LEAD quarry are left blank because no citable coordinate exists. `approx` marks a centroid of a large area (an island, a park, a county or a volcano) where the exact test spot is not published.

**`verified` flag.**
- `yes`: we opened the cited source and it states the use.
- `partial`: either the use is confirmed but a key detail (rock type, exact site, or terrain features) comes from a secondary or unopened source, or the agency page is non-specific.

`hazards_plausible` is our own judgement. No source claims it, and none of it should be presented as a NASA statement.

**Untrusted content seen.** Two search results (the mirror pages `cavac.at/cavacopedia/ESA PANGAEA` and `wikipedia.com/wiki/ESA_PANGAEA`) contained embedded instructions unrelated to the topic: requests for steak and gumbo recipes. We ignored them and did not use either page as a source.

## 2. Top 15 sites for south-pole landing and walking hazards

| # | id | Site | Why it matters (hazard) |
|---|----|------|-------------------------|
| 1 | LA003 | S P Crater, AZ (JETT3 2022) | The only outdoor NASA test whose *primary* goal was south-pole lighting. Moonwalks ran at night under artificial low-angle light. (shadow, rim) |
| 2 | LA004 | San Francisco Volcanic Field, AZ (JETT5 2024) | Artemis III rehearsal. The night EVA used a spotlight to "imitate the lighting conditions of the Moon's south polar region." (shadow, walk) |
| 3 | LA030 | Haughton crater, Devon Is. | NASA called it "geographically similar to Shackleton Crater." At 75°N the sun stays low. K10 rover surveys ran in 2007. (shadow, rim) |
| 4 | LA005 | Black Point Lava Flow, AZ (D-RATS 2022, NASA+JAXA) | Pressurized-rover operations on rough lava. The report names "low-angle, natural lighting at lunar poles" as a driver. No coordinates. (walk, shadow) |
| 5 | LA002 | Cinder Lake Crater Field, AZ | A blasted replica of Apollo landing sites: dense small craters in uniform dark cinder. No coordinates. (rim, texture) |
| 6 | LA001 | Meteor Crater, AZ | Fresh simple crater with an overturned rim; Apollo training site. (rim, walk) |
| 7 | LA010 | Kilbourne Hole, NM | Steep-walled maar used by six Apollo crews and by NASA's 2023 Artemis team. (rim, walk) |
| 8 | LA035 | Vatnajökull NP north, Iceland (Artemis II 2024) | CSA: chosen for "icy soils resembling those anticipated on the Moon's south pole." (walk, texture, shadow) |
| 9 | LA038 | Lofoten, Norway (ESA PANGAEA) | Anorthosite, the lunar-highland rock, at 68°N. (shadow, walk) |
| 10 | LA028 | Mistastin/Kamestastin, Labrador | Artemis II crew impact-geology training in 2023. (walk, rim) |
| 11 | LA020 | Death Valley, CA (Mars 2020 LVS 2019) | Agency flight test of vision-based terrain-relative navigation over barren terrain. (texture) |
| 12 | LA040 | Mount Etna (DLR ROBEX 2017, ARCHES 2022) | Autonomous lander, rover and drone operations on Moon-like granular volcanic ground. (walk, texture) |
| 13 | LA016 | Ubehebe Crater, CA | Steep maar in a dark tephra blanket; Apollo 15 training. (rim, walk, texture) |
| 14 | LA015 | Nevada National Security Site | Explosion craters used as impact proxies, from Apollo through the 2023 Artemis team. (rim, texture) |
| 15 | LA034 | Askja, Iceland | Apollo: "Probably the most moon-like of the field areas." (walk, texture) |

Indoor shadow references, not mappable: LUNA in Cologne (LA041), Ames Lunar Lab (LA045), and the MSFC Flat Floor Facility (LA046).

## 3. Pitch-ready facts (each cited)

1. **NASA rehearses south-pole lighting at night in Arizona.** JETT3 (Oct 4–9, 2022, near S P Crater) had a "primary focus… to help NASA gain an understanding of the requirements for the unique lighting conditions at the lunar South Pole," with all moonwalks at night. [NASA, 2022](https://www.nasa.gov/humans-in-space/nasa-to-practice-artemis-moonwalking-roving-operations-in-arizona-desert)
2. **Helmet lights alone showed only the ground at the crew's feet.** During the JETT5 night moonwalk (May 16, 2024), a spotlight imitated south-polar lighting. With helmet lights only, the crew "could see just the area around their feet." [NASA Science, 2024](https://science.nasa.gov/missions/artemis/behind-the-scenes-of-a-nasa-moonwalk-in-the-arizona-desert)
3. **Haughton crater was compared to Shackleton.** NASA said Haughton "is geographically similar to Shackleton Crater at the South Pole of the moon." [NASA via Phys.org, 2007](https://phys.org/news104156323.html)
4. **Iceland was picked for south-pole-like soils.** CSA says Iceland "was specifically chosen for its icy soils resembling those anticipated on the Moon's south pole." [CSA, 2024](https://www.asc-csa.gc.ca/eng/news/articles/2024/2024-08-22-artemis-ii-crew-refines-lunar-geology-skills-in-iceland.asp)
5. **Apollo rated Iceland the most Moon-like site.** Phinney's training history calls Iceland "Probably the most moon-like of the field areas." [NASA SP-2015-626 appendix via ALSJ](https://www.apollojournals.org/alsj/ap-geotrips.pdf)
6. **Shadows are a lander-inspection problem.** At Marshall's Flat Floor Facility, 12 kW and 6 kW lights recreate low-angle, high-contrast lighting "to understand how shadows will affect lander visual inspection." [NASA, 2025](https://www.nasa.gov/directorates/esdmd/artemis-campaign-development-division/human-landing-system-program/nasa-engineers-simulate-lunar-lighting-for-artemis-iii-moon-landing)
7. **Even small features cast long shadows.** NASA Ames: "Because the Sun will never rise overhead, even the smallest rock or crater will cast long shadows." [NASA Ames](https://www.nasa.gov/centers-and-facilities/ames/the-lunar-lab-and-regolith-testbeds/)
8. **Europe built a hall for polar shadows.** LUNA's solar simulator is "suitable for recreating the long, sharp, dark shadows cast in the polar regions of the Moon." [DLR, 2024](https://www.dlr.de/en/latest/news/2024/training-facility-for-astronautical-and-robotic-missions-to-the-moon)
9. **Low lunar sun is a recognized Artemis rover challenge.** The D-RATS 2022 report lists "Low-angle, natural lighting at lunar poles." [NTRS 20230007175](https://ntrs.nasa.gov/citations/20230007175)
10. **Lofoten anorthosite matches the lunar highlands.** ESA: Lofoten holds "some of the best-preserved samples on Earth of a rock abundant in the lunar highlands." [ESA, 2023](https://esa.int/ESA_Multimedia/Images/2023/07/The_Moon_in_a_fjord)
11. **The scale of the 2023 Artemis training effort.** NASA's Artemis geology team trained 89 students in 2023, at 4 field sites in northern Arizona, Kilbourne Hole, the Nevada National Security Site, and Kamestastin. [Evans et al., LPSC 2024, NTRS](https://ntrs.nasa.gov/api/citations/20230018695/downloads/LPSC2024_Evans_draft2.pdf)
12. **USGS built a replica Moon landing site.** The first Cinder Lake field "was designed to simulate the Sea of Tranquility." [NASA Science, 2019](https://science.nasa.gov/?p=908790)

## 4. Gaps

- **Documented analogs for low sun and polar illumination are almost all artificial.** They are night tests with spotlights (JETT3, JETT5) or indoor halls (LUNA, Ames, MSFC). We found no agency source naming an outdoor site where *natural* low sun was the reason it was chosen. Haughton, Iceland and Lofoten are high-latitude, but agencies chose them for geology. Haughton's Shackleton comparison is about terrain shape, not lighting. This is the gap our project fills.
- **The record leans heavily toward NASA and Apollo.** NASA appears on 37 of 47 rows. JAXA (2), ISRO (1) and CNSA (1) have few public, site-specific documents. The ISRO and CNSA rows rely partly on news for the terrain details.
- **Some key sites lack coordinates.** Cinder Lake (LA002), Black Point (LA005), Black Mesa (LA009) and the LEAD quarry (LA032) have no citable coordinate. Ten rows are `approx` centroids, so they cannot be used for pixel-level validation.
- **Hazard columns are inferred.** Agencies describe *uses*, not rim, texture or slope metrics.
- **No agency-documented Antarctic site for lunar terrain or illumination** turned up. Antarctic programs are framed around isolation.
- **Many old nasa.gov analog pages now return 404:** D-RATS, HMP, ISRU archive, ALSJ on nasa.gov. Citations use mirrors (ALSJ on apollojournals.org, the UNT web archive, NTRS).

## 5. Proposed hold-out and seed split

**Rules:**
- Keep each geographic cluster on one side, so seeds cannot leak into validation through near-identical terrain. For example, S P Crater lies inside the San Francisco Volcanic Field, and Ubehebe lies inside Death Valley.
- Keep consistent with `data/earth_sites_clean.csv`. It already marks Meteor, Sunset/Cinder Lake, Kilbourne Hole, Death Valley, Craters of the Moon, Kīlauea, Sudbury, Mistastin, Haughton, Pinacate and Askja as `heldout_positive`, so those stay held out.
- Balance agencies and uses where the sparse data allows.

**HOLD OUT: validation answer key.** Never use these as seeds or for tuning.

- 20 sites with coordinates: LA001, LA003, LA004, LA006, LA007, LA008, LA010, LA016, LA020, LA021, LA024, LA025, LA027, LA028, LA030, LA033, LA034, LA035, LA040, LA043.
- 3 sites in held-out clusters without coordinates (the Flagstaff cluster): LA002, LA005, LA009.

Coverage: NASA, USGS, CSA, ESA and DLR (Etna), ISRO (Challakere), and JAXA (via LA005). Uses include astronaut training, illumination (LA003, LA004), sensor/landing tests (LA020, LA043), ISRU (LA025) and rover tests (LA005, LA030, LA040).

**SEED: may be used to seed or tune the search.** 18 rows: LA011, LA012, LA013, LA014, LA015, LA017, LA018, LA019, LA022, LA023, LA026, LA029, LA036, LA037, LA038, LA039, LA042, LA044.

Coverage: NASA, USGS, ESA (Ries, Lanzarote, Lofoten, Bletterbach), JAXA (Izu-Oshima), CNSA (Huailai). It includes the anorthosite sites (San Gabriel, Stillwater, Lofoten), a polar/low-sun example (Lofoten, 68°N), maars and craters (Zuni, Hole-in-the-Ground, Sierra Madera, NNSS) and texture sites (Moses Lake dunes).

**Reference only:** indoor or unlocated facilities, used to design the shadow features and not scored. LA031, LA032, LA041, LA045, LA046, LA047.

**Caveats:**
- Both outdoor illumination tests (LA003, LA004) sit in the held-out Flagstaff cluster. The seed set therefore has no lighting-test site, so lighting-feature design should draw on the facility rows and on physics, not on seeds.
- LA019, LA023 and LA037 already appear as `listed_candidate` in `earth_sites_clean.csv`. If used as seeds, do not also count them as validation hits.
