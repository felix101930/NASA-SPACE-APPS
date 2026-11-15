"""Known Earth analog sites: answer key and novelty filter. Never used as model input.

Sources: USGS TADP (API), USGS PAAD (CSV on ScienceBase), and NASA / ESA / literature field-test sites.
Field-site coordinates are approximate field-area centres; each row carries its basis.
"""
import csv
import io
import json
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "analogs" / "known_analogs.json"
TADP = "https://5j7x5wew8j.execute-api.us-west-2.amazonaws.com/prod/api/terrestrial-analog-sites"
PAAD = ("https://www.sciencebase.gov/catalog/file/get/64d418c3d34ef477cf3ced10?f=__disk__5d%2Fc9%2Fe5%2F"
        "5dc9e5cddd850a6b67d000ee0523b770f969e49a")

# name, lat, lon, body, basis
FIELD = [
    ("Meteor Crater, AZ", 35.027, -111.022, "moon", "Apollo crew impact-geology training"),
    ("Cinder Lake Crater Field, AZ", 35.31, -111.55, "moon", "Crater field built to simulate Apollo 11 site; rover and EVA practice"),
    ("Black Point Lava Flow, AZ", 35.68, -111.47, "moon", "NASA Desert RATS 2008-2011 lunar rover and EVA tests"),
    ("SP Crater, San Francisco Volcanic Field, AZ", 35.58, -111.63, "moon", "Desert RATS and JETT Artemis EVA field tests"),
    ("Craters of the Moon, ID", 43.42, -113.52, "moon", "Apollo 14 training; NASA FINESSE/BASALT field work"),
    ("Mauna Kea quarry, HI", 19.76, -155.46, "moon", "PISCES / NASA ISRU (RESOLVE) field tests"),
    ("Kilauea caldera, HI", 19.41, -155.28, "moon", "Apollo crew volcanic geology training"),
    ("Mauna Ulu, Kilauea, HI", 19.36, -155.21, "moon", "NASA BASALT / FINESSE EVA science tests"),
    ("HI-SEAS, Mauna Loa, HI", 19.60, -155.48, "moon", "Habitat and mission-simulation analog"),
    ("Timanfaya, Lanzarote", 29.0, -13.75, "moon", "ESA PANGAEA training; CanMoon rover mission"),
    ("Nordlinger Ries, Germany", 48.88, 10.56, "moon", "Apollo 14 and ESA PANGAEA impact-geology training"),
    ("Sudbury Basin, ON", 46.6, -81.18, "moon", "Apollo crew impact-geology training"),
    ("Sierra del Pinacate, Mexico", 31.77, -113.5, "moon", "Apollo crew training in volcanic craters"),
    ("Medicine Lake / Lava Beds, CA", 41.71, -121.51, "moon", "Apollo-era training on lava flows"),
    ("Lava Butte / Newberry, Bend OR", 43.92, -121.36, "moon", "Apollo crew training on volcanic terrain"),
    ("Rio Grande Gorge, NM", 36.47, -105.73, "moon", "Apollo 15 training (Hadley Rille analog)"),
    ("Orocopia Mountains, CA", 33.55, -115.85, "moon", "Apollo 15/17 crew geology training"),
    ("Moses Lake sand dunes, WA", 46.98, -119.27, "moon", "NASA Desert RATS 2008 rover tests"),
    ("Mistastin Lake crater, Labrador", 55.88, -63.31, "moon", "Anorthosite impact crater; NASA FINESSE lunar analog"),
    ("Lonar crater, India", 19.98, 76.51, "moon", "Basalt-hosted impact crater, lunar analog literature"),
    ("Kamil crater, Egypt", 22.02, 26.09, "moon", "Fresh small impact crater, ejecta studies"),
    ("Lofoten anorthosite, Norway", 68.2, 13.9, "moon", "ESA PANGAEA lunar highland anorthosite"),
    ("Bletterbach, Italy", 46.35, 11.43, "mars", "ESA PANGAEA sedimentary geology training"),
    ("JSC Rock Yard, TX", 29.56, -95.09, "moon", "NASA JSC surface-ops test yard"),
    ("Ubehebe crater, Death Valley CA", 37.01, -117.45, "mars", "Named in challenge text; volcanic/arid analog"),
    ("Mars Desert Research Station, UT", 38.41, -110.79, "mars", "Habitat simulation analog"),
    ("Atacama (Yungay), Chile", -24.08, -70.01, "mars", "Hyperarid Mars soil and rover tests"),
    ("Rio Tinto, Spain", 37.7, -6.55, "mars", "Acidic iron-rich Mars analog"),
    ("Haughton crater, Devon Island", 75.38, -89.68, "moon", "Haughton-Mars Project crater, rover and EVA tests"),
    ("Axel Heiberg Island", 79.43, -90.77, "mars", "Cold springs and permafrost"),
    ("McMurdo Dry Valleys", -77.5, 162.0, "mars", "Cold dry polar desert"),
    ("Svalbard (Bockfjorden)", 79.42, 13.33, "mars", "AMASE volcanic and ice analog"),
    ("Askja, Iceland", 65.05, -16.75, "moon", "Apollo crew geology training (volcanic)"),
    # added from the literature novelty check (results/novelty_*.csv)
    ("Valley of Ten Thousand Smokes, Katmai AK", 58.37, -155.25, "moon", "Apollo crew training 1965-66; NASA Goddard field work 2024"),
    ("Eureka, Ellesmere Island", 79.99, -85.94, "mars", "NASA-listed astrobiology drill and permafrost tests"),
    ("Moriusaq (LUNARK habitat), Greenland", 76.75, -69.90, "moon", "LUNARK lunar habitat test 2020"),
    ("Nuussuaq impact spherule bed, Greenland", 70.55, -53.20, "", "Impact deposit listed in the Impact Earth layer of TADP"),
    ("Pozo Bravo, Salar de Antofalla, Argentina", -25.55, -67.65, "mars", "Microbialite early-Mars analog"),
    ("Puga / Chumathang, Ladakh", 33.22, 78.33, "mars", "Ladakh Mars analog sites (Pandey et al. 2019)"),
    ("Tso Kar, Ladakh", 33.30, 77.98, "mars", "ISRO HOPE analog / Tso Kar GPR studies"),
    ("Grottedal caves, NE Greenland", 80.38, -21.64, "mars", "Cave Mars-analog study (Barton et al. 2020)"),
]


def build():
    out = [dict(name=n, lat=la, lon=lo, body=b, basis=w, catalog="NASA/ESA/literature field site")
           for n, la, lo, b, w in FIELD]
    fc = json.loads(requests.get(TADP, timeout=60).json()["body"])
    for f in fc["features"]:
        p = f["properties"]
        out.append(dict(name=p["Name"], lat=float(p["Lat"]), lon=float(p["Lon"]), body="",
                        basis=f'{p["AnalogType"]} analog', catalog="USGS TADP"))
    txt = requests.get(PAAD, timeout=60).content.decode("utf-8-sig", "ignore")
    for r in csv.DictReader(io.StringIO(txt)):
        out.append(dict(name=f'{r["Field_Site"]}, {r["Country"]}', lat=float(r["Center_Latitude"]),
                        lon=float(r["Center_Longitude"]), body="mars", basis="Aeolian analog", catalog="USGS PAAD"))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    json.dump(out, open(OUT, "w"), indent=1)
    return out


def load():
    return json.load(open(OUT)) if OUT.exists() else build()


if __name__ == "__main__":
    out = build()
    from collections import Counter
    print(len(out), Counter(o["catalog"] for o in out))
