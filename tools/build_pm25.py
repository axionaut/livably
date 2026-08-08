"""Sample global satellite-derived PM2.5 at every catalogue city.

Source: SatPM2.5 V6.GL.03 (Atmospheric Composition Analysis Group, WUSTL),
via the AWS Open Data mirror s3://satpmdata — anonymous, no key required.
    https://registry.opendata.aws/surface-pm2-5-v6gl/

Unlike the ERA5 layers, one PM2.5 field is a single annual number per place, so
235k values fit in ~470 KB as int16. That is small enough to ship as a static
file, which is what makes air quality rankable like every other measure instead
of a per-city lookup limited to whatever is on screen.

Output: data/pm25.js  (base64 int16, hundredths of a microgram)
"""

import base64
import json
import os
import sys
import urllib.request

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
YEAR = int(os.environ.get("PM25_YEAR", "2024"))

BUCKET = "https://satpmdata.s3.us-east-1.amazonaws.com"
KEY = (f"V6GL03/CoarseResolution/GL/Annual/"
       f"V6GL03.CNNPM25.0p10.GL.{YEAR}01-{YEAR}12.nc")


def fetch():
    os.makedirs(RAW, exist_ok=True)
    path = os.path.join(RAW, os.path.basename(KEY))
    if not os.path.exists(path):
        print(f"  downloading {os.path.basename(KEY)} ...")
        urllib.request.urlretrieve(f"{BUCKET}/{KEY}", path)
    print(f"  {os.path.getsize(path) / 1e6:.1f} MB")
    return path


def main():
    import xarray as xr

    ds = xr.open_dataset(fetch())
    var = "PM25" if "PM25" in ds else list(ds.data_vars)[0]
    da = ds[var]
    lat = ds["lat"].values
    lon = ds["lon"].values
    grid = da.values.astype("float32")
    print(f"  grid {grid.shape}  lat {lat[0]:.2f}..{lat[-1]:.2f}  "
          f"lon {lon[0]:.2f}..{lon[-1]:.2f}")

    cities_path = os.path.join(ROOT, "data", "cities.js")
    with open(cities_path, encoding="utf8") as fh:
        payload = json.loads(fh.read().split("=", 1)[1].rstrip().rstrip(";"))
    rows = payload["rows"]
    print(f"  {len(rows):,} cities")

    # Nearest-cell lookup; at 0.1 deg (~11 km) that is finer than the climate
    # grid already in use, so interpolation would add nothing meaningful.
    dlat = lat[1] - lat[0]
    dlon = lon[1] - lon[0]
    clat = np.array([r[5] for r in rows], dtype="float64")
    clon = np.array([r[6] for r in rows], dtype="float64")
    iy = np.clip(np.rint((clat - lat[0]) / dlat).astype("int64"), 0, len(lat) - 1)
    ix = np.clip(np.rint((clon - lon[0]) / dlon).astype("int64"), 0, len(lon) - 1)

    vals = grid[iy, ix]

    # The file uses -999 as its fill value, not NaN, and the grid stops at
    # 70N/60S — so polar places index out of range and must not silently
    # inherit an edge cell. Both count as missing, never as clean air.
    outside = (clat < lat.min() - abs(dlat)) | (clat > lat.max() + abs(dlat))
    missing = ~np.isfinite(vals) | (vals < 0) | outside
    print(f"  no data at {int(missing.sum()):,} places "
          f"({100 * missing.mean():.2f}%) — stored as -1")

    # Hundredths of a microgram keeps 0.01 precision inside int16 up to 327.
    q = np.where(missing, -1, np.clip(np.rint(vals * 100), 0, 32760)).astype("<i2")

    out = os.path.join(ROOT, "data", "pm25.js")
    with open(out, "w", encoding="utf8") as fh:
        fh.write("window.PM25=")
        json.dump({
            "year": YEAR,
            "scale": 100,
            "units": "µg/m³",
            "source": "SatPM2.5 V6.GL.03 (ACAG, WUSTL) via AWS Open Data",
            "n": len(rows),
            "b64": base64.b64encode(q.tobytes()).decode("ascii"),
        }, fh, separators=(",", ":"))
        fh.write(";")

    good = vals[~missing]
    print(f"  wrote data/pm25.js ({os.path.getsize(out) / 1e6:.2f} MB)")
    print(f"  PM2.5 range {good.min():.1f}-{good.max():.1f}, median {np.median(good):.1f}")


if __name__ == "__main__":
    sys.exit(main())
