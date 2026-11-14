"""Hand-checked facts behind the impact numbers. Every figure has a primary source URL and a short verbatim quote.

Checked 2026-11-14 by fetching each page (curl / PDF text). If a figure changes, edit it here and re-run
`python -m pipeline.impact`; nothing in this file is computed.
"""
from __future__ import annotations

OIG_URL = ("https://oig.nasa.gov/wp-content/uploads/2024/06/"
           "final-report-ig-24-013-nasas-commercial-lunar-payload-services-initiative.pdf")
OIG_NAME = "NASA OIG, Audit of NASA's Commercial Lunar Payload Services Initiative (IG-24-013, 6 June 2024), Table 2"

DESNZ_PUB_URL = "https://www.gov.uk/government/publications/greenhouse-gas-reporting-conversion-factors-2026"
DESNZ_FLAT_URL = ("https://assets.publishing.service.gov.uk/media/6a6c9748862aaf18d9c62ac9/"
                  "ghg-conversion-factors-2026-flat-format-revised.xlsx")
DESNZ_METHOD_URL = ("https://assets.publishing.service.gov.uk/media/6a2940543b15d05a7ce3202e/"
                    "2026-GHG-conversion-factors-methodology-report.pdf")
GSA_URL = ("https://www.gsa.gov/policy-regulations/regulations/federal-travel-regulation/"
           "ftr-and-related-files/gsa-per-diem-bulletin-ftr-2601")

# UK DESNZ 2026 GHG conversion factors (flat file v1.2), Business travel - air, Flights,
# "International, to/from non-UK", Economy class, passenger.km, kg CO2e. Identical to the 2025 set.
# Methodology para 8.38: the 8% great-circle uplift (indirect routing, circling) is already inside these factors.
FACTOR_WITH_RF = 0.10916      # kg CO2e per passenger-km, includes radiative forcing (non-CO2 warming)
FACTOR_WITHOUT_RF = 0.06449   # kg CO2e per passenger-km, direct CO2/CH4/N2O only

# GSA FY2026 standard CONUS per diem (FTR Bulletin 26-01)
GSA_LODGING_USD = 110
GSA_MIE_USD = 68

MONEY: list[dict] = [
    {
        "id": "im1", "item": "IM-1 Odysseus (Intuitive Machines) CLPS task orders", "value_usd": 122.0e6,
        "year": 2024, "outcome": "Landed Feb 2024, tipped onto its side",
        "outcome_class": "on_side", "nasa_clps": True,
        "source": OIG_URL, "source_name": OIG_NAME,
        "quote": "Nova-C lander, successfully landed on the lunar surface but tipped over onto its side.",
        "note": "Value as of Feb 2024 (initial $81.7M; includes two add-on task orders). NASA's 2019 award "
                "release said $77M.",
    },
    {
        "id": "im2", "item": "IM-2 Athena / PRIME-1 (Intuitive Machines) CLPS task order", "value_usd": 50.0e6,
        "year": 2024, "outcome": "Landed Mar 2025 inside a crater near Mons Mouton, on its side",
        "outcome_class": "on_side", "nasa_clps": True,
        "source": OIG_URL, "source_name": OIG_NAME,
        "outcome_source": "https://www.nasa.gov/news-release/nasa-receives-some-data-before-intuitive-machines-ends-lunar-mission/",
        "quote": "Shortly after touching down inside a crater on the Moon ... images collected later confirmed the "
                 "lander was on its side",
        "note": "Value as of Feb 2024 (initial $47.0M). Mons Mouton is one of the nine Artemis III regions this app "
                "matches.",
    },
    {
        "id": "bg1", "item": "Blue Ghost Mission 1 (Firefly) CLPS task order", "value_usd": 101.5e6,
        "year": 2024, "outcome": "Landed upright, Mar 2025", "outcome_class": "upright", "nasa_clps": True,
        "source": OIG_URL, "source_name": OIG_NAME,
        "outcome_source": "https://www.nasa.gov/news-release/touchdown-carrying-nasa-science-fireflys-blue-ghost-lands-on-moon/",
        "quote": "in an upright and stable configuration",
        "note": "Value as of Feb 2024 (initial $93.3M).",
    },
    {
        "id": "pm1", "item": "Peregrine Mission One (Astrobotic) CLPS task order", "value_usd": 107.9e6,
        "year": 2024, "outcome": "Propellant leak in space; never attempted a landing",
        "outcome_class": "no_landing", "nasa_clps": True,
        "source": OIG_URL, "source_name": OIG_NAME,
        "outcome_source": "https://www.astrobotic.com/wp-content/uploads/2024/08/PM1_Post-Mission-Report_Website.pdf",
        "quote": "failure of a singular helium pressure control valve, called PCV2",
        "note": "Not a terrain failure: excluded from the landing-hazard total. Shown for completeness.",
    },
    {
        "id": "viper", "item": "VIPER rover project (cancelled Jul 2024)", "value_usd": 505.4e6, "year": 2024,
        "outcome": "Cancelled before flight", "outcome_class": "context", "nasa_clps": False,
        "source": OIG_URL, "source_name": "NASA OIG IG-24-013",
        "quote": "NASA's $505.4-million Volatiles Investigating Polar Exploration Rover (VIPER)",
        "note": "Context only: the kind of south-pole payload a landing has to deliver intact. Griffin delivery "
                "task order was $322.8M (Feb 2024).",
    },
    {
        "id": "clps_cap", "item": "CLPS contract maximum value through Nov 2028", "value_usd": 2.6e9, "year": 2028,
        "outcome": "Context", "outcome_class": "context", "nasa_clps": True,
        "source": "https://www.nasa.gov/commercial-lunar-payload-services/", "source_name": "NASA CLPS overview",
        "quote": "combined maximum contract value of $2.6 billion through November 2028",
        "note": "OIG: delivery task orders grew from $781.4M to $984.3M by Feb 2024; NASA had paid $673M.",
    },
    {
        "id": "ispace_m1_ins", "item": "ispace Hakuto-R Mission 1 insurance income", "value_jpy": 3.793e9,
        "value_usd": None, "year": 2024,
        "outcome": "Crashed Apr 2023: altitude estimate went wrong after passing a ~3 km crater rim",
        "outcome_class": "crashed", "nasa_clps": False,
        "source": "https://www.ispace-inc.com/2024/11/12/ispace-reports-q2-financial-results-for-fy-ending-march-2025-and-mission-2-launch-scheduled-no-earlier-than-jan-2025/",
        "outcome_source": "https://www.ispace-inc.com/2023/05/26/ispace-announces-results-of-the-hakuto-r-mission-1-lunar-landing/",
        "source_name": "ispace Q2 FY2025 results",
        "quote": "recorded lunar insurance of ¥3,793MM in the extraordinary income",
        "note": "Reported in yen; not converted. No official mission cost published.",
    },
    {
        "id": "ispace_m2", "item": "ispace Mission 2 'Resilience': fix for Missions 3-4", "value_jpy": 1.5e9,
        "value_usd": None, "year": 2025,
        "outcome": "Crashed Jun 2025: laser range finder anomaly (hard landing)", "outcome_class": "crashed",
        "nasa_clps": False,
        "source": "https://www.ispace-inc.com/2025/06/24/ispace-releases-technical-cause-analysis-for-hakuto-r-mission-2/",
        "source_name": "ispace technical cause analysis, Mission 2",
        "quote": "increase combined development costs by a maximum of approximately 1.5 billion yen",
        "note": "Insurance did not pay out for Mission 2 (ispace Q1 FY2027 results). Yen, not converted.",
    },
]

# No published cost exists for terrestrial landing-sensor field campaigns (searched: Desert RATS, JETT,
# Mars 2020 Lander Vision System field tests, Flight Opportunities TRN flights). Said plainly in the output.
TESTING_NOT_FOUND = ("No published cost found for NASA terrain/landing field campaigns (Desert RATS, JETT, "
                     "Mars 2020 Lander Vision System field tests, Flight Opportunities terrain-navigation flights).")

TESTING_CONTEXT = {
    "item": "Astrobotic terrain-relative navigation sensor, development incl. tests (NASA Tipping Point)",
    "value_usd": 10e6,
    "source": "https://www.astrobotic.com/lunar-delivery/manifest/",
    "quote": "developed under a $10 million NASA Tipping Point contract",
    "note": "A whole sensor development programme, not a field week; shown as an upper bound on scale.",
}
