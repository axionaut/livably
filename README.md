# Climate Neighbours

Pick a place, pick a number — temperature, dew point, rainfall, wind, feels-like,
humidity, air quality, settling-in — and see the places on Earth sitting closest
to that exact value. Click any result and it becomes the new anchor, keeping your
measure and month. Repeat forever.

Ranking is **purely by value**. Never geography, never proximity, never population.

## Running it

Double-click `index.html`. No server, no build step, no backend, no command line.

Everything is written to survive a `file://` origin, which blocks module scripts,
Web Workers and `fetch()` — so the page uses plain `<script>` tags, keeps the
engine on the main thread, and loads its data as scripts rather than fetching JSON.

## Data

| What | Source |
| --- | --- |
| Climate | ERA5 monthly reanalysis via the [Planette archive](https://registry.opendata.aws/planette_era5_reanalysis/), read in-browser with [icechunk-js](https://github.com/EarthyScience/icechunk-js) |
| Air quality | [SatPM2.5 V6.GL.03](https://registry.opendata.aws/surface-pm2-5-v6gl/) (ACAG, WUSTL) annual mean PM2.5 |
| Places | GeoNames `cities500` — 235,157 settlements (CC BY 4.0) |
| Settling in | [passport-index-dataset](https://github.com/ilyankou/passport-index-dataset) (ODbL) + World Bank GDP per capita PPP (CC BY 4.0) |

Regenerate the data files with `tools/build_cities.py`, `tools/build_pm25.py`
and `tools/build_liveability.py`.

See `brief.md` for the architecture, the measured performance numbers, and the
things that are easy to get wrong in this data.
