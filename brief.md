# Livably

Keep the weather you love, all year: pick a place at its best, and see where on
Earth has that climate in every other month, among places your passport can
enter.

Underneath, the explorer: pick a place, pick a number — temperature, dew point,
rainfall, wind, feels-like, humidity, air quality, settling in — and see the
settlements on Earth sitting closest to that exact value: ten below, ten above.
Click any of them and it becomes the new anchor, keeping your metric and month.

Ranking is **purely by value**. Never geography, never proximity to the selected
city, never population.

## Running it

Double-click `index.html`. That is the whole procedure — no server, no build
step, no backend, no command line, and no network once the page is open.

Everything is written to survive a `file://` origin, which is fussier than it
looks: module scripts, Web Workers and `fetch()` are all blocked there. So the
page uses plain `<script>` tags, keeps the engine on the main thread, and loads
its data as scripts rather than fetching JSON.

## Files

| File | Role |
| --- | --- |
| `index.html`, `styles.css` | Screens: start, place, comparison, follow the weather, overall, favourites |
| `app.js` | Everything: metric registry, data decoding, ranking engine, UI |
| `data/cities.js` | 235,157 settlements (GeoNames `cities500`, CC BY 4.0) |
| `data/climate.js` | ERA5 monthly normals, 2015–2024, per grid cell (7.6 MB) |
| `data/pm25.js` | SatPM2.5 annual + monthly, per place |
| `data/liveability.js` | Entry rules for 199 passports x 199 destinations, plus income level |
| `tools/build_*.py` | Regenerate each data file from its source |

## How it works

Climate comes from **ERA5 monthly reanalysis** in the public
[Planette archive](https://registry.opendata.aws/planette_era5_reanalysis/)
(`planette-era5`, us-east-2). It used to be read live from the browser with
`icechunk-js`: one ~37 MB chunk per variable-year, five variables, so a first
visit pulled ~250 MB, waited 47 s for its first figure and minutes for a full
place page — and described a single year, which is weather, not climate.

`tools/build_climate.py` now does that sampling offline, over **ten complete
years** (the newest ten every variable covers end to end, currently
2015–2024), and ships the result:

- **Per cell, not per place.** Every place reads the 0.25° cell it sits in;
  235k places occupy ~55k cells, so four fields x 12 months x 55k cells as
  int16 is 5 MB, plus a uint16 place -> cell map. The page computes each
  measure once per cell and fans it out.
- **Base fields, not finished measures.** Temperature, dew point, wind speed
  and rainfall (mm/day). Feels-like and humidity are derived in the page, so
  the formulas live in one place.
- **Sorting by cell.** A climate measure's place order is a sort of 55k cells
  expanded through the cell membership lists — far cheaper than sorting 235k
  places.

Measured in a headless browser from `file://`: the page is ready in ~1 s, a
full place page in ~1 s, a comparison in ~0.2 s, and a twelve-month Follow the
weather plan in ~0.5 s. There is no cache to warm and nothing to clear.

## Follow the weather

The product's main question. One place in one month is the target, and the
month is **the selected period**, like on every other screen: pick November on
the place page, or compare dew point in November, and that is what is followed.
Only when the whole year is selected — no single month to keep — does it start
from the place's most comfortable month (feels-like near 22 °C, not muggy, not
a washout), and it selects that month visibly and says so.

It matches on the **whole climate** by default, or on **one measure alone**
("Dew point only"), which is what the comparison screen's "Follow this dew
point in November all year" button opens. Each measure has its own step (2° of
temperature, dew point or feels-like, 8 % humidity, ~6 km/h wind, a step in the
square root of rain). Every month of the year gets:

- **A verdict on home.** Within 1.5 steps of the target: stay. Otherwise the
  biggest gap in words ("6.6° colder, drier air").
- **The closest places on Earth that month.** Distance is counted in fixed
  comfort steps — 2 °C of temperature, 2 °C of dew point, ~6 km/h of wind, 1.5
  in the square root of monthly rain — so "close" means the same in every
  month, which a global z-score would not. Rain goes through a square root
  because 20 vs 60 mm is a different month and 220 vs 260 mm is not.
- **Spread and recognisability.** Home's own ~150 km is excluded, one result
  per ~1° cell, at most two per country. Among candidates within one step of
  the best match, a bigger town beats a hamlet (a third of a step per tenfold
  drop below a million people). Climate decides who is in the running; size
  only orders near-equals.

Every shared filter applies, and range filters read each month's own figures —
a July row is filtered by July air quality.

## Passports

`data/liveability.js` carries the whole passport x destination matrix, one
letter per pair (visa-free, on arrival, e-visa, required, no entry), ~40 KB.
The visitor's passport is guessed from the browser locale and can be changed
in the header. It drives:

- **Settling in**, a country-level score: entry access for that passport, plus
  income level relative to the passport's own country. Income is stored
  relative to one reference country and re-based by subtraction, which is exact
  on its log scale except where a score sat at the 0/100 clamp.
- **The entry filter**, shared by every screen: any rules, visa-free/on
  arrival/e-visa, or no visa needed ahead.

## Shareable links

The hash carries `p` (GeoNames id), `v` (screen), `m` (measure), `t` (period),
`pp` (passport), `on` (what Follow the weather matches on) and `e` (entry
filter). The followed month is just `t`. It is rewritten
with `replaceState` as the selection changes, read on load and on
`hashchange`, and works from `file://` as well as from a web server.

## Metrics

| Metric | ERA5 source | Notes |
| --- | --- | --- |
| Temperature | `t2m` | Direct |
| Dew point | `td2m` | Direct. The only metric with a comfort scale |
| Feels like | `t2m`, `td2m`, wind | Derived — BoM apparent temperature |
| Relative humidity | `t2m`, `td2m` | Derived — Magnus/Alduchov-Eskridge |
| Rainfall | `pr` | Monthly and annual totals, mm |
| Wind speed | `u10m`, `v10m` | Mean over years of each month's speed |

Annual figures are **day-weighted** means, so a 31-day month counts for more
than February (28.25 days in a ten-year normal). Rainfall is a total instead of
a mean. Comparisons use full precision; rounding happens only for display.

## Things worth knowing

- **`u10`/`v10` are not surface wind.** They are the 10 hPa pressure level —
  stratosphere. Ten-metre wind is `u10m`/`v10m`. This is easy to get wrong.
- **Wind within a month is a vector mean**, which understates true average
  speed. ERA5's scalar `si10` is not in this archive. The UI says so.
- **Sunshine duration is not available.** No solar or radiation variable exists
  in this archive, so the metric is omitted rather than faked.
- **The time axis is `days since 1940-01-01`**, not a Unix epoch, and its start
  differs per variable (`pr` begins 1940-04). `build_climate.py` decodes the CF
  units attribute rather than assuming.
- **0.25° is roughly 28 km**, and every place reads its nearest cell, so
  neighbouring towns share a climate exactly. Interpolating would only invent
  precision the grid does not have.

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

## One selection, every screen

`renderControls()` builds the same block for the comparison, the favourites and
the overall ranking: period, measure, size, continents, countries, and the
range filters. There is no second implementation to drift, so a measure added
to `METRICS` is filterable, comparable and rankable the day it lands.

- **Period is global.** A measure with no monthly field (settling in) reads its
  annual figure, but it never overwrites the selection: pick July, switch to
  settling in and back, and it is still July. The range filters and every other
  measure keep reading July throughout.
- **Continents and countries are multi-select**, from the same checklist
  component. Countries are scoped to the chosen continents; choosing a continent
  drops any selected country that no longer belongs.
- **The place page reads and sets the period too**, and everything on it —
  cards, sky, most similar climates, the Follow button — follows it together.
- **Clicking a place re-anchors, wherever you are.** The screen, the measure,
  the period and the filters stay; only the point of reference moves. `Details`
  opens the place page.
- **Favourites obey the filters too**, but a favourite outside them is set aside
  with a count and a way back, not silently dropped — you chose those places.

## The period is fixed by the data

There is no year picker. The climate is a ten-year normal whose window is chosen
when `data/climate.js` is built — the newest ten years every ERA5 variable
covers from January to December — and the page reads it from the file. Air
quality is the single year SatPM2.5 publishes (currently 2024) and is labelled
as such.
