"""Bake ERA5 monthly climate normals for every catalogue place into data/climate.js.

Source: ERA5 monthly reanalysis in the public Planette archive
(s3://planette-era5, us-east-2), read anonymously with the official icechunk
package:  pip install icechunk zarr numpy

Why this exists. The page used to read ERA5 live from the browser: one ~37 MB
chunk per variable-year, five variables, so a first visit downloaded ~250 MB
and waited 47 s for its first figure and minutes for a full profile. And it
read a single year, which is weather, not climate. This script does the same
sampling once, offline, over a ten-year window, and ships the result:

  - Ten complete years (the newest ten every variable covers end to end), so a
    freak summer cannot move a place. Override with NORMALS_FROM / NORMALS_TO.
  - Nearest 0.25 deg cell (~28 km). 235k places sit in ~55k distinct cells, so
    values are stored once per cell plus a place -> cell map. Interpolating
    between cells would only invent precision the grid does not have.
  - Base variables, not finished measures. Feels-like and humidity are derived
    in the page from these, exactly as before, so the formulas live in one place.
  - Wind is the mean over years of each month's wind speed. ERA5's scalar si10
    is not in this archive, so within a month it is still a vector mean.

Output: data/climate.js, base64 int16 in hundredths:
  t2m, td2m   deg C          ws   m/s          pr   mm/day
"""

import base64
import json
import os
import sys
import time

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "climate.js")
YEARS = 10

BUCKET = "planette-era5"
PREFIX = "era5/{v}/month/0p25latx0p25lon/era5_{v}_month_0p25latx0p25lon.zarr"
NLAT, NLON = 721, 1440


def open_var(v):
    import icechunk
    import zarr
    st = icechunk.s3_storage(bucket=BUCKET, prefix=PREFIX.format(v=v),
                             region="us-east-2", anonymous=True)
    g = zarr.open_group(icechunk.Repository.open(st).readonly_session("main").store,
                        mode="r")
    # CF time: "days since <date>", and the start differs per variable
    # (t2m begins 1940-01, pr 1940-04). Decode it, never assume an epoch.
    units = g["time"].attrs["units"]
    y, m, d = (int(x) for x in units.split("since ")[1][:10].split("-"))
    t0 = np.datetime64(f"{y:04d}-{m:02d}-{d:02d}") + np.timedelta64(int(g["time"][0]), "D")
    first = t0.astype("datetime64[M]").astype(int)          # months since 1970-01
    return {"arr": g[v], "first": first, "months": g["time"].shape[0],
            "lat": g["lat"][:], "lon": g["lon"][:]}


def year_slice(meta, year):
    i0 = (year - 1970) * 12 - meta["first"]
    if i0 < 0 or i0 + 12 > meta["months"]:
        raise ValueError(f"no complete {year}")
    return meta["arr"][i0:i0 + 12]


def last_full_year(meta):
    return (meta["first"] + meta["months"] - 12) // 12 + 1970


def main():
    with open(os.path.join(ROOT, "data", "cities.js"), encoding="utf8") as fh:
        rows = json.loads(fh.read().split("=", 1)[1].rstrip().rstrip(";"))["rows"]
    print(f"  {len(rows):,} places")

    metas = {v: open_var(v) for v in ("t2m", "td2m", "u10m", "v10m", "pr")}
    newest = min(last_full_year(m) for m in metas.values())
    y1 = int(os.environ.get("NORMALS_TO", newest))
    y0 = int(os.environ.get("NORMALS_FROM", y1 - YEARS + 1))
    print(f"  normals {y0}-{y1} (newest complete year in every variable: {newest})")

    # Same axis convention the page used: lat 90 -> -90, lon -179.75 -> 180.
    lat, lon = metas["t2m"]["lat"], metas["t2m"]["lon"]
    assert len(lat) == NLAT and len(lon) == NLON and lat[0] > lat[-1], (lat[:2], lon[:2])
    clat = np.array([r[5] for r in rows], dtype="float64")
    clon = np.array([r[6] for r in rows], dtype="float64")
    iy = np.clip(np.rint((lat[0] - clat) / (lat[0] - lat[1])), 0, NLAT - 1).astype("int64")
    ix = np.rint((clon - lon[0]) / (lon[1] - lon[0])).astype("int64") % NLON
    flat = iy * NLON + ix
    cells, cell_of = np.unique(flat, return_inverse=True)
    print(f"  {len(cells):,} distinct grid cells")

    acc = {k: np.zeros((12, len(cells)), dtype="float64") for k in ("t2m", "td2m", "ws", "pr")}
    for year in range(y0, y1 + 1):
        t = time.time()
        got = {}
        for v in metas:
            grid = year_slice(metas[v], year).reshape(12, -1)
            got[v] = grid[:, cells].astype("float64")
        acc["t2m"] += got["t2m"] - 273.15
        acc["td2m"] += got["td2m"] - 273.15
        acc["ws"] += np.hypot(got["u10m"], got["v10m"])
        acc["pr"] += got["pr"] * 86400.0                     # kg m-2 s-1 is mm/s
        print(f"    {year} sampled ({time.time() - t:.0f} s)")

    n = y1 - y0 + 1
    planes = []
    for k in ("t2m", "td2m", "ws", "pr"):
        mean = acc[k] / n
        print(f"    {k:5s} {mean.min():9.2f} .. {mean.max():9.2f}")
        planes.append(np.clip(np.rint(mean * 100), -32767, 32767).astype("<i2"))
    q = np.stack(planes)                                     # var, month, cell

    assert len(cells) < 65536, "cell ids no longer fit uint16"
    with open(OUT, "w", encoding="utf8") as fh:
        fh.write("window.CLIMATE=")
        json.dump({
            "from": y0, "to": y1, "scale": 100,
            "source": "ERA5 monthly reanalysis (ECMWF/Copernicus) via the Planette archive",
            "vars": ["t2m", "td2m", "ws", "pr"],
            "units": {"t2m": "°C", "td2m": "°C", "ws": "m/s", "pr": "mm/day"},
            "n": len(rows), "cells": len(cells),
            "layout": "int16 [var][month][cell]; cellOf maps place -> cell (uint16)",
            "cellOf": base64.b64encode(cell_of.astype("<u2").tobytes()).decode("ascii"),
            "b64": base64.b64encode(q.tobytes()).decode("ascii"),
        }, fh, separators=(",", ":"))
        fh.write(";")
    print(f"  wrote data/climate.js ({os.path.getsize(OUT) / 1e6:.2f} MB)")


if __name__ == "__main__":
    sys.exit(main())
