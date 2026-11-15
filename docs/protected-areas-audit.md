# Protected-areas audit of the Earth analog spots (earlier site list)

> **Note: this audit covers an earlier site list, not the sites the website shows.** It was made from an earlier pipeline run (`results/job2_test_sites.csv`: 15 spots such as Galápagos, Northern Hoggar and Aksai Chin). The website's current 57 analog sites (from `web/public/data/matches.json`) are different, so the counts below (for example "14 of 27 picks") do not describe them. For the current sites, the protected-area check is `pipeline/match/analog_tags.py` → `web/public/data/analog_tags.json`, shown on the Summary page (15 of 57 with their centre inside a protected area). This file is kept for its access notes (permits, restricted zones, gaps in protected-area data) and its method.

Date: 2026-11-15. Covers the 27 top-3 picks in `results/job2_test_sites.csv` (15 unique spots; the Job 4 base list is the same). Per-spot table: `results/protected_areas_audit.csv`.

## Method
- **Source:** World Database on Protected Areas (WDPA), UNEP-WCMC polygon layer, queried through its public map service (`data-gis.unep-wcmc.org`, ProtectedSites / The_World_Database_of_Protected_Areas, layer 1).
- **Test:** any WDPA polygon within 7.5 km of the spot centre, which roughly matches the 15 km site core. For Galápagos the exact centre point was also tested.
- **Desk research** for each spot where WDPA has gaps (OECMs, China) and for access rules.

## Result

| Status | Spots | Top-3 picks affected |
|---|---|---|
| **Protected (WDPA)** | Galápagos (Sierra Negra), Cumberland Peninsula (Auyuittuq NP), Cerro Bravo ×2 (San Guillermo) | 7 |
| **Likely protected (OECM)** | Northern Hoggar (Ahaggar) | 7 |
| **Not verifiable (China / disputed)** | Tarim foothills, Aksai Chin ×2, Guozha Co | 5 |
| **Clear, permits needed** | Ellesmere ×2, Axel Heiberg ×2 (Nunavut), Dolpa (restricted area) | 7 |
| **Clear** | Patagonia NE of Lago San Martín | 1 |

**14 of 27 picks (52%) are in or within 7.5 km of a protected area.** That includes the #1 pick for 5 of the 9 Moon regions: Malapert Massif and Peak Near Cabeus B (Galápagos), Nobile Rim 1 and Slater Plain (Hoggar), and de Gerlache Rim 2 (Auyuittuq).

The #1 picks with no protected-area or access problem are **Haworth** (Patagonia, likely private estancia land) and **Nobile Rim 2** (Axel Heiberg, permits only).

## Spot notes
- **Galápagos, Sierra Negra north flank** (IUCN II National Park, World Heritage Site, Biosphere Reserve). The centre point is inside the park. Field tests need a Galápagos National Park Directorate permit and must follow strict biosecurity rules.
- **Cumberland Peninsula** (Auyuittuq National Park, IUCN II). Within 7.5 km; we didn't confirm whether the centre point is inside. Needs a Parks Canada permit and a Nunavut Research Institute licence.
- **Cerro Bravo, San Juan** (San Guillermo Provincial Park, IUCN II, plus the biosphere reserve buffer zone). Both windows are within 7.5 km. Needs a San Juan provincial permit.
- **Northern Hoggar.** No WDPA polygon, but Protected Planet lists the Ahaggar as an OECM ([record 23177](https://protectedplanet.net/23177), 633,887 km²). The park's protected zone includes the Tefedest and its peripheral belt, and the spot is about 35 km from the Tefedest. Foreign visitors normally need an authorized agency, a permit and an escort. This spot is in the top 3 for 7 of 9 regions, so its status matters most.
- **China and the disputed spots** (Tarim, Aksai Chin, Guozha Co). WDPA has no records here, but China reports few protected areas to WDPA, so this doesn't prove the land is unprotected. The Altun Shan reserve (southern Qiemo County) and the Chang Tang reserve (parts of Rutog County) are nearby. Access is restricted or closed whatever the protection status.
- **Nunavut spots** (Ellesmere, Axel Heiberg). No protected area today; a protected area for Axel Heiberg has been proposed. Needs a Nunavut Research Institute licence, Qikiqtani Inuit Association approval on Inuit Owned Land, and charter flights.
- **Dolpa.** Outside Shey Phoksundo National Park and its buffer zone. Needs an Upper Dolpo restricted-area permit; the spot is on the border at about 5,500 m.

## Limits
- Only the WDPA polygon layer was checked. WDPA point-only records and the separate OECM database were not queried, and the Hoggar status comes from desk research, not a geometry test.
- For Auyuittuq and San Guillermo we checked overlap within 7.5 km, not whether the centre point is inside.
- WDPA coverage is weak for China and for indigenous or community lands. Inuit Owned Land parcels in Nunavut were not checked.
- This is not legal advice. Check with each authority before any visit.

## Implication for the pitch
Half the picks are on protected land. That's plausibly a side effect of the method: untouched bare ground looks most like the Moon. Recommended next steps:
1. Show an access badge on each match card (protected / restricted / permits / clear).
2. Optionally add a "field-ready" ranking that skips IUCN I–II areas and closed zones, and report how much the match quality drops.

Sources: [WDPA / Protected Planet](https://www.protectedplanet.net/), [Ahaggar record](https://protectedplanet.net/23177), [UNESCO tentative list: Tefedest](https://whc.unesco.org/en/tentativelists/6834/), [Auyuittuq draft management plan 2026](https://parks.canada.ca/pn-np/nu/auyuittuq/info/plan/ebauche-plan-draft-plan-2026), [Shey Phoksundo NP](https://sheyphoksundo.dnpwc.gov.np/en/introduction), [Axel Heiberg protection proposal](https://nunatsiaq.com/stories/article/arctic-scientist-wants-to-use-award-money-for-new-protected-area/), [Altun Shan reserve](https://en.wikipedia.org/wiki/Altun_Shan_National_Nature_Reserve), [Chang Tang reserve](https://en.wikipedia.org/wiki/Chang_Tang_Nature_Reserve).
