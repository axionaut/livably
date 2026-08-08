# Climate Neighbours

Pick a place. Pick a number — temperature, dew point, rainfall, wind, feels-like,
humidity. See the settlements on Earth sitting closest to that exact value:
ten below, ten above. Click any of them and it becomes the new anchor, keeping
your metric and month. Repeat forever.

Ranking is **purely by value**. Never geography, never proximity to the selected
city, never population.

## Running it

Double-click `index.html`. That is the whole procedure — no server, no build
step, no backend, no command line.

Everything is written to survive a `file://` origin, which is fussier than it
looks: module scripts, Web Workers and `fetch()` are all blocked there. So the
page uses plain `<script>` tags, keeps the engine on the main thread, and loads
the city list as a script rather than fetching JSON. The climate layer works
because S3 sends `Access-Control-Allow-Origin: *` and honours a null origin.

## Files

| File | Role |
| --- | --- |
| `index.html`, `styles.css` | Three surfaces: start, city profile, comparison |
| `app.js` | Everything: metric registry, ERA5 reader, ranking engine, UI |
| `tools/build_cities.py` | Regenerates `data/cities.js` from GeoNames |
| `data/cities.js` | 235,157 settlements (GeoNames `cities500`, CC BY 4.0) |

## How it works

Climate comes from **ERA5 monthly reanalysis** in the public
[Planette archive](https://registry.opendata.aws/planette_era5_reanalysis/)
(`planette-era5`, us-east-2), read straight from the browser with
[`icechunk-js`](https://github.com/EarthyScience/icechunk-js). No backend, no
API key.

`icechunk-js` is pure TypeScript. The official `@earthmover/icechunk` package
was tried first and does not work in a page: its browser build fails at
`WebAssembly.Instance()` with `napi_create_threadsafe_function`, because the
CDN cannot wire up the emnapi/WASI runtime it expects.

The store is chunked **one year per chunk**, so a single ~25 s fetch of a
variable-year yields all twelve months *and* the annual figure. After that:

- sampling 235k cities off the grid and sorting: **~300 ms**
- binary search for neighbours: **<1 ms**
- switching month, switching units, re-anchoring: no network at all

Measured in a headless browser from `file://`: the first metric card appears
about 47 s after picking a place, and the rest stream in behind it. A city
profile covers six metrics drawn from five ERA5 variables, so a cold profile
takes a couple of minutes to fill completely; each metric renders the moment it
lands rather than making you wait for the set.

Sampled layers persist in **IndexedDB**, which does work on a `file://` origin
and survives a full browser restart (verified: written in one launch, read back
in the next). Each layer is 12 x 235,157 float32, about 11 MB; a complete set of
metrics is roughly 56 MB. The profile screen has a "Clear downloaded climate
data" control.

Measured cold vs warm, across separate browser launches:

| | Time |
| --- | --- |
| Cold — two metrics, nothing cached | 65 s |
| Warm — restart, restore place, two metrics | 5.0 s |

The last place you looked at is restored on load, so a refresh returns you to
your profile instead of the start screen and never re-asks for location.

## Metrics

| Metric | ERA5 source | Notes |
| --- | --- | --- |
| Temperature | `t2m` | Direct |
| Dew point | `td2m` | Direct. The only metric with a comfort scale |
| Feels like | `t2m`, `td2m`, `u10m`, `v10m` | Derived — BoM apparent temperature |
| Relative humidity | `t2m`, `td2m` | Derived — Magnus/Alduchov-Eskridge |
| Rainfall | `pr` | Monthly and annual totals, mm |
| Wind speed | `u10m`, `v10m` | Derived |

Annual figures are **day-weighted** means, so a 31-day month counts for more
than February. Rainfall is a total instead of a mean. Comparisons use full
precision; rounding happens only for display.

## Things worth knowing

- **`u10`/`v10` are not surface wind.** They are the 10 hPa pressure level —
  stratosphere. Ten-metre wind is `u10m`/`v10m`. This is easy to get wrong.
- **Wind is a vector mean** of monthly means, which understates true average
  speed. ERA5's scalar `si10` is not in this archive. The UI says so.
- **Sunshine duration is not available.** No solar or radiation variable exists
  in this archive, so the metric is omitted rather than faked.
- **The time axis is `days since 1940-01-01`**, not a Unix epoch, and its start
  differs per variable (`pr` begins 1940-04). `worker.js` decodes the CF units
  attribute rather than assuming.
- **0.25° is roughly 28 km**, so neighbouring towns can share a grid cell.

## Distinct values, not ties

The point is to find better and worse, so ties are worthless. At 235k places,
"the twenty closest values" returns twenty places all reading the same number —
mathematically correct, useless in practice.

So the comparison steps outward through **distinct values**: ten genuinely
lower, ten genuinely higher, one step per row at the metric's display precision.

Thousands of places can share a single value. Among those exact equals the
largest is shown, because a name you recognise beats a random hamlet, and the
row says how many others sit at the same value. This is a tiebreak *within* an
identical climate value — population has no influence on the ranking itself.

The size filter in the comparison view is a further display filter, defaulting
to "Any size". Every settlement is always ranked either way, and the anchor's
value never changes.
