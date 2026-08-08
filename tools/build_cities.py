"""Build data/cities.json from the full GeoNames dump.

No curation and no size limit: every named settlement GeoNames publishes goes
in. The service holds this list; the browser only ever receives the handful of
rows it asked for, so the length of it costs the front end nothing.

Downloads the raw dumps on first run and caches them in data/raw/.
"""

import io
import json
import os
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
# Emitted as a plain script, not JSON: fetch() is blocked on file:// URLs, so
# the page loads this with a <script> tag and reads window.CITIES.
OUT = os.path.join(ROOT, "data", "cities.js")

DUMP = os.environ.get("GEONAMES_DUMP", "cities500")

SOURCES = {
    f"{DUMP}.zip": f"https://download.geonames.org/export/dump/{DUMP}.zip",
    "countryInfo.txt": "https://download.geonames.org/export/dump/countryInfo.txt",
    "admin1CodesASCII.txt": "https://download.geonames.org/export/dump/admin1CodesASCII.txt",
}

CONTINENTS = {
    "AF": "Africa", "AS": "Asia", "EU": "Europe",
    "NA": "North America", "OC": "Oceania", "SA": "South America", "AN": "Antarctica",
}


def fetch(name):
    path = os.path.join(RAW, name)
    if not os.path.exists(path):
        os.makedirs(RAW, exist_ok=True)
        print(f"  downloading {name} ...")
        urllib.request.urlretrieve(SOURCES[name], path)
    return path


def load_countries():
    names, continents = {}, {}
    with open(fetch("countryInfo.txt"), encoding="utf8") as fh:
        for line in fh:
            if line.startswith("#"):
                continue
            f = line.rstrip("\n").split("\t")
            if len(f) > 8 and f[0]:
                names[f[0]] = f[4]
                continents[f[0]] = CONTINENTS.get(f[8], "")
    return names, continents


def load_admin1():
    regions = {}
    with open(fetch("admin1CodesASCII.txt"), encoding="utf8") as fh:
        for line in fh:
            f = line.rstrip("\n").split("\t")
            if len(f) >= 2:
                regions[f[0]] = f[1]
    return regions


def main():
    country_names, country_continents = load_countries()
    regions = load_admin1()

    zip_path = fetch(f"{DUMP}.zip")
    with zipfile.ZipFile(zip_path) as z:
        raw = z.read(z.namelist()[0]).decode("utf8")

    rows = []
    for line in io.StringIO(raw):
        f = line.rstrip("\n").split("\t")
        if len(f) < 18:
            continue
        try:
            lat, lon = float(f[4]), float(f[5])
        except ValueError:
            continue
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        cc = f[8]
        region = regions.get(f"{cc}.{f[10]}", "")
        try:
            pop = int(f[14])
        except ValueError:
            pop = 0
        # 3dp is ~110 m, far finer than the 0.25 deg (~28 km) climate grid, and
        # trims a lot of bytes off a file the browser has to parse on startup.
        ascii_name = f[2] if f[2] != f[1] else ""
        rows.append([
            int(f[0]),                    # geonameId
            f[1],                         # name
            ascii_name,                   # ascii fallback, blank if identical
            region,
            cc,
            round(lat, 3),
            round(lon, 3),
            pop,
        ])

    rows.sort(key=lambda r: -r[7])

    payload = {
        "fields": ["id", "name", "ascii", "region", "cc", "lat", "lon", "pop"],
        "countries": {cc: [country_names.get(cc, cc), country_continents.get(cc, "")]
                      for cc in {r[4] for r in rows}},
        "rows": rows,
        "source": f"GeoNames {DUMP} (CC BY 4.0)",
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf8") as fh:
        fh.write("window.CITIES=")
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write(";")

    size = os.path.getsize(OUT) / 1e6
    print(f"wrote {len(rows):,} cities -> data/cities.js ({size:.1f} MB)")


if __name__ == "__main__":
    main()
