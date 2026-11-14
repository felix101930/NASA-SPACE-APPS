"""Shared paths and constants. Keep small; owned by the lead (main session)."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw"          # cached downloads (git-ignored)
INTERIM = ROOT / "data" / "interim"  # intermediate arrays (git-ignored)
WEB_DATA = ROOT / "web" / "public" / "data"  # final outputs read by the web app

MOON_R_M = 1_737_400.0
EARTH_R_M = 6_371_000.0
EARTH_R_EFF_M = EARTH_R_M * 7.0 / 6.0  # terrestrial refraction, horizon geometry only

MOON_CRS = "+proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +x_0=0 +y_0=0 +R=1737400 +units=m +no_defs"
MOON_DEM_URL = "/vsicurl/https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_20MPP_ADJ.TIF"
MOON_ILLUM_URL = "https://pgda.gsfc.nasa.gov/data/MoonIllumination/AVGVISIB_85S_060M_201608.TIF"
COP_DEM_TILE = "https://copernicus-dem-30m.s3.amazonaws.com/{name}/{name}.tif"  # name e.g. Copernicus_DSM_COG_10_N51_00_W115_00_DEM
WORLDCOVER_TILE = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{tile}_Map.tif"

GRID_RES_M = 30.0     # common comparison grid
CORE_SIZE_PX = 500    # 15 km core
HAZARDS = ("shadow", "rim", "texture")
REGION_IDS = (
    "cabeus_b_peak", "haworth", "malapert_massif", "mons_mouton_plateau", "mons_mouton",
    "nobile_rim_1", "nobile_rim_2", "de_gerlache_rim_2", "slater_plain",
)

for _p in (RAW, INTERIM, WEB_DATA):
    _p.mkdir(parents=True, exist_ok=True)
