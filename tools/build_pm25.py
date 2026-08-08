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
ANNUAL = (f"V6GL03/CoarseResolution/GL/Annual/"
          f"V6GL03.CNNPM25.0p10.GL.{YEAR}01-{YEAR}12.nc")


def monthly_key(m):
    return (f"V6GL03/CoarseResolution/GL/Monthly/{YEAR}/"
            f"V6GL03.CNNPM25.0p10.GL.{YEAR}{m:02d}-{YEAR}{m:02d}.nc")


def fetch(key):
    os.makedirs(RAW, exist_ok=True)
    path = os.path.join(RAW, os.path.basename(key))
    if not os.path.exists(path):
        print(f"  downloading {os.path.basename(key)} ...")
        urllib.request.urlretrieve(f"{BUCKET}/{key}", path)
    return path


def sample(ds, rows, lat_key="lat", lon_key="lon"):
    """Nearest-cell lookup, with the fill value and polar gaps treated as
    missing rather than as clean air."""
    import numpy as np
    var = "PM25" if "PM25" in ds else list(ds.data_vars)[0]
    grid = ds[var].values.astype("float32")
    lat = ds[lat_key].values
    lon = ds[lon_key].values
    dlat = lat[1] - lat[0]
    dlon = lon[1] - lon[0]
    clat = np.array([r[5] for r in rows], dtype="float64")
    clon = np.array([r[6] for r in rows], dtype="float64")
    iy = np.clip(np.rint((clat - lat[0]) / dlat).astype("int64"), 0, len(lat) - 1)
    ix = np.clip(np.rint((clon - lon[0]) / dlon).astype("int64"), 0, len(lon) - 1)
    vals = grid[iy, ix]
    outside = (clat < lat.min() - abs(dlat)) | (clat > lat.max() + abs(dlat))
    missing = ~np.isfinite(vals) | (vals < 0) | outside
    return vals, missing


def main():
    import xarray as xr

    ds = xr.open_dataset(fetch(ANNUAL))
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

    vals, missing = sample(ds, rows)
    print(f"  annual: no data at {int(missing.sum()):,} places "
          f"({100 * missing.mean():.2f}%) — stored as -1")

    # Layout: slice 0 is the annual mean, slices 1-12 are the months, so air
    # quality behaves exactly like the ERA5 measures instead of being a special
    # annual-only case. Tenths of a microgram is ample and halves nothing.
    planes = [(vals, missing)]
    for m in range(1, 13):
        dsm = xr.open_dataset(fetch(monthly_key(m)))
        planes.append(sample(dsm, rows))
        dsm.close()
        print(f"    month {m:02d} sampled")

    q = np.zeros((13, len(rows)), dtype="<i2")
    for i, (v, miss) in enumerate(planes):
        q[i] = np.where(miss, -1, np.clip(np.rint(v * 10), 0, 32760))

    out = os.path.join(ROOT, "data", "pm25.js")
    with open(out, "w", encoding="utf8") as fh:
        fh.write("window.PM25=")
        json.dump({
            "year": YEAR,
            "scale": 10,
            "units": "µg/m³",
            "source": "SatPM2.5 V6.GL.03 (ACAG, WUSTL) via AWS Open Data",
            "n": len(rows),
            "planes": 13,
            "layout": "slice 0 = annual, slices 1-12 = Jan-Dec",
            "b64": base64.b64encode(q.tobytes()).decode("ascii"),
        }, fh, separators=(",", ":"))
        fh.write(";")

    good = vals[~missing]
    print(f"  wrote data/pm25.js ({os.path.getsize(out) / 1e6:.2f} MB)")
    print(f"  annual range {good.min():.1f}-{good.max():.1f}, median {np.median(good):.1f}")


if __name__ == "__main__":
    sys.exit(main())
