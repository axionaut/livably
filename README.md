# Livably

**Keep the weather you love, all year.** Pick a place at its best — Lisbon in
September, Bangalore in February, home in spring — and Livably shows, for every
month of the year, where on Earth has that same climate, among places your
passport can actually get you into. Months when home already matches say
"stay".

Underneath that sits the original explorer: pick a place and a number
(temperature, dew point, rainfall, wind, feels-like, humidity, air quality,
settling-in) and see the places sitting closest to that exact value. Ranking is
**purely by value**: never geography, never proximity, never population.

Every view is a link. The address bar carries the place, screen, measure,
month, passport and entry filter, so "where to be all year if you love Lisbon's
September, on a UK passport, visa-free only" is a URL you can send.

## Running it

Double-click `index.html`. No server, no build step, no backend, no command line.

Everything is written to survive a `file://` origin, which blocks module scripts,
Web Workers and `fetch()` — so the page uses plain `<script>` tags, keeps the
engine on the main thread, and loads its data as scripts rather than fetching JSON.

## Data

| What | Source |
| --- | --- |
| Climate | ERA5 monthly reanalysis via the [Planette archive](https://registry.opendata.aws/planette_era5_reanalysis/), baked into ten-year monthly normals (2015–2024) |
| Air quality | [SatPM2.5 V6.GL.03](https://registry.opendata.aws/surface-pm2-5-v6gl/) (ACAG, WUSTL) annual mean PM2.5 |
| Places | GeoNames `cities500` — 235,157 settlements (CC BY 4.0) |
| Settling in | [passport-index-data](https://github.com/imorte/passport-index-data) (MIT), all 199 passports + World Bank GDP per capita PPP (CC BY 4.0) |

Regenerate the data files with `tools/build_cities.py`, `tools/build_climate.py`
(`pip install icechunk zarr numpy`, about a minute), `tools/build_pm25.py` and
`tools/build_liveability.py`.

See `brief.md` for the architecture, the measured performance numbers, and the
things that are easy to get wrong in this data.
