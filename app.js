/* Livably — runs from a plain index.html, no server, no build step.
 *
 * Deliberately a classic script rather than a module: opening index.html as a
 * file:// URL blocks module scripts, workers and fetch(). Everything here uses
 * only what file:// allows — <script> tags for local data, and dynamic import()
 * plus cross-origin requests for the climate layer (S3 sends
 * Access-Control-Allow-Origin: *, including to a null origin).
 */
(function () {
"use strict";

var $ = function (s) { return document.querySelector(s); };

/* ------------------------------------------------------------- registry */

// Magnus / Alduchov-Eskridge saturation vapour pressure, hPa.
var svp = function (t) { return 6.1094 * Math.exp((17.625 * t) / (t + 243.04)); };

/* Climate is baked offline by tools/build_climate.py: ten-year monthly normals
   of the four ERA5 fields every measure is built from. Temperatures arrive in
   degC, wind in m/s and rainfall in mm/day. */
var METRICS = {
  temperature: { icon: '<path d="M14 4v10.5a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/>', tint: "#f0a35e", label: "Temperature", unit: "°C", vars: ["t2m"], annual: "mean", dp: 1,
    compute: function (v) { return v.t2m; } },

  dew_point: { icon: '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5S12.5 5.5 12 3c-.5 2.5-2 4.9-4 6.5S5 13 5 15a7 7 0 0 0 7 7Z"/>', tint: "#5eb3f6", label: "Dew point", unit: "°C", vars: ["td2m"], annual: "mean", dp: 1,
    comfort: true, compute: function (v) { return v.td2m; } },

  feels_like: { icon: '<circle cx="12" cy="12" r="3.5"/><path d="M12 2v2m0 16v2M4.2 4.2l1.4 1.4m12.8 12.8 1.4 1.4M2 12h2m16 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>', tint: "#f2778a", label: "Feels like", unit: "°C", vars: ["t2m", "td2m", "ws"],
    annual: "mean", dp: 1, derived: true,
    // Australian BoM apparent temperature.
    compute: function (v) { return v.t2m + 0.33 * svp(v.td2m) - 0.7 * v.ws - 4.0; } },

  humidity: { icon: '<path d="M7 16.5A3.8 3.8 0 0 0 10.8 12c0-1.1-.6-2.1-1.7-3S7.3 6.6 7 5.2c-.3 1.4-.9 2.7-2 3.6S3.2 10.9 3.2 12A3.8 3.8 0 0 0 7 16.5Z"/><path d="M16.5 20a4.5 4.5 0 0 0 4.5-4.5c0-1.3-.7-2.5-2-3.6s-2.2-2.7-2.5-4.4c-.3 1.7-1.2 3.3-2.5 4.4s-2 2.3-2 3.6A4.5 4.5 0 0 0 16.5 20Z"/>', tint: "#7dd3c0", label: "Relative humidity", unit: "%", vars: ["t2m", "td2m"],
    annual: "mean", dp: 0, derived: true,
    compute: function (v) { return Math.min(100, 100 * svp(v.td2m) / svp(v.t2m)); } },

  precipitation: { icon: '<path d="M20 15.5A4.5 4.5 0 0 0 17.5 7h-1.7A7 7 0 1 0 4 13.9"/><path d="M8 19v2m4-3v3m4-4v2"/>', tint: "#8ba4f9", label: "Rainfall", unit: "mm", vars: ["pr"], annual: "sum", dp: 0,
    // Stored as mm/day; scale to the month.
    compute: function (v, days) { return v.pr * days; } },

  liveability: {
    icon: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9h13v-9"/><path d="M10 19v-5h4v5"/>',
    tint: "#7dd3c0", label: "Settling in", unit: "score",
    vars: [], statik: "liv", annual: "mean", dp: 0, derived: true,
    note: "Country-level: entry access for your passport + income level vs home",
    compute: null,
  },

  air_quality: {
    icon: '<path d="M4 8h11a3 3 0 1 0-3-3"/><path d="M2 12h15a3 3 0 1 1-3 3"/><path d="M6 16h7a2.5 2.5 0 1 1-2.5 2.5"/>',
    tint: "#c084fc", label: "Air quality", unit: "µg/m³",
    vars: [], statik: "pm25", monthly: true, annual: "mean", dp: 1,
    note: "PM2.5 from SatPM2.5 V6.GL.03 (ACAG), monthly and annual",
    compute: null,
  },

  wind: { icon: '<path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2M9.6 4.6A2 2 0 1 1 11 8H2m8.8 11.4A2 2 0 1 0 12 16H2"/>', tint: "#a5b4c4", label: "Wind speed", unit: "km/h", vars: ["ws"], annual: "mean", dp: 1,
    derived: true, note: "Each month is a vector mean of hourly winds; understates true average speed.",
    compute: function (v) { return v.ws * 3.6; } },
};

var DEW_TIERS = [
  { max: 10, label: "Very dry", cls: "t1" }, { max: 13, label: "Pleasant", cls: "t2" },
  { max: 16, label: "Comfortable", cls: "t3" }, { max: 18, label: "Sticky", cls: "t4" },
  { max: 21, label: "Humid", cls: "t5" }, { max: 24, label: "Oppressive", cls: "t6" },
  { max: Infinity, label: "Miserable", cls: "t7" },
];
var dewTier = function (v) {
  for (var i = 0; i < DEW_TIERS.length; i++) if (v < DEW_TIERS[i].max) return DEW_TIERS[i];
};
var MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
var MONTH_NAMES = ["January","February","March","April","May","June","July",
                   "August","September","October","November","December"];
// A ten-year normal spans leap years, so February is a quarter-day longer.
var MDAYS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/* ---------------------------------------------------------------- places */

var rows = window.CITIES.rows, COUNTRIES = window.CITIES.countries, N = rows.length;
var LAT = new Float32Array(N), LON = new Float32Array(N);
for (var i = 0; i < N; i++) { LAT[i] = rows[i][5]; LON[i] = rows[i][6]; }

var describe = function (i) {
  var r = rows[i];
  return { idx: i, id: r[0], name: r[1], region: r[3], cc: r[4],
           country: (COUNTRIES[r[4]] || [r[4]])[0], lat: r[5], lon: r[6], pop: r[7] };
};

var b64bytes = function (s) {
  var bin = atob(s), buf = new ArrayBuffer(bin.length), u8 = new Uint8Array(buf);
  for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return buf;
};

/* --------------------------------------------------------- climate layer */

/* Every place reads the 0.25 deg cell it sits in, and ~55k cells cover all
   235k places, so each measure is computed once per cell and fanned out.
   Places sharing a cell share a climate — the grid cannot tell them apart. */
var CLIM = (function () {
  var d = window.CLIMATE;
  var cellOf = new Uint16Array(b64bytes(d.cellOf)), raw = new Int16Array(b64bytes(d.b64));
  var C = d.cells, planes = {};
  d.vars.forEach(function (v, vi) {
    planes[v] = [];
    for (var m = 0; m < 12; m++) {
      var f = new Float32Array(C), off = (vi * 12 + m) * C;
      for (var c = 0; c < C; c++) f[c] = raw[off + c] / d.scale;
      planes[v].push(f);
    }
  });
  // Places grouped by cell, so a cell order expands to a place order.
  var start = new Uint32Array(C + 1), members = new Uint32Array(N);
  for (var p = 0; p < N; p++) start[cellOf[p] + 1]++;
  for (var k = 0; k < C; k++) start[k + 1] += start[k];
  var fill = start.slice(0, C);
  for (p = 0; p < N; p++) members[fill[cellOf[p]]++] = p;
  return { cellOf: cellOf, cells: C, planes: planes, start: start, members: members,
           from: d.from, to: d.to, source: d.source };
})();
var NORMALS = CLIM.from + "–" + CLIM.to;

/* Air quality ships as a static per-place array, so it can be ranked like the
   climate measures instead of being a lookup limited to whatever is on screen. */
var PM25 = (function () {
  var d = window.PM25;
  if (!d || !d.b64) return null;
  var raw = new Int16Array(b64bytes(d.b64)), all = new Float32Array(raw.length);
  for (var j = 0; j < raw.length; j++)
    all[j] = raw[j] < 0 ? Infinity : raw[j] / d.scale;   // -1 marks no data

  // Slice 0 is the annual mean, slices 1-12 are Jan-Dec.
  var planes = d.planes || 1, n = all.length / planes;
  var byPeriod = [];
  for (var p = 0; p < planes; p++) byPeriod.push(all.subarray(p * n, (p + 1) * n));
  return { annual: byPeriod[0], month: byPeriod.slice(1), year: d.year, source: d.source };
})();

/* Liveability is a country-level score, so every place in a country shares it.
   That means huge ties — which the distinct-value stepping already handles by
   showing one representative per value. It depends on the passport, so it is
   rebuilt whenever the passport changes. */
var LIV_VALUES = null;
function livValues() {
  if (LIV_VALUES) return LIV_VALUES;
  LIV_VALUES = new Float32Array(N);
  var memo = {};
  for (var i = 0; i < N; i++) {
    var cc = rows[i][4];
    if (!(cc in memo)) {
      var r = livScore(cc);
      memo[cc] = r ? r.score : Infinity;      // unrated never ranks
    }
    LIV_VALUES[i] = memo[cc];
  }
  return LIV_VALUES;
}

// Climate measure for one period, per cell. period: 0-11 a month, -1 the year.
var cellCache = {};
function cellValues(metric, period) {
  var ck = metric + ":" + period;
  if (cellCache[ck]) return cellCache[ck];
  var spec = METRICS[metric], C = CLIM.cells, out = new Float32Array(C);
  var vars = spec.vars, scratch = {}, c, m, v;
  var read = function (cell, month) {
    for (v = 0; v < vars.length; v++) scratch[vars[v]] = CLIM.planes[vars[v]][month][cell];
    return spec.compute(scratch, MDAYS[month]);
  };
  for (c = 0; c < C; c++) {
    if (period >= 0) { out[c] = read(c, period); continue; }
    // Totals add up; means are day-weighted, so a 31-day month counts for
    // more than February.
    var acc = 0, days = 0;
    for (m = 0; m < 12; m++) {
      var x = read(c, m);
      if (spec.annual === "sum") acc += x;
      else { acc += x * MDAYS[m]; days += MDAYS[m]; }
    }
    out[c] = spec.annual === "sum" ? acc : acc / days;
  }
  return (cellCache[ck] = out);
}

// Any measure, any period, one value per place.
var valueCache = {};
function valuesFor(metric, period) {
  var ck = metric + ":" + period;
  if (valueCache[ck]) return valueCache[ck];
  var spec = METRICS[metric], out;
  if (spec.statik === "pm25") {
    // Air quality has real monthly fields, so it follows the period like
    // every other measure. Liveability genuinely has none, so it does not.
    out = PM25 && (period >= 0 && PM25.month.length === 12 ? PM25.month[period] : PM25.annual);
    if (!out) throw new Error(spec.label + " data not loaded");
  } else if (spec.statik === "liv") {
    return livValues();                       // passport-dependent, never cached here
  } else {
    var cv = cellValues(metric, period), cellOf = CLIM.cellOf;
    out = new Float32Array(N);
    for (var p = 0; p < N; p++) out[p] = cv[cellOf[p]];
  }
  return (valueCache[ck] = out);
}

/* Values plus every place in ascending order. A climate order is a sort of
   ~55k cells expanded through the cell membership lists — an order of
   magnitude cheaper than sorting 235k places one by one. */
var indexCache = {};
function buildIndex(metric, period) {
  var spec = METRICS[metric], ck = metric + ":" + period + (spec.statik === "liv" ? ":" + state.passport : "");
  if (indexCache[ck]) return indexCache[ck];
  var values = valuesFor(metric, period), order = new Uint32Array(N), i;

  if (!spec.statik) {
    var cv = cellValues(metric, period), cells = [];
    for (i = 0; i < CLIM.cells; i++) cells.push(i);
    cells.sort(function (a, b) { return cv[a] - cv[b]; });
    var w = 0;
    for (i = 0; i < cells.length; i++)
      for (var j = CLIM.start[cells[i]]; j < CLIM.start[cells[i] + 1]; j++) order[w++] = CLIM.members[j];
  } else {
    var tmp = [];
    for (i = 0; i < N; i++) tmp.push(i);
    tmp.sort(function (a, b) {
      var x = values[a], y = values[b];
      return x === y ? 0 : x < y ? -1 : 1;     // Infinity (no data) sorts last
    });
    order.set(tmp);
  }
  return (indexCache[ck] = { values: values, order: order });
}

/* Pure value-based neighbours. Never geography, never proximity.
 *
 * Each row is a DISTINCT value. The point is to find better and worse, so
 * returning twenty places that all read 11.6 is useless — and at 235k places
 * that is exactly what "the twenty closest" gives you. So we step outward
 * through distinct values instead: ten genuinely lower, ten genuinely higher.
 *
 * Thousands of places can share one value. Among those exact equals we show the
 * largest, because a name you recognise is more useful than a random hamlet.
 * That is a tiebreak *within* an identical climate value — population still has
 * no influence on the ranking itself.
 */
function lowerBound(values, order, x) {
  var lo = 0, hi = order.length, mid;
  while (lo < hi) { mid = (lo + hi) >> 1; if (values[order[mid]] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

function neighbours(index, anchorIdx, n, pass, dp) {
  var values = index.values, order = index.order, L = order.length;
  if (!isFinite(values[anchorIdx])) return { below: [], above: [] };
  var f = Math.pow(10, dp), half = 0.5 / f;
  var bucket = function (v) { return Math.round(v * f) / f; };

  // Largest place sharing this exact value, plus how many others there are.
  var represent = function (start, end) {
    var best = -1, bestPop = -1, kept = 0;
    for (var i = start; i < end; i++) {
      var c = order[i], pop = rows[c][7];
      if (!isFinite(values[c])) continue;      // no reading, not "cleanest"
      if (!pass(c)) continue;
      kept++;
      if (pop > bestPop) { bestPop = pop; best = c; }
    }
    return best < 0 ? null : { idx: best, shared: kept - 1 };
  };

  var anchorBucket = bucket(values[anchorIdx]);
  var below = [], above = [], rep, b, start, end;

  var i = lowerBound(values, order, anchorBucket - half);
  while (below.length < n && i > 0) {
    b = bucket(values[order[i - 1]]);
    start = lowerBound(values, order, b - half);
    rep = represent(start, i);
    if (rep) below.push(rep);
    i = start;
  }

  i = lowerBound(values, order, anchorBucket + half);
  while (above.length < n && i < L) {
    b = bucket(values[order[i]]);
    end = lowerBound(values, order, b + half);
    if (end <= i) end = i + 1;
    rep = represent(i, end);
    if (rep) above.push(rep);
    i = end;
  }
  return { below: below, above: above };
}

/* ------------------------------------------------------------------ state */

var STORE_KEY = "lv.";

/* Settings used to live under the "cn." prefix. Carry them across once so a
   rename does not quietly wipe saved favourites, filters and last place. */
(function migrateStore() {
  try {
    if (localStorage.getItem(STORE_KEY + "migrated")) return;
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf("cn.") === 0 && localStorage.getItem(STORE_KEY + k.slice(3)) === null)
        localStorage.setItem(STORE_KEY + k.slice(3), localStorage.getItem(k));
    }
    localStorage.setItem(STORE_KEY + "migrated", "1");
  } catch (e) { /* private mode, nothing to carry */ }
})();

var store = {
  get: function (k, d) { try { var v = JSON.parse(localStorage.getItem(STORE_KEY + k)); return v === null ? d : v; } catch (e) { return d; } },
  set: function (k, v) { try { localStorage.setItem(STORE_KEY + k, JSON.stringify(v)); } catch (e) {} },
};
/* One list where there used to be one value: a place can be looked for across
   several continents at once, and the country filter works the same way. */
var asList = function (k, legacy) {
  var v = store.get(k, null);
  if (v && v.length) return v.slice();
  var old = store.get(legacy, "");
  return old ? [old] : [];
};
/* Settling in means nothing without knowing whose passport is travelling. The
   browser's locale is a fair first guess; the visitor can change it anywhere. */
function guessPassport() {
  var have = (window.LIVEABILITY && window.LIVEABILITY.passports) || {};
  var langs = navigator.languages || [navigator.language || ""];
  for (var i = 0; i < langs.length; i++) {
    var m = /[-_]([A-Za-z]{2})\b/.exec(langs[i] || "");
    if (m && have[m[1].toUpperCase()]) return m[1].toUpperCase();
  }
  return have.IN ? "IN" : Object.keys(have)[0] || "";
}

var state = {
  city: store.get("city", null), metric: store.get("metric", "dew_point"),
  period: store.get("period", -1),
  passport: store.get("passport", null) || guessPassport(),
  fahrenheit: store.get("fahrenheit", false), recents: store.get("recents", []),
  minPop: store.get("minPop", 0),
  continents: asList("continents", "continent"),
  countries: asList("countries", "country"),
  // metricKey -> {min, max}; constrains results by other measures too.
  ranges: store.get("ranges", {}),
  favs: store.get("favs", []),
  entry: store.get("entry", "any"),
  // Follow the weather matches on the whole climate, or on one measure alone.
  chaseOn: store.get("chaseOn", "climate"),
};
// How easily the passport gets you in, as a filter shared by every screen.
var ENTRY = {
  any:  { label: "Any entry rules", ok: null },
  easy: { label: "Visa-free, on arrival or e-visa", ok: { F: 1, A: 1, E: 1 } },
  free: { label: "No visa needed ahead", ok: { F: 1, A: 1 } },
};
var POP_TIERS = [[0,"Any size"],[5000,"5k+"],[50000,"50k+"],[250000,"250k+"],[1000000,"1M+"]];

/* One period for the whole app. A measure with no monthly field reads its
   annual figure, but it never overrides what the rest of the screen shows —
   pick July for rainfall, switch to settling in, and July is still July. */
var isAnnualOnly = function (k) { var s = METRICS[k]; return !!(s.statik && !s.monthly); };
var periodFor = function (k) { return isAnnualOnly(k) ? -1 : state.period; };
var periodName = function (p) { return p < 0 ? "the year" : MONTHS[p]; };
var periodLabel = function (p) { return p < 0 ? "Annual" : MONTHS[p]; };

var isTemp = function (m) { return METRICS[m].unit === "°C"; };
var unitOf = function (m) { return isTemp(m) && state.fahrenheit ? "°F" : METRICS[m].unit; };
// Filter inputs speak whatever unit is on screen; state always stores base.
/* Totals rescale with the period — 700 mm is a dry year but a soaking month —
   so the unit has to say which, or the same number means two different things
   depending on which button is lit. */
function filterUnit(key) {
  var spec = METRICS[key], p = periodFor(key);
  var base = (isTemp(key) && state.fahrenheit) ? "°F" : spec.unit;
  if (spec.annual !== "sum") return base;
  return base + (p < 0 ? "/yr" : "/" + MONTHS[p]);
}

var toBase = function (v, m) { return (isTemp(m) && state.fahrenheit) ? (v - 32) * 5 / 9 : v; };
var fromBase = function (v, m) { return (isTemp(m) && state.fahrenheit) ? v * 9 / 5 + 32 : v; };
var roundTo = function (v, m) {
  var f = Math.pow(10, METRICS[m].dp);
  return Math.round(v * f) / f;
};

var fmt = function (v, m) {
  if (v == null || !isFinite(v)) return "—";
  var x = isTemp(m) && state.fahrenheit ? v * 9 / 5 + 32 : v;
  return x.toFixed(METRICS[m].dp);
};
// A gap of 1 degC is 1.8 degF — deltas scale but never take the +32 offset.
var fmtDelta = function (d, m) {
  var x = isTemp(m) && state.fahrenheit ? d * 9 / 5 : d;
  return (x > 0 ? "+" : "") + x.toFixed(METRICS[m].dp);
};

/* The page takes on the character of the place you are looking at: hue runs
   from polar blue through temperate green to desert red as the annual mean
   temperature climbs, and saturation thickens with the dew point. */
var TEMP_HUE = [[-10,214],[0,208],[10,193],[16,158],[21,96],[25,44],[29,22],[34,8]];
var DEW_SAT  = [[2,14],[10,20],[16,28],[20,36],[24,46],[27,54]];

function rampAt(table, x) {
  if (x <= table[0][0]) return table[0][1];
  for (var i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      var a = table[i - 1], b = table[i], t = (x - a[0]) / (b[0] - a[0]);
      return a[1] + t * (b[1] - a[1]);
    }
  }
  return table[table.length - 1][1];
}

/* The sky above the app is the selected city's climate, not the weather.
   Cloud cover and haze follow humidity, rain follows annual rainfall, and the
   sun burns through in proportion to how dry the place is. */
/* Pick the whole palette from the climate. Deliberately coarse and decisive:
   the point is that a hot dry place and a cold wet one look nothing alike. */
/* Light or dark follows the sun over the selected place, not the clock here.
   Solar elevation from latitude, longitude and date, so Reykjavik in June stays
   bright past midnight and polar night stays dark all day — which is the point. */
function solarElevation(lat, lon, when) {
  var d = when || new Date();
  var start = Date.UTC(d.getUTCFullYear(), 0, 0);
  var doy = Math.floor((d.getTime() - start) / 86400000);
  var rad = Math.PI / 180;

  // Declination, and the equation of time so dawn lands within a few minutes.
  var g = 357.53 + 0.9856003 * doy;
  var decl = 23.44 * Math.sin(rad * (360 / 365.24) * (doy - 81));
  var eot = 9.87 * Math.sin(2 * rad * (360 / 365.24) * (doy - 81))
          - 7.53 * Math.cos(rad * (360 / 365.24) * (doy - 81))
          - 1.5 * Math.sin(rad * g);

  var utcH = d.getUTCHours() + d.getUTCMinutes() / 60;
  var solarH = utcH + lon / 15 + eot / 60;
  var H = 15 * (solarH - 12);

  var sinEl = Math.sin(rad * lat) * Math.sin(rad * decl)
            + Math.cos(rad * lat) * Math.cos(rad * decl) * Math.cos(rad * H);
  return Math.asin(Math.max(-1, Math.min(1, sinEl))) / rad;
}

function applyDaylight(city) {
  if (!city) return;
  var elev = solarElevation(city.lat, city.lon);
  // Civil twilight is the changeover: below -6 degrees it is properly night.
  var phase = elev > 0 ? "day" : elev > -6 ? "dusk" : "night";
  document.documentElement.setAttribute("data-daylight", phase);
  var bar = $("#sbSun");
  if (bar) {
    bar.textContent = (phase === "day" ? "☀ Daytime there"
      : phase === "dusk" ? "◑ Twilight there" : "☾ Night there");
    bar.title = "Sun " + (elev >= 0 ? "+" : "") + elev.toFixed(0)
      + "° above the horizon at " + city.name;
  }
}

function climateTheme(t, rain, rh) {
  if (t == null || !isFinite(t)) return "";
  if (t < 1)  return "frozen";
  if (t < 9)  return "cold";
  var wet = (rain != null && rain > 1100) || (rh != null && rh > 76);
  if (t < 17) return wet ? "lush" : "mild";
  if (t < 23) return wet ? "lush" : "warm";
  return wet ? "tropical" : "arid";
}

function applyScene(prof) {
  if (!prof) return;
  var root = document.documentElement.style;
  // The sky shows the period that is selected; a month's rain is scaled to a
  // yearly rate so the same thresholds read both.
  var p = state.period;
  var pick = function (k) {
    var v = prof[k] && (p < 0 ? prof[k].annual : prof[k].months[p]);
    return v != null && isFinite(v) ? v : null;
  };
  var rh = pick("humidity"), t = pick("temperature"), rain = pick("precipitation");
  if (rain != null && p >= 0) rain *= 12;
  var clamp = function (x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; };

  var cloud = rh == null ? 0.45 : clamp((rh - 38) / 46, 0.1, 1);        // 38%->clear, 84%->overcast
  var wet   = rain == null ? 0 : clamp((rain - 450) / 1500, 0, 0.85);   // dry below ~450mm/yr
  var haze  = rh == null ? 0.25 : clamp((rh - 45) / 45, 0.05, 0.7) * (t != null && t > 20 ? 1 : 0.6);
  var sun   = clamp(1 - cloud * 0.8 - wet * 0.35, 0.08, 1);

  root.setProperty("--cloudiness", (cloud * 0.9 + 0.1).toFixed(3));
  root.setProperty("--rainfall", wet.toFixed(3));
  root.setProperty("--hazeness", haze.toFixed(3));
  root.setProperty("--sunniness", sun.toFixed(3));
  drawRain(wet);

  var theme = climateTheme(t, rain, rh);
  if (theme) document.documentElement.setAttribute("data-climate", theme);
  else document.documentElement.removeAttribute("data-climate");
}

// Rain streaks are drawn only when there is rain to show.
function drawRain(intensity) {
  var g = document.querySelector("#sky .rain");
  if (!g) return;
  var want = Math.round(intensity * 90);
  if (g.childNodes.length === want) return;
  g.textContent = "";
  var ns = "http://www.w3.org/2000/svg";
  for (var i = 0; i < want; i++) {
    var x = Math.random() * 1700 - 50, y = Math.random() * 700;
    var len = 12 + Math.random() * 16;
    var ln = document.createElementNS(ns, "line");
    ln.setAttribute("x1", x.toFixed(0)); ln.setAttribute("y1", y.toFixed(0));
    ln.setAttribute("x2", (x - 5).toFixed(0)); ln.setAttribute("y2", (y + len).toFixed(0));
    ln.setAttribute("opacity", (0.25 + Math.random() * 0.45).toFixed(2));
    ln.style.animationDelay = (-Math.random() * 1.05).toFixed(2) + "s";
    g.appendChild(ln);
  }
}

function applyMood(tempC, dewC) {
  var root = document.documentElement.style;
  if (tempC == null || !isFinite(tempC)) {
    root.setProperty("--mood-h", 212);
    root.setProperty("--mood-s", "22%");
    return;
  }
  root.setProperty("--mood-h", rampAt(TEMP_HUE, tempC).toFixed(1));
  root.setProperty("--mood-s",
    (dewC == null || !isFinite(dewC) ? 24 : rampAt(DEW_SAT, dewC)).toFixed(1) + "%");
}

var STAR = '<path d="M12 3.6l2.6 5.3 5.8.85-4.2 4.1 1 5.75L12 16.9l-5.2 2.7 1-5.75-4.2-4.1 5.8-.85z"/>';

var isFav = function (id) {
  for (var i = 0; i < state.favs.length; i++) if (state.favs[i].id === id) return true;
  return false;
};

function toggleFav(city) {
  if (isFav(city.id))
    state.favs = state.favs.filter(function (c) { return c.id !== city.id; });
  else
    state.favs = state.favs.concat([city]);
  store.set("favs", state.favs);
  paintFavCount();
  return isFav(city.id);
}

function paintFavCount() {
  var b = $("#favBtn");
  if (b) {
    b.textContent = state.favs.length ? "★ " + state.favs.length : "☆";
    b.title = state.favs.length
      ? "Compare your " + state.favs.length + " favourite places"
      : "No favourites yet — star a place to add it";
  }
}

/* Liveability for the passport the visitor holds. Entry rules come from the
   full passport x destination matrix; income is stored relative to one
   reference country and re-based onto the passport's own country here, which on
   a log scale is a subtraction. Returns null for anywhere unrated, and the UI
   says "not rated" rather than pretending a gap is a low score. */
var LIV = window.LIVEABILITY || { weights: {}, labels: {}, codes: {}, dests: "", passports: {}, income: {} };
var LIV_DEST = (function () {
  var at = {};
  for (var i = 0; i < LIV.dests.length; i += 2) at[LIV.dests.substr(i, 2)] = i / 2;
  return at;
})();
var livMemo = {};

function visaCode(cc) {
  var row = LIV.passports[state.passport];
  if (!row || !(cc in LIV_DEST)) return null;
  var ch = row.charAt(LIV_DEST[cc]);
  return ch in LIV.codes ? ch : null;
}
var VISA_WORDS = { F: "visa-free", A: "visa on arrival", E: "e-visa", R: "visa required", X: "no entry" };

function livScore(cc) {
  var key = state.passport + ":" + cc;
  if (key in livMemo) return livMemo[key];
  var fields = {}, code = visaCode(cc);
  if (code) fields.visa = LIV.codes[code];
  var inc = LIV.income[cc], home = LIV.income[state.passport];
  if (inc != null && home != null)
    fields.income = Math.max(0, Math.min(100, inc - home + 50));
  var total = 0, used = 0, parts = [];
  Object.keys(LIV.weights).forEach(function (k) {
    var v = fields[k];
    if (v == null || !isFinite(v)) return;       // missing field, not a zero
    var w = LIV.weights[k];
    total += v * w; used += w;
    parts.push({ key: k, label: (LIV.labels || {})[k] || k, value: v });
  });
  return (livMemo[key] = used
    ? { score: Math.round(total / used), parts: parts, visa: code, source: LIV.source || "" }
    : null);
}

function setPassport(cc) {
  if (!LIV.passports[cc] || cc === state.passport) return;
  state.passport = cc;
  store.set("passport", cc);
  LIV_VALUES = null;                 // every settling-in figure just changed
  paintPassport();
}

/* -------------------------------------------------------------- partners */

/* How the site pays for itself: links at the moment someone has decided where
   they would like to be. Every one is something the visitor needs for that
   decision anyway — a dated stay search, the visa their passport needs, cover
   and data for months abroad — and each kind appears only when partners.js
   holds an ID for it, except stays, which are useful unpaid. */
var PARTNERS = window.LIVABLY_PARTNERS || {};
var earning = function () {
  return !!(PARTNERS.bookingAid || PARTNERS.insurance || PARTNERS.esim || PARTNERS.visa);
};

// The next time month m comes round, as a four-week stay; this month starts tomorrow.
function stayDates(m) {
  var now = new Date(), y = now.getFullYear();
  var start = m === now.getMonth() ? new Date(y, m, now.getDate() + 1)
            : new Date(m > now.getMonth() ? y : y + 1, m, 1);
  var end = new Date(start.getTime());
  end.setDate(end.getDate() + 28);
  return [start, end];
}
var isoDate = function (d) {
  var p = function (n) { return (n < 10 ? "0" : "") + n; };
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
};

function stayUrl(c, m) {
  var q = ["ss=" + encodeURIComponent([c.name, c.region, c.country].filter(Boolean).join(", ")),
           "group_adults=1", "no_rooms=1"];
  if (m != null) {
    var d = stayDates(m);
    q.push("checkin=" + isoDate(d[0]), "checkout=" + isoDate(d[1]));
  }
  if (PARTNERS.bookingAid) q.push("aid=" + encodeURIComponent(PARTNERS.bookingAid));
  return "https://www.booking.com/searchresults.html?" + q.join("&");
}

// Paid links say so to search engines; the visible disclosure is in the footer.
function partnerLink(kind, href, text, cls, title) {
  var paid = kind !== "stay" || PARTNERS.bookingAid;
  return '<a class="plink' + (cls ? " " + cls : "") + '" data-partner="' + kind + '"'
    + ' target="_blank" rel="' + (paid ? "sponsored " : "") + 'noopener noreferrer"'
    + (title ? ' title="' + title + '"' : "") + ' href="' + href + '">' + text + "</a>";
}

/* Cookie-free counting, only when a GoatCounter code is set: visits, plus one
   event per partner click, so it is clear which links earn their place. */
if (PARTNERS.goatcounter && /^[a-z0-9-]+$/.test(PARTNERS.goatcounter)) {
  var gc = document.createElement("script");
  gc.async = true;
  gc.src = "https://gc.zgo.at/count.js";
  gc.setAttribute("data-goatcounter", "https://" + PARTNERS.goatcounter + ".goatcounter.com/count");
  document.head.appendChild(gc);
}
document.addEventListener("click", function (e) {
  var a = e.target.closest && e.target.closest("a[data-partner]");
  if (a && window.goatcounter && window.goatcounter.count)
    window.goatcounter.count({ path: "out/" + a.dataset.partner, title: a.textContent, event: true });
});

function paintFooter() {
  var f = $("#foot");
  if (!f) return;
  f.innerHTML = (earning()
      ? "Some links — stays, insurance, eSIMs, visas — may earn Livably a small "
        + "commission, at no cost to you. It never changes a ranking. " : "")
    + (PARTNERS.support ? '<a data-partner="support" target="_blank" rel="noopener noreferrer" href="'
        + PARTNERS.support + '">Support Livably</a> · ' : "")
    + "Climate: ERA5 (Copernicus) · Air: SatPM2.5 · Places: GeoNames · Entry rules: passport-index-data";
}

// Small outward links, on every row as well as the place page.
function linksFor(c) {
  var q = encodeURIComponent([c.name, c.region, c.country].filter(Boolean).join(" "));
  return ' <a class="olink" target="_blank" rel="noopener noreferrer" title="Wikipedia"'
    + ' href="https://en.wikipedia.org/w/index.php?search=' + q + '">W</a>'
    + '<a class="olink" target="_blank" rel="noopener noreferrer" title="Google"'
    + ' href="https://www.google.com/search?q=' + q + '">G</a>';
}

function livBadge(cc) {
  var r = livScore(cc);
  if (!r) return "";
  var band = r.score >= 70 ? "good" : r.score >= 45 ? "mid" : "low";
  return '<span class="liv ' + band + '" title="Settling-in score on a '
    + countryName(state.passport) + " passport"
    + (r.visa ? " (" + VISA_WORDS[r.visa] + ")" : "") + " — " + r.parts.map(function (p) {
        return p.label + " " + p.value;
      }).join(", ") + '">' + r.score + "</span>";
}

var svgIcon = function (inner) {
  return '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
       + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + inner + "</svg>";
};

var phase = function (t) { var e = $("#phase"); if (e) e.textContent = t; };
var lastAnchorValue = null;

function paintStatus() {
  var bar = $("#barStatus");
  if (!bar) return;
  var onStart = $("#start") && !$("#start").hidden;
  bar.hidden = onStart || !state.city;
  if (bar.hidden) return;

  var spec = METRICS[state.metric];
  $("#sbPlace").textContent = state.city.name
    + (state.city.country ? ", " + state.city.country : "");
  $("#sbMetric").innerHTML = svgIcon(spec.icon) + spec.label;
  $("#sbMetric").style.setProperty("--tint", spec.tint);
  $("#sbPeriod").textContent = periodLabel(state.period)
    + (isAnnualOnly(state.metric) && state.period >= 0 ? " (no monthly cycle)" : "");
  $("#sbYear").textContent = NORMALS;
  $("#sbYear").title = "Ten-year climate normals from ERA5 reanalysis";

  // The whole point of a status strip is the number, not just the label.
  var vEl = $("#sbValue");
  if (lastAnchorValue != null && isFinite(lastAnchorValue)) {
    vEl.hidden = false;
    vEl.innerHTML = fmt(lastAnchorValue, state.metric)
      + '<span class="bs-u">' + unitOf(state.metric) + "</span>";
  } else vEl.hidden = true;
  applyDaylight(state.city);

  var bits = [];
  if (state.minPop) bits.push((state.minPop / 1000) + "k+");
  if (state.countries.length) bits.push(summarise(state.countries.map(countryName)));
  else if (state.continents.length) bits.push(summarise(state.continents));
  var nr = activeRanges().length;
  if (nr) bits.push(nr + " range" + (nr === 1 ? "" : "s"));
  if (state.entry !== "any") bits.push(state.entry === "free" ? "no visa ahead" : "easy entry");
  $("#sbFilters").textContent = bits.length ? bits.join(" · ") : "No filters";
  $("#sbClear").hidden = !bits.length;
  $("#sbFilters").hidden = !bits.length;

  var fav = isFav(state.city.id);
  $("#sbFav").textContent = fav ? "★ Saved" : "☆ Save";
  $("#sbFav").classList.toggle("on", fav);
  syncHash();
}

var profileFor = null;           // which place the profile cards were drawn for
function show(name) {
  // Re-anchoring elsewhere moves the place; its page must follow, not linger.
  if (name === "profile" && state.city && profileFor !== state.city.id) return selectCity(state.city);
  ["start", "profile", "compare", "favs", "overall", "chase"].forEach(function (s) { $("#" + s).hidden = s !== name; });
  // Coming back to the place page after changing the month elsewhere: the
  // cards are redrawn for the period that is now selected.
  if (name === "profile" && lastProfile) paintPlace();
  window.scrollTo(0, 0);
  paintStatus();
}
Array.prototype.forEach.call(document.querySelectorAll("[data-goto]"), function (b) {
  b.addEventListener("click", function () { show(b.dataset.goto); });
});

/* ----------------------------------------------------------------- search */

var searchTimer;
$("#q").addEventListener("input", function (e) {
  var q = e.target.value.trim().toLowerCase();
  clearTimeout(searchTimer);
  if (q.length < 2) { $("#suggest").hidden = true; return; }
  searchTimer = setTimeout(function () {
    var hits = [];
    for (var i = 0; i < N && hits.length < 12; i++) {
      var r = rows[i];
      if (r[1].toLowerCase().indexOf(q) === 0 || (r[2] && r[2].toLowerCase().indexOf(q) === 0))
        hits.push(describe(i));
    }
    renderSuggest(hits);
  }, 90);
});

function renderSuggest(hits) {
  var ul = $("#suggest");
  ul.innerHTML = "";
  if (!hits.length) { ul.hidden = true; return; }
  hits.forEach(function (h) {
    var li = document.createElement("li");
    li.innerHTML = '<div>' + h.name + '</div><div class="where">'
      + [h.region, h.country].filter(Boolean).join(", ") + '</div>';
    li.addEventListener("click", function () {
      ul.hidden = true; $("#q").value = ""; selectCity(h);
    });
    ul.appendChild(li);
  });
  ul.hidden = false;
}
document.addEventListener("click", function (e) {
  if (!e.target.closest(".searchwrap")) $("#suggest").hidden = true;
});

/* ------------------------------------------------------------- geolocation */

var note = function (t) { $("#startNote").textContent = t; };
$("#locate").addEventListener("click", function () {
  if (!navigator.geolocation) { note("This browser has no location support — search instead."); return; }
  note("Asking your browser for a location…");
  navigator.geolocation.getCurrentPosition(function (pos) {
    var la = pos.coords.latitude, lo = pos.coords.longitude, best = 0, bestD = Infinity;
    for (var i = 0; i < N; i++) {
      var dy = LAT[i] - la, dx = (LON[i] - lo) * Math.cos(la * Math.PI / 180);
      var d = dy * dy + dx * dx;
      if (d < bestD) { bestD = d; best = i; }
    }
    note(""); selectCity(describe(best));
  }, function () { note("Location declined — search for a place instead."); },
     { timeout: 10000, maximumAge: 600000 });
});

/* ---------------------------------------------------------------- profile */

async function selectCity(city) {
  state.city = city;
  store.set("city", city);
  profileFor = city.id;
  lastProfile = null;                  // the old place's cards are not this one's
  paintStatus();
  state.recents = [city].concat(state.recents.filter(function (c) { return c.id !== city.id; })).slice(0, 6);
  store.set("recents", state.recents);
  renderRecents();

  $("#placeName").textContent = city.name;
  $("#placeMeta").textContent = [city.region, city.country].filter(Boolean).join(", ")
    + (city.pop ? " · population " + city.pop.toLocaleString() : "")
    + " · " + coords(city.lat, city.lon);
  renderPlaceExtras(city);
  paintFavStar(city);
  applyDaylight(city);
  paintProfileSource();
  show("profile");

  // Everything is local now, so the whole profile lands in one pass.
  try {
    var prof = {}, keys = Object.keys(METRICS);
    for (var i = 0; i < keys.length; i++) {
      var months = [];
      for (var m = 0; m < 12; m++) months.push(valuesFor(keys[i], m)[city.idx]);
      prof[keys[i]] = { annual: valuesFor(keys[i], -1)[city.idx], months: months };
    }
    lastProfile = prof;
    paintPlace();
  } catch (err) {
    $("#metricGrid").innerHTML = '<p class="err">' + err.message + "</p>";
  }
  syncHash();
}
var lastProfile = null;

function paintProfileSource() {
  $("#profileSource").textContent = "ERA5 reanalysis, " + NORMALS
    + " monthly normals (ten-year means) · 0.25° grid (~28 km) · annual figures are"
    + " day-weighted means (rainfall is a total) · air quality "
    + (PM25 ? PM25.year : "") + ", SatPM2.5";
}

function coords(la, lo) {
  return Math.abs(la).toFixed(2) + "°" + (la >= 0 ? "N" : "S") + " "
       + Math.abs(lo).toFixed(2) + "°" + (lo >= 0 ? "E" : "W");
}

/* The places most like this one overall — not nearby, but climatically closest.
   Each climate measure is standardised (z-score across every settlement) so
   that millimetres of rain and degrees of dew point carry comparable weight,
   then we take the smallest Euclidean distance in that space. Air and settling
   in are not climate, so they stay out of it. */
function similarPlaces(idx, n) {
  var keys = Object.keys(METRICS).filter(function (k) { return !METRICS[k].statik; });

  // In the selected period: November is matched against November.
  var dims = keys.map(function (k) {
    var v = valuesFor(k, state.period);
    var sum = 0, sq = 0;
    for (var i = 0; i < N; i++) {
      if (!isFinite(v[i])) return null;        // gappy measure sits this out
      sum += v[i]; sq += v[i] * v[i];
    }
    var mean = sum / N;
    var sd = Math.sqrt(Math.max(1e-9, sq / N - mean * mean));
    return { v: v, mean: mean, sd: sd, anchor: (v[idx] - mean) / sd };
  }).filter(Boolean);
  if (!dims.length) return { list: [], used: 0 };

  /* Suburbs of the same city share a grid cell, so they are trivially
     identical and tell you nothing. Skip anything in the immediate vicinity,
     then keep just one result per ~1 degree cell so the list spans real places
     rather than one metropolitan area repeated. Ranking is still purely
     climatic — geography only removes duplicates, it never orders anything. */
  var aLat = LAT[idx], aLon = LON[idx];
  var cosl = Math.cos(aLat * Math.PI / 180);
  var MIN_DEG = 1.35;                      // roughly 150 km
  var pool = n * 12;

  var bestIdx = [], bestD = [];
  for (var i = 0; i < N; i++) {
    if (i === idx) continue;
    var gy = LAT[i] - aLat, gx = (LON[i] - aLon) * cosl;
    if (gy * gy + gx * gx < MIN_DEG * MIN_DEG) continue;
    var d = 0;
    for (var k = 0; k < dims.length; k++) {
      var z = (dims[k].v[i] - dims[k].mean) / dims[k].sd - dims[k].anchor;
      d += z * z;
      if (d > (bestD.length === pool ? bestD[pool - 1] : Infinity)) break;
    }
    if (bestD.length === pool && d >= bestD[pool - 1]) continue;
    var p = bestD.length;
    while (p > 0 && bestD[p - 1] > d) p--;
    bestD.splice(p, 0, d); bestIdx.splice(p, 0, i);
    if (bestD.length > pool) { bestD.pop(); bestIdx.pop(); }
  }

  var seen = {}, out = [];
  for (var q = 0; q < bestIdx.length && out.length < n; q++) {
    var c = bestIdx[q];
    var cell = Math.round(LAT[c]) + "/" + Math.round(LON[c]);
    if (seen[cell]) continue;
    seen[cell] = 1;
    out.push(c);
  }
  return { list: out, used: dims.length };
}

function paintFavStar(city) {
  var b = $("#favStar");
  if (!b) return;
  var on = isFav(city.id);
  b.innerHTML = svgIcon(STAR) + "<span>" + (on ? "Saved" : "Save place") + "</span>";
  b.classList.toggle("on", on);
  b.onclick = function () { toggleFav(city); paintFavStar(city); };
}

function renderPlaceExtras(city) {
  var box = $("#placeExtras");
  box.innerHTML = "";

  // Outward links. Wikipedia goes via search rather than a guessed article
  // title, because duplicate place names would land on the wrong page.
  var q = [city.name, city.region, city.country].filter(Boolean).join(" ");
  var links = document.createElement("div");
  links.className = "pe-links";
  links.innerHTML =
    '<a class="cchip lnk" target="_blank" rel="noopener noreferrer" href="'
      + "https://en.wikipedia.org/w/index.php?search=" + encodeURIComponent(q)
      + '">Wikipedia</a>'
    + '<a class="cchip lnk" target="_blank" rel="noopener noreferrer" href="'
      + "https://www.google.com/search?q=" + encodeURIComponent(q)
      + '">Google</a>'
    + '<a class="cchip lnk" target="_blank" rel="noopener noreferrer" href="'
      + "https://www.google.com/maps/search/?api=1&query="
      + encodeURIComponent(city.lat + "," + city.lon) + '">Map</a>'
    + partnerLink("stay", stayUrl(city, state.period >= 0 ? state.period : null),
                  "Stays" + (state.period >= 0 ? " in " + MONTHS[state.period] : ""), "cchip lnk");
  box.appendChild(links);

  // Ten years, not one: a single year is weather, and a freak summer would
  // move a place. Which ten is fixed when the data is built.
  var yr = el("label", "pe-year");
  yr.innerHTML = "<span>Climate</span>";
  var val = el("span", "cchip", NORMALS);
  val.title = "Ten-year monthly normals from ERA5 reanalysis";
  yr.appendChild(val);
  box.appendChild(yr);
}

function renderSimilar(city) {
  var box = $("#placeSimilar");
  if (!box) return;
  var res = similarPlaces(city.idx, 8);
  box.innerHTML = "";
  if (!res.list.length) return;

  var head = document.createElement("span");
  head.className = "pe-head";
  head.textContent = "Most similar climates"
    + (state.period >= 0 ? " in " + MONTH_NAMES[state.period] : " over the year")
    + " · across " + res.used
    + " measure" + (res.used === 1 ? "" : "s");
  box.appendChild(head);

  var wrap = document.createElement("div");
  wrap.className = "sim-wrap";
  res.list.forEach(function (i) {
    var c = describe(i);
    var b = document.createElement("button");
    b.className = "cchip sim";
    b.type = "button";
    b.innerHTML = "<b>" + c.name + "</b><i>" + c.country + "</i>";
    b.title = "Open " + c.name;
    b.addEventListener("click", function () { selectCity(c); });
    wrap.appendChild(b);
  });
  box.appendChild(wrap);
}

/* Everything on the place page that depends on the selected period, redrawn
   together so the cards, the sky, the similar places and the Follow button
   never disagree about which month is meant. */
function paintPlace() {
  var prof = lastProfile, city = state.city, p = state.period;
  if (!prof || !city) return;
  var at = function (k) { return p < 0 ? prof[k].annual : prof[k].months[p]; };
  applyMood(at("temperature"), at("dew_point"));
  applyScene(prof);
  renderPlacePeriod();
  renderPlaceExtras(city);
  renderSimilar(city);
  renderChaseCta(city);
  renderProfile(prof);
}

// The place page picks the period too; it is the same period every screen reads.
function renderPlacePeriod() {
  var box = $("#placePeriod");
  if (!box) return;
  box.innerHTML = "";
  box.appendChild(el("span", "ctl-k", "Period"));
  var row = el("div", "periods");
  [-1].concat(MONTHS.map(function (_, i) { return i; })).forEach(function (p) {
    var b = el("button", null, p < 0 ? "Year" : MONTHS[p]);
    b.type = "button";
    b.setAttribute("aria-pressed", String(state.period === p));
    b.addEventListener("click", function () {
      if (state.period === p) return;
      state.period = p;
      store.set("period", p);
      paintPlace();
      paintStatus();
    });
    row.appendChild(b);
  });
  box.appendChild(row);
}

function renderProfile(prof) {
  var g = $("#metricGrid");
  g.innerHTML = "";
  Object.keys(METRICS).forEach(function (key) {
    var spec = METRICS[key], d = prof[key];
    if (!d) return;
    // The place page reads the period you picked, like every other screen.
    var p = periodFor(key), value = p < 0 ? d.annual : d.months[p];
    var card = document.createElement("button");
    card.className = "card";
    var tier = spec.comfort ? dewTier(value) : null;
    card.style.setProperty("--tint", spec.tint);
    card.innerHTML =
      '<div class="k"><span class="kic">' + svgIcon(spec.icon) + "</span>" + spec.label
        + (p >= 0 ? " · " + MONTHS[p] : spec.annual === "sum" ? " · yearly total" : "") + '</div>'
      + '<div class="v">' + fmt(value, key) + '<span class="u"> ' + unitOf(key) + '</span></div>'
      + (tier ? '<span class="tier ' + tier.cls + '">' + tier.label + "</span>" : "")
      + (spec.derived ? '<div class="tag">derived</div>' : "");
    if (!spec.statik || spec.monthly) card.appendChild(sparkline(d.months, p));
    else {
      var flat = document.createElement("div");
      flat.className = "tag";
      flat.textContent = "annual figure · no monthly cycle";
      card.appendChild(flat);
    }
    card.addEventListener("click", function () { openCompare(key); });
    g.appendChild(card);
  });
}

function rowSpark(monthly, idx, spec) {
  var vals = [], lo = Infinity, hi = -Infinity;
  for (var m = 0; m < 12; m++) {
    var v = monthly[m][idx];
    vals.push(v);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  var ns = "http://www.w3.org/2000/svg";
  var svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "rowspark");
  svg.setAttribute("viewBox", "0 0 132 30");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  var span = hi - lo || 1;
  var pts = vals.map(function (v, i) {
    return (i / 11 * 130 + 1).toFixed(1) + "," + (27 - (v - lo) / span * 24).toFixed(1);
  });
  var area = document.createElementNS(ns, "polygon");
  area.setAttribute("points", "1,30 " + pts.join(" ") + " 131,30");
  area.setAttribute("fill", "currentColor");
  area.setAttribute("opacity", ".13");
  var line = document.createElementNS(ns, "polyline");
  line.setAttribute("points", pts.join(" "));
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "currentColor");
  line.setAttribute("stroke-width", "1.5");
  line.setAttribute("stroke-linejoin", "round");
  svg.appendChild(area); svg.appendChild(line);
  svg.style.color = spec.tint;
  svg.setAttribute("title", "Jan-Dec range " + fmt(lo, state.metric) + "-" + fmt(hi, state.metric));
  return svg;
}

function sparkline(months, mark) {
  var ns = "http://www.w3.org/2000/svg";
  var svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("viewBox", "0 0 120 34");
  svg.setAttribute("preserveAspectRatio", "none");
  var lo = Math.min.apply(null, months), hi = Math.max.apply(null, months), span = hi - lo || 1;
  var x = function (i) { return i / 11 * 118 + 1; };
  var y = function (v) { return 31 - (v - lo) / span * 28; };
  var line = document.createElementNS(ns, "polyline");
  line.setAttribute("points", months.map(function (v, i) {
    return x(i) + "," + y(v);
  }).join(" "));
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "currentColor");
  line.setAttribute("stroke-width", "1.6");
  line.setAttribute("opacity", ".55");
  svg.appendChild(line);

  /* The month on the card is the month on the curve. A stem rather than a dot,
     because the sparkline is drawn with preserveAspectRatio="none" and a circle
     would come out as an ellipse. */
  if (mark != null && mark >= 0) {
    var stem = document.createElementNS(ns, "line");
    stem.setAttribute("x1", x(mark)); stem.setAttribute("x2", x(mark));
    stem.setAttribute("y1", y(months[mark])); stem.setAttribute("y2", 33);
    stem.setAttribute("stroke", "currentColor");
    stem.setAttribute("stroke-width", "1.6");
    svg.appendChild(stem);
  }
  return svg;
}

/* ------------------------------------------------------------- comparison */

function openCompare(metric) {
  state.metric = metric;
  store.set("metric", metric);
  paintStatus();
  show("compare");
  if (ctl("#cmpControls")) ctl("#cmpControls").paint();
  else renderControls($("#cmpControls"), { measure: true, rerun: runCompare });
  runCompare();
}

// Continents and countries actually present in the catalogue, named not coded.
var CONTINENTS = (function () {
  var seen = {};
  Object.keys(COUNTRIES).forEach(function (cc) {
    var c = COUNTRIES[cc][1]; if (c) seen[c] = 1;
  });
  return Object.keys(seen).sort();
})();

function countryName(cc) { return (COUNTRIES[cc] || [cc])[0]; }

// Countries within the chosen continents — or all of them, if none is chosen.
function countryList(continents) {
  var want = setOf(continents || []);
  return Object.keys(COUNTRIES)
    .filter(function (cc) { return !continents.length || want[COUNTRIES[cc][1]]; })
    .map(function (cc) { return [cc, COUNTRIES[cc][0]]; })
    .sort(function (a, b) { return a[1] < b[1] ? -1 : 1; });
}

function setOf(list) {
  var s = {};
  for (var i = 0; i < list.length; i++) s[list[i]] = 1;
  return s;
}
function summarise(names) {
  if (!names.length) return "";
  if (names.length <= 2) return names.join(" + ");
  return names[0] + " +" + (names.length - 1);
}

// Display filters. They decide which rows are worth showing; every place is
// always ranked and the anchor's value never changes.
function rowFilter(bounds) {
  var minPop = state.minPop;
  var cc = state.countries.length ? setOf(state.countries) : null;
  var cont = state.continents.length ? setOf(state.continents) : null;
  var entry = ENTRY[state.entry] ? ENTRY[state.entry].ok : null, entryMemo = {};
  return function (i) {
    var r = rows[i];
    if (minPop && r[7] < minPop) return false;
    if (cc) { if (!cc[r[4]]) return false; }
    else if (cont) { var m = COUNTRIES[r[4]]; if (!m || !cont[m[1]]) return false; }
    if (entry) {
      if (!(r[4] in entryMemo)) entryMemo[r[4]] = !!entry[visaCode(r[4])];
      if (!entryMemo[r[4]]) return false;
    }
    for (var b = 0; b < bounds.length; b++) {
      var v = bounds[b].values[i];
      if (bounds[b].min != null && v < bounds[b].min) return false;
      if (bounds[b].max != null && v > bounds[b].max) return false;
    }
    return true;
  };
}

var anyFilter = function () {
  return !!(state.minPop || state.continents.length || state.countries.length
            || state.entry !== "any" || activeRanges().length);
};

function clearFilters() {
  state.minPop = 0; state.continents = []; state.countries = []; state.ranges = {};
  state.entry = "any";
  store.set("minPop", 0); store.set("continents", []); store.set("countries", []);
  store.set("ranges", {}); store.set("entry", "any");
}

/* Each constraining measure needs its own layer, loaded on demand — and each
   is read for the period on screen, so a July comparison is refined by July
   figures. A measure with no monthly cycle contributes its annual value. */
function activeBounds(period) {
  var p0 = period == null ? state.period : period;
  return activeRanges().map(function (r) {
    return { values: valuesFor(r.metric, isAnnualOnly(r.metric) ? -1 : p0), min: r.min, max: r.max };
  });
}

// Which other measures are currently constraining the result.
function activeRanges() {
  var out = [];
  Object.keys(state.ranges).forEach(function (k) {
    var r = state.ranges[k];
    if (!METRICS[k] || !r) return;
    if (r.min == null && r.max == null) return;
    out.push({ metric: k, min: r.min, max: r.max });
  });
  return out;
}

/* --------------------------------------------------------------- controls */

function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/* A pill that opens a checklist. Continents and countries use the same one, so
   picking three of either feels identical; a long list gets a filter box. */
var closePopover = null;
document.addEventListener("click", function (e) {
  if (closePopover && !e.target.closest(".mpick")) closePopover();
});
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape" && closePopover) closePopover();
});

function multiPicker(o) {
  // o: {empty, title, options:[[value,name]], selected, search, onChange}
  var wrap = el("div", "mpick");
  var btn = el("button", "pill mp-btn");
  btn.type = "button";
  var pop = el("div", "mp-pop");
  pop.hidden = true;

  var chosen = setOf(o.selected), boxes = [], commit;

  var paintBtn = function () {
    var names = o.options.filter(function (p) { return chosen[p[0]]; })
                         .map(function (p) { return p[1]; });
    btn.textContent = names.length ? summarise(names) : o.empty;
    btn.classList.toggle("on", names.length > 0);
    btn.title = names.length ? names.join(", ") : o.title;
    count.textContent = names.length
      ? names.length + " selected" : "Nothing selected — everywhere counts";
  };

  var head = el("div", "mp-head");
  var count = el("span", "mp-count");
  var clr = el("button", "linkish", "Clear");
  clr.type = "button";
  clr.addEventListener("click", function () {
    chosen = {};
    boxes.forEach(function (b) { b.cb.checked = false; });
    commit();
  });
  head.appendChild(count);
  head.appendChild(clr);
  pop.appendChild(head);

  if (o.search) {
    var s = document.createElement("input");
    s.type = "search";
    s.className = "mp-search";
    s.placeholder = "Filter list…";
    s.addEventListener("input", function () {
      var q = s.value.trim().toLowerCase();
      boxes.forEach(function (b) { b.lab.hidden = !!q && b.name.indexOf(q) < 0; });
    });
    pop.appendChild(s);
  }

  var listBox = el("div", "mp-list");
  o.options.forEach(function (p) {
    var lab = el("label", "mp-opt");
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!chosen[p[0]];
    cb.addEventListener("change", function () {
      if (cb.checked) chosen[p[0]] = 1; else delete chosen[p[0]];
      commit();
    });
    lab.appendChild(cb);
    lab.appendChild(el("span", null, p[1]));
    boxes.push({ cb: cb, lab: lab, name: p[1].toLowerCase() });
    listBox.appendChild(lab);
  });
  pop.appendChild(listBox);

  commit = function () {
    paintBtn();
    o.onChange(o.options.filter(function (p) { return chosen[p[0]]; })
                        .map(function (p) { return p[0]; }));
  };

  btn.addEventListener("click", function () {
    var opening = pop.hidden;
    if (closePopover) closePopover();
    if (!opening) return;
    pop.hidden = false;
    closePopover = function () { pop.hidden = true; closePopover = null; };
  });

  paintBtn();
  wrap.appendChild(btn);
  wrap.appendChild(pop);
  return wrap;
}

/* Every screen is driven by the same controls, built here once: the period,
   the measure, which places count as places, and the range filters. Comparing
   one measure, reading your favourites and reading the overall ranking all
   obey the same selection — and a measure added to METRICS later inherits the
   whole apparatus without a second implementation. */
var refineOpen = false, refineTimer;

function renderControls(host, o) {
  // o: {measure: bool, rerun: fn}
  host.innerHTML = "";
  var unitEls = {}, periodBtns = [];

  var top = el("div", "ctl-row");
  top.appendChild(el("span", "ctl-k", "Period"));
  var periods = el("div", "periods");
  var mk = function (label, p) {
    var b = el("button", null, label);
    b.type = "button";
    b.addEventListener("click", function () {
      if (state.period === p) return;
      state.period = p;
      store.set("period", p);
      paint();
      paintStatus();
      o.rerun();
    });
    periods.appendChild(b);
    periodBtns.push([b, p]);
  };
  // Follow-the-weather spans all twelve months, so it has no period to pick.
  if (o.period !== false) {
    mk("Year", -1);
    MONTHS.forEach(function (m, i) { mk(m, i); });
    top.appendChild(periods);
  }

  var measureSel = null;
  if (o.measure) {
    measureSel = el("select", "pill");
    measureSel.title = "Measure";
    Object.keys(METRICS).forEach(function (k) {
      var op = el("option", null, METRICS[k].label);
      op.value = k;
      op.selected = k === state.metric;
      measureSel.appendChild(op);
    });
    measureSel.addEventListener("change", function () {
      state.metric = measureSel.value;
      store.set("metric", state.metric);
      paint();
      paintStatus();
      o.rerun();
    });
    top.appendChild(measureSel);
  }
  if (top.childNodes.length > 1) host.appendChild(top);

  var note = el("p", "ctl-note");
  host.appendChild(note);

  var filters = el("div", "ctl-row");
  host.appendChild(filters);

  var buildFilters = function () {
    filters.innerHTML = "";
    filters.appendChild(el("span", "ctl-k", "Places"));

    var size = el("select", "pill");
    size.title = "Only show places at least this big";
    POP_TIERS.forEach(function (t) {
      var op = el("option", null, t[1]);
      op.value = t[0];
      op.selected = +t[0] === +state.minPop;
      size.appendChild(op);
    });
    size.addEventListener("change", function () {
      state.minPop = +size.value;
      store.set("minPop", state.minPop);
      paint();
      paintStatus();
      o.rerun();
    });
    filters.appendChild(size);

    filters.appendChild(multiPicker({
      empty: "Anywhere", title: "Limit to one or more continents",
      options: CONTINENTS.map(function (c) { return [c, c]; }),
      selected: state.continents,
      onChange: function (list) {
        state.continents = list;
        store.set("continents", list);
        // A country belongs to a continent: drop any that no longer qualifies.
        var keep = setOf(countryList(list).map(function (p) { return p[0]; }));
        state.countries = state.countries.filter(function (cc) { return keep[cc]; });
        store.set("countries", state.countries);
        // Only the country list is stale — rebuilding the row here would
        // close the continent list under the finger still ticking it.
        buildCountries();
        paint();
        paintStatus();
        o.rerun();
      },
    }));

    filters.appendChild(countrySlot);
    buildCountries();

    // Somewhere you cannot get into is not an option, however good the weather.
    var entry = el("select", "pill");
    entry.title = "Only places your passport can enter this easily";
    Object.keys(ENTRY).forEach(function (k) {
      var op = el("option", null, ENTRY[k].label);
      op.value = k;
      op.selected = k === state.entry;
      entry.appendChild(op);
    });
    entry.addEventListener("change", function () {
      state.entry = entry.value;
      store.set("entry", state.entry);
      paint();
      paintStatus();
      o.rerun();
    });
    entry.classList.toggle("on", state.entry !== "any");
    filters.appendChild(entry);

    var clr = el("button", "linkish ctl-clear", "Clear filters");
    clr.type = "button";
    clr.addEventListener("click", function () {
      clearFilters();
      renderControls(host, o);       // ranges live in the refine panel too
      paintStatus();
      o.rerun();
    });
    filters.appendChild(clr);
  };

  var countrySlot = el("span", "mpick-slot");
  var buildCountries = function () {
    countrySlot.innerHTML = "";
    countrySlot.appendChild(multiPicker({
      empty: state.continents.length ? "All of " + summarise(state.continents)
                                     : "Any country",
      title: "Limit to one or more countries", search: true,
      options: countryList(state.continents),
      selected: state.countries,
      onChange: function (list) {
        state.countries = list;
        store.set("countries", list);
        paint();
        paintStatus();
        o.rerun();
      },
    }));
  };
  buildFilters();

  /* Range filters over every other measure. They read the period on screen,
     which is why each row says which unit and which month it means. */
  var refine = el("details", "refine");
  refine.open = refineOpen;
  refine.addEventListener("toggle", function () { refineOpen = refine.open; });
  var summary = el("summary");
  var summaryLabel = el("span");
  summary.appendChild(summaryLabel);
  refine.appendChild(summary);
  var body = el("div", "refine-body");
  refine.appendChild(body);
  host.appendChild(refine);

  Object.keys(METRICS).forEach(function (key) {
    var spec = METRICS[key], r = state.ranges[key] || {};
    var wrap = el("div", "rf");
    wrap.innerHTML =
      '<span class="rf-ic" style="color:' + spec.tint + '">' + svgIcon(spec.icon) + "</span>"
      + '<span class="rf-l">' + spec.label + "</span>"
      + '<input class="rf-i" type="number" step="any" placeholder="min"'
        + (r.min != null ? ' value="' + roundTo(fromBase(r.min, key), key) + '"' : "") + ">"
      + '<input class="rf-i" type="number" step="any" placeholder="max"'
        + (r.max != null ? ' value="' + roundTo(fromBase(r.max, key), key) + '"' : "") + ">"
      + '<span class="rf-u"></span>';
    unitEls[key] = wrap.querySelector(".rf-u");
    var ins = wrap.querySelectorAll(".rf-i");
    var upd = function () {
      state.ranges[key] = {
        min: ins[0].value === "" ? null : toBase(+ins[0].value, key),
        max: ins[1].value === "" ? null : toBase(+ins[1].value, key),
      };
      store.set("ranges", state.ranges);
      paint();
      paintStatus();
      clearTimeout(refineTimer);
      refineTimer = setTimeout(o.rerun, 350);      // settle before recomputing
    };
    ins[0].addEventListener("change", upd);
    ins[1].addEventListener("change", upd);
    ins[0].addEventListener("input", upd);
    ins[1].addEventListener("input", upd);
    body.appendChild(wrap);
  });

  var clrRanges = el("button", "linkish", "Clear all ranges");
  clrRanges.type = "button";
  clrRanges.addEventListener("click", function () {
    state.ranges = {};
    store.set("ranges", {});
    renderControls(host, o);
    paintStatus();
    o.rerun();
  });
  body.appendChild(clrRanges);

  function paint() {
    periodBtns.forEach(function (pair) {
      pair[0].setAttribute("aria-pressed", String(state.period === pair[1]));
    });
    if (measureSel) measureSel.value = state.metric;

    var annual = o.measure && isAnnualOnly(state.metric) && state.period >= 0;
    note.textContent = annual
      ? METRICS[state.metric].label + " has no monthly cycle, so it reads its annual "
        + "figure — " + MONTHS[state.period] + " still applies to the filters and to "
        + "every other measure."
      : "";
    note.hidden = !annual;

    Object.keys(unitEls).forEach(function (k) {
      unitEls[k].textContent = filterUnit(k);
    });

    var n = activeRanges().length;
    summaryLabel.textContent =
      (n ? "Refine — " + n + " active" : "Refine by other measures")
      + (o.period === false ? " · applied month by month"
                            : " · applied to " + periodName(state.period));
    refine.classList.toggle("on", n > 0);

    var clearBtn = filters.querySelector(".ctl-clear");
    if (clearBtn) clearBtn.hidden = !anyFilter();
  }

  paint();
  var api = { paint: paint, rebuild: function () { renderControls(host, o); } };
  host.__ctl = api;
  return api;
}

var ctl = function (sel) { var h = $(sel); return h && h.__ctl; };

/* Favourites, side by side on one measure. Same indexes as everything else,
   so this costs no extra network once a measure is loaded. */
var favSeq = 0;
async function showFavourites() {
  var mine = ++favSeq;
  show("favs");
  if (ctl("#favControls")) ctl("#favControls").paint();
  else renderControls($("#favControls"), { measure: true, rerun: showFavourites });

  var box = $("#favResults");
  if (!state.favs.length) {
    box.innerHTML = '<p class="meta">No favourites yet. Open a place and press '
      + "“Save place” to add it here.</p>";
    $("#favSource").textContent = "";
    return;
  }
  box.innerHTML = '<p class="meta">Loading…</p>';

  var spec = METRICS[state.metric], period = periodFor(state.metric);
  $("#favSub").textContent = spec.label + " · "
    + (period < 0 ? "annual" : MONTHS[period]) + " · " + NORMALS;

  var index = await buildIndex(state.metric, period);
  var bounds = activeBounds();
  if (mine !== favSeq) return;

  // The same filters as everywhere else — a favourite outside them is set
  // aside rather than silently dropped, because you chose these places.
  var pass = rowFilter(bounds), shown = [], hidden = 0;
  state.favs.forEach(function (c) {
    if (pass(c.idx)) shown.push({ city: c, value: index.values[c.idx] });
    else hidden++;
  });
  shown.sort(function (a, b) { return a.value - b.value; });

  box.innerHTML = "";
  if (!shown.length) {
    box.innerHTML = '<p class="meta">All ' + hidden + " of your favourites are outside "
      + "the current filters.</p>";
  }
  var lo = shown.length ? shown[0].value : 0;
  var hi = shown.length ? shown[shown.length - 1].value : 1;
  var span = hi - lo || 1;
  var anchorValue = state.city ? index.values[state.city.idx] : null;

  shown.forEach(function (r) {
    box.appendChild(placeRow(r.city, {
      cls: "fav", value: r.value, anchorValue: anchorValue,
      anchor: !!(state.city && state.city.id === r.city.id),
      bar: 12 + (r.value - lo) / span * 88,
      onAnchor: function (c) { reanchor(c, showFavourites); },
      onRemove: function (c) { toggleFav(c); showFavourites(); },
    }));
  });

  if (hidden) {
    var p = el("p", "meta");
    p.textContent = hidden + " favourite" + (hidden === 1 ? " is" : "s are")
      + " hidden by the current filters. ";
    var clr = el("button", "linkish", "Clear filters");
    clr.type = "button";
    clr.addEventListener("click", function () {
      clearFilters();
      if (ctl("#favControls")) ctl("#favControls").rebuild();
      paintStatus();
      showFavourites();
    });
    p.appendChild(clr);
    box.appendChild(p);
  }

  $("#favSource").textContent = "Ranked among your saved places only, on the same "
    + "measure and period as every other screen. ERA5 reanalysis, "
    + NORMALS + " normals, 0.25° grid"
    + (spec.derived ? " · derived value" : "");
}

/* Overall ranking: one score per place, from every parameter at once.
 *
 * Each component becomes a PERCENTILE before blending, so measures in wildly
 * different units (mm of rain, ug/m3, a 0-100 score) contribute on equal terms
 * and none can dominate through sheer magnitude.
 *
 *   climate   how close this place is to yours across all climate measures
 *   air       cleaner is better
 *   settling  easier entry and higher income is better
 */
var ovWeights = store.get("ovWeights", { climate: 3, air: 2, settling: 2 });

function percentiles(values, invert) {
  var n = values.length, idx = [], i;
  for (i = 0; i < n; i++) if (isFinite(values[i])) idx.push(i);
  idx.sort(function (a, b) { return values[a] - values[b]; });
  var out = new Float32Array(n);
  for (i = 0; i < n; i++) out[i] = NaN;
  for (i = 0; i < idx.length; i++)
    out[idx[i]] = 100 * (invert ? 1 - (idx.length > 1 ? i / (idx.length - 1) : 1)
                                : (idx.length > 1 ? i / (idx.length - 1) : 1));
  return out;
}

var ovSeq = 0;
async function showOverall() {
  var mine = ++ovSeq;
  show("overall");
  renderOvWeights();
  if (ctl("#ovControls")) ctl("#ovControls").paint();
  else renderControls($("#ovControls"), { measure: false, rerun: showOverall });
  if (!state.city) return;
  $("#ovProgress").hidden = false;
  $("#ovResults").innerHTML = "";
  await new Promise(function (r) { setTimeout(r, 0); });

  var anchor = state.city.idx, comps = [], names = [], i, k;

  // 1. climate similarity, standardised across every climate measure
  var climKeys = Object.keys(METRICS).filter(function (m) { return !METRICS[m].statik; });
  var dims = [];
  for (k = 0; k < climKeys.length; k++) {
    var v = valuesFor(climKeys[k], periodFor(climKeys[k]));
    var sum = 0, sq = 0, bad = false;
    for (i = 0; i < N; i++) {
      if (!isFinite(v[i])) { bad = true; break; }
      sum += v[i]; sq += v[i] * v[i];
    }
    if (bad) continue;
    var mean = sum / N, sd = Math.sqrt(Math.max(1e-9, sq / N - mean * mean));
    dims.push({ v: v, mean: mean, sd: sd, a: (v[anchor] - mean) / sd });
  }
  if (dims.length) {
    var dist = new Float32Array(N);
    for (i = 0; i < N; i++) {
      var d = 0;
      for (k = 0; k < dims.length; k++) {
        var z = (dims[k].v[i] - dims[k].mean) / dims[k].sd - dims[k].a;
        d += z * z;
      }
      dist[i] = d;
    }
    comps.push({ key: "climate", pct: percentiles(dist, true) });
    names.push(dims.length + " climate measures");
  }

  // Air follows the period like everywhere else; settling in has no months.
  if (PM25) {
    comps.push({ key: "air", pct: percentiles(valuesFor("air_quality", periodFor("air_quality")), true) });
    names.push("air quality");
  }

  var lv = livValues(), anyLiv = false;
  for (i = 0; i < N; i++) if (isFinite(lv[i])) { anyLiv = true; break; }
  if (anyLiv) { comps.push({ key: "settling", pct: percentiles(lv, false) }); names.push("settling in"); }
  if (mine !== ovSeq) return;

  var wsum = 0;
  comps.forEach(function (c) { wsum += (ovWeights[c.key] || 0); });
  if (!wsum) wsum = 1;

  var score = new Float32Array(N), pass = rowFilter(activeBounds());
  if (mine !== ovSeq) return;
  for (i = 0; i < N; i++) {
    var tot = 0, ok = true;
    for (k = 0; k < comps.length; k++) {
      var pv = comps[k].pct[i];
      if (!isFinite(pv)) { ok = false; break; }
      tot += pv * (ovWeights[comps[k].key] || 0);
    }
    score[i] = ok ? tot / wsum : NaN;
  }

  var order = [];
  for (i = 0; i < N; i++) if (isFinite(score[i]) && pass(i)) order.push(i);
  order.sort(function (a, b) { return score[b] - score[a]; });

  // One place per ~1 degree cell, so the table is not one metro area repeated.
  var seen = {}, top = [];
  for (i = 0; i < order.length && top.length < 60; i++) {
    var cell = Math.round(LAT[order[i]]) + "/" + Math.round(LON[order[i]]);
    if (seen[cell]) continue;
    seen[cell] = 1; top.push(order[i]);
  }

  $("#ovProgress").hidden = true;
  $("#ovSub").textContent = "Every place scored on " + names.join(", ")
    + " \u00b7 relative to " + state.city.name
    + " \u00b7 " + (state.period < 0 ? "annual" : MONTHS[state.period]) + " \u00b7 " + NORMALS;

  var box = $("#ovResults");
  box.innerHTML = "";
  if (!top.length)
    box.innerHTML = '<p class="meta">No place matches the current filters.</p>';
  top.forEach(function (idx, rank) {
    var c = describe(idx);
    box.appendChild(placeRow(c, {
      cls: "ov", anchor: idx === anchor, rank: rank + 1,
      valueText: score[idx].toFixed(0), unitText: "/100", tier: false,
      parts: comps.map(function (cm) {
        return '<span class="ovpart"><i>' + cm.key.slice(0, 3) + "</i>"
          + Math.round(cm.pct[idx]) + "</span>";
      }).join(""),
      onAnchor: function (city) { reanchor(city, showOverall); },
    }));
  });

  $("#ovSource").textContent = "Each component becomes a percentile before blending, "
    + "so units never dominate. Climate similarity is measured against "
    + state.city.name + "; air quality and settling-in are absolute. "
    + "Same period and filters as every other screen. "
    + "One place per ~1\u00b0 cell. Weights are yours to change.";
}

function renderOvWeights() {
  var box = $("#ovWeights");
  box.innerHTML = "";
  var defs = [["climate", "Climate match"], ["air", "Clean air"], ["settling", "Settling in"]];
  defs.forEach(function (pair) {
    var lab = document.createElement("label");
    lab.className = "ovw";
    lab.innerHTML = "<span>" + pair[1] + "</span>";
    var inp = document.createElement("input");
    inp.type = "range"; inp.min = 0; inp.max = 5; inp.step = 1;
    inp.value = ovWeights[pair[0]] || 0;
    inp.addEventListener("change", function () {
      ovWeights[pair[0]] = +inp.value;
      store.set("ovWeights", ovWeights);
      showOverall();
    });
    lab.appendChild(inp);
    box.appendChild(lab);
  });
}

/* Air quality used to arrive twice on a row: once as the ranked PM2.5 chip
   every measure gets, and again as a live Open-Meteo reading on a dashed pill.
   Two numbers for one thing, on different bases, is worse than one — so the
   live pill is gone and air quality behaves like every other measure. */

var compareSeq = 0;
async function runCompare() {
  var mine = ++compareSeq, spec = METRICS[state.metric];
  $("#progress").hidden = false;
  phase("Preparing");

  // Liveability is genuinely annual-only; air quality has monthly fields.
  var period = periodFor(state.metric);
  $("#cmpTitle").textContent = spec.label + " closest to " + state.city.name;
  $("#cmpSub").textContent = (isAnnualOnly(state.metric) ? "annual only" :
      period < 0 ? "annual" : MONTHS[period]) + " · " + NORMALS;
  // Liking one figure in one month is exactly what Follow the weather keeps.
  var fb = $("#cmpFollow");
  fb.hidden = !MATCH[state.metric];
  fb.textContent = "Follow this " + spec.label.toLowerCase()
    + (period >= 0 ? " in " + MONTH_NAMES[period] : "") + " all year →";

  try {
    var index = await buildIndex(state.metric, period);
    var bounds = activeBounds();
    if (mine !== compareSeq) return;          // a newer request owns the screen

    // Monthly shape of the active metric — same layer, so this costs no network.
    var monthly = null;
    if (!spec.statik || spec.monthly) {
      monthly = [];
      for (var mm = 0; mm < 12; mm++)
        monthly.push(valuesFor(state.metric, mm));
    }

    // Every other measure rides along on the row; it is all local.
    var extras = [];
    Object.keys(METRICS).forEach(function (k) {
      if (k !== state.metric) extras.push({ key: k, values: valuesFor(k, periodFor(k)) });
    });
    if (mine !== compareSeq) return;

    var anchor = index.values[state.city.idx];
    lastAnchorValue = anchor;
    paintStatus();               // header strip must not lag a period behind
    if (state.metric === "temperature") applyMood(anchor, null);
    else if (state.metric === "dew_point") applyMood(null, anchor);
    applyDaylight(state.city);
    var nb = neighbours(index, state.city.idx, 10, rowFilter(bounds), spec.dp);
    $("#progress").hidden = true;
    renderResults(index, anchor, nb, monthly, extras);
  } catch (err) {
    if (mine !== compareSeq) return;
    $("#progress").hidden = true;
    // The error slot is hidden until there is an error to put in it, and the
    // stale columns come down with it — half a comparison is a lie.
    $("#anchorSlot").innerHTML = "";
    $("#lowerCol").innerHTML = ""; $("#higherCol").innerHTML = "";
    $("#lowerBand").textContent = ""; $("#higherBand").textContent = "";
    $("#results").hidden = false;
    $("#results").innerHTML = '<p class="err">' + err.message + "</p>";
  } finally {
    // Whoever is newest owns the spinner; stale runs must not strand it.
    if (mine === compareSeq) $("#progress").hidden = true;
  }
}

/* One row for a place, wherever a place appears. Same anatomy and the same
   click behaviour everywhere: the row itself re-anchors, Details opens the
   place, the star saves it, and a chip switches measure without moving. */
var rowsOnScreen = [];
function placeRow(c, o) {
  var m = o.metricKey || state.metric, spec = METRICS[m];
  var value = o.value;
  var wrap = el("div", "row" + (o.cls ? " " + o.cls : "") + (o.anchor ? " anchor" : ""));
  var tier = (o.tier !== false && spec.comfort && isFinite(value)) ? dewTier(value) : null;
  var shared = o.shared
    ? ' <span class="wh">+' + o.shared.toLocaleString() + " more at this value</span>" : "";

  // A div rather than a button, so the row's own controls can nest inside it.
  wrap.innerHTML =
    (o.rank ? '<div class="ovrank">' + o.rank + "</div>" : "")
    + '<div class="who"><div class="nm">' + c.name + livBadge(c.cc)
      + (tier ? ' <span class="tier ' + tier.cls + '">' + tier.label + "</span>" : "")
    + '</div><div class="wh">' + [c.region, c.country].filter(Boolean).join(", ")
      + shared + linksFor(c) + '</div><div class="chips"></div></div>'
    + (o.monthly ? '<div class="spark-cell"></div>' : "")
    + (o.bar != null ? '<div class="favbar"><span style="width:'
        + o.bar.toFixed(1) + '%"></span></div>' : "")
    + (o.parts ? '<div class="ovparts">' + o.parts + "</div>" : "")
    + '<div class="val">' + (o.valueText != null ? o.valueText : fmt(value, m))
      + '<span class="vu">' + (o.unitText != null ? o.unitText : unitOf(m)) + "</span></div>"
    + ("anchorValue" in o
        ? '<div class="dl">' + (o.anchor ? "here"
            : o.anchorValue == null || !isFinite(value) ? "—"
            : fmtDelta(value - o.anchorValue, m)) + "</div>" : "")
    + '<button class="rowfav" type="button"></button>'
    + '<button class="details" type="button" title="Every measure for this place">Details</button>'
    + (o.onRemove ? '<button class="details drop" type="button" title="Remove">✕</button>' : "");

  var star = wrap.querySelector(".rowfav");
  star.innerHTML = svgIcon(STAR);
  var paintStar = function () {
    var on = isFav(c.id);
    star.classList.toggle("on", on);
    star.title = on ? "Saved — click to remove" : "Save this place";
  };
  paintStar();
  star.addEventListener("click", function (ev) {
    ev.stopPropagation();                // starring is not a re-anchor
    toggleFav(c);
    paintStar();
    paintStatus();
  });

  // Chips for whatever else is already known about this place.
  if (o.extras && o.extras.length) {
    var chips = wrap.querySelector(".chips");
    o.extras.forEach(function (x) {
      var sp = el("button", "chip");
      sp.type = "button";
      sp.style.setProperty("--tint", METRICS[x.key].tint);
      sp.innerHTML = svgIcon(METRICS[x.key].icon)
        + "<b>" + fmt(x.values[c.idx], x.key) + "</b>"
        + "<i>" + unitOf(x.key) + "</i>";
      sp.title = "Compare " + METRICS[x.key].label.toLowerCase() + " from " + c.name;
      sp.addEventListener("click", function (ev) {
        ev.stopPropagation();              // not a re-anchor on the old measure
        state.city = c;
        store.set("city", c);
        openCompare(x.key);                // same place, different measure
      });
      chips.appendChild(sp);
    });
  }
  if (o.monthly) wrap.querySelector(".spark-cell").appendChild(rowSpark(o.monthly, c.idx, spec));

  wrap.querySelector(".details").addEventListener("click", function (ev) {
    ev.stopPropagation();                  // don't also re-anchor
    selectCity(c);
  });
  var drop = wrap.querySelector(".drop");
  if (drop) drop.addEventListener("click", function (ev) {
    ev.stopPropagation();
    o.onRemove(c);
  });

  if (!o.anchor && o.onAnchor) {
    wrap.tabIndex = 0;
    wrap.title = "Measure everything from " + c.name + " instead";
    wrap.addEventListener("click", function (ev) {
      if (ev.target.closest("a,button")) return;   // links and buttons act alone
      o.onAnchor(c);
    });
    wrap.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); o.onAnchor(c); }
    });
  }
  rowsOnScreen.push({ c: c, el: wrap });
  return wrap;
}

function renderResults(index, anchor, nb, monthly, extras) {
  var m = state.metric, spec = METRICS[m];
  var slot = $("#anchorSlot"), lowBox = $("#lowerCol"), highBox = $("#higherCol");
  slot.innerHTML = ""; lowBox.innerHTML = ""; highBox.innerHTML = "";
  $("#results").hidden = true;
  rowsOnScreen = [];

  var row = function (entry, isAnchor) {
    var idx = isAnchor ? state.city.idx : entry.idx;
    return placeRow(describe(idx), {
      value: index.values[idx], anchorValue: anchor, anchor: isAnchor,
      shared: isAnchor ? 0 : entry.shared, monthly: monthly, extras: extras,
      onAnchor: function (city) { reanchor(city, runCompare); },
    });
  };


  // Your place sits on top; the two directions read away from it in parallel.
  slot.appendChild(row(null, true));

  $("#lowerBand").textContent = nb.below.length
    ? "Lower \u2014 " + nb.below.length + " steps down" : "Nothing lower";
  $("#higherBand").textContent = nb.above.length
    ? "Higher \u2014 " + nb.above.length + " steps up" : "Nothing higher";

  nb.below.forEach(function (e) { lowBox.appendChild(row(e, false)); });
  nb.above.forEach(function (e) { highBox.appendChild(row(e, false)); });

  $("#cmpSource").textContent =
    "Ranked against all " + N.toLocaleString() + " settlements in the GeoNames catalogue, "
    + "purely by " + spec.label.toLowerCase() + " value. ERA5 reanalysis, " + NORMALS
    + " normals, 0.25° grid" + (spec.derived ? " · derived value" : "")
    + (spec.note ? " · " + spec.note : "")
    + (whereShown() ? " · showing only " + whereShown() : "");
}

// The places currently allowed on screen, named the way the picker names them.
function whereShown() {
  if (state.countries.length) return state.countries.map(countryName).join(", ");
  if (state.continents.length) return state.continents.join(", ");
  return "";
}

/* Clicking a place makes it the anchor, on whichever screen you are on: the
   measure, the period and the filters all stay, only the reference moves. */
function reanchor(city, rerun) {
  state.city = city;
  store.set("city", city);
  $("#placeName").textContent = city.name;
  $("#placeMeta").textContent = [city.region, city.country].filter(Boolean).join(", ");
  paintStatus();
  (rerun || runCompare)();
}

/* ---------------------------------------------------- follow the weather */

/* The question people actually bring is not "where else reads 12.4 degC" but
   "how do I keep the weather I love". So one place in one month becomes the
   target, and every month of the year gets the places on Earth that have that
   climate then — or the verdict that home already does.

   Distance is counted in comfort steps rather than z-scores: 2 degC of
   temperature, 2 degC of dew point, ~6 km/h of wind and 1.5 steps in the square
   root of monthly rain each count as one. Rain goes through a square root
   because 20 vs 60 mm is a different month and 220 vs 260 mm is not. Fixed
   steps keep a "close" match meaning the same thing in every month. */
var CHASE_STEP = { t: 2, td: 2, ws: 6 / 3.6, rain: 1.5 };
var CHASE_STAY = 1.5;          // home within this many steps: no need to move

function climateAt(cell, m) {
  var P = CLIM.planes, pr = P.pr[m][cell] * MDAYS[m];
  return { t: P.t2m[m][cell], td: P.td2m[m][cell], ws: P.ws[m][cell],
           mm: pr, rain: Math.sqrt(Math.max(0, pr)) };
}
function chaseDist(a, b) {
  var dt = (a.t - b.t) / CHASE_STEP.t, dd = (a.td - b.td) / CHASE_STEP.td;
  var dw = (a.ws - b.ws) / CHASE_STEP.ws, dr = (a.rain - b.rain) / CHASE_STEP.rain;
  return Math.sqrt(dt * dt + dd * dd + dw * dw + dr * dr);
}
var matchWord = function (d) {
  return d < 0.75 ? "Spot on" : d < 1.5 ? "Very close" : d < 2.5 ? "Close" : "Nearest there is";
};

/* Which months a place is pleasant in: feels-like near 22 degC, not muggy, not
   a washout. Deliberately plain, because it only chooses a sensible default
   target month — the visitor can pick any other. */
function comfortPenalty(cell, m) {
  var k = climateAt(cell, m);
  var feels = METRICS.feels_like.compute({ t2m: k.t, td2m: k.td, ws: k.ws });
  return Math.abs(feels - 22) + 0.8 * Math.max(0, k.td - 16) + Math.max(0, k.mm - 90) / 40;
}
function bestMonths(idx) {
  var cell = CLIM.cellOf[idx], pen = [], best = 0;
  for (var m = 0; m < 12; m++) {
    pen.push(comfortPenalty(cell, m));
    if (pen[m] < pen[best]) best = m;
  }
  var good = [];
  for (m = 0; m < 12; m++) if (pen[m] <= 4) good.push(m);
  return { best: best, good: good };
}

// Month runs written the way people say them: "May–Jun, Sep–Oct".
function monthRuns(list) {
  if (!list.length) return "";
  if (list.length === 12) return "all year";
  var on = {}, out = [];
  list.forEach(function (m) { on[m] = 1; });
  var start = 0;
  while (on[start] && start < 12) start++;        // begin after a gap, so runs wrap
  for (var i = 0; i < 12; i++) {
    var m = (start + i) % 12;
    if (!on[m] || on[(m + 11) % 12]) continue;
    var e = m;
    while (on[(e + 1) % 12] && (e + 1) % 12 !== m) e = (e + 1) % 12;
    out.push(e === m ? MONTHS[m] : MONTHS[m] + "–" + MONTHS[e]);
  }
  return out.join(", ");
}

/* What a month is matched on. The whole climate by default; or one measure
   alone, when that measure is the thing the visitor cares about — "I like
   November's dew point" should follow the dew point, not everything else.
   Each measure has its own step, the size of a difference that matters. */
var MATCH = {
  temperature: { step: 2 }, dew_point: { step: 2 }, feels_like: { step: 2 },
  humidity: { step: 8 }, precipitation: { step: 1.5, sqrt: true }, wind: { step: 6 },
};
var matchOn = function () { return MATCH[state.chaseOn] ? state.chaseOn : "climate"; };

function measureAt(key, cell, m) {
  var v = cellValues(key, m)[cell];
  return MATCH[key].sqrt ? Math.sqrt(Math.max(0, v)) : v;
}
function targetAt(on, cell, m) {
  return on === "climate" ? climateAt(cell, m) : measureAt(on, cell, m);
}
function distTo(on, cell, m, target) {
  return on === "climate" ? chaseDist(climateAt(cell, m), target)
                          : Math.abs(measureAt(on, cell, m) - target) / MATCH[on].step;
}

/* The month Follow the weather keeps is the month that is selected, like
   every other screen. Only when the selection is the whole year — which has no
   single month to keep — does it start from the place's most comfortable
   month, and it selects that month visibly rather than silently. */
function chaseTargetMonth() {
  if (state.period >= 0) return { m: state.period, picked: false };
  var m = bestMonths(state.city.idx).best;
  state.period = m;
  store.set("period", m);
  return { m: m, picked: true };
}

/* For one month: cells nearest the target, each represented by its largest
   place that passes the filters. The anchor's own surroundings are left out —
   home gets its own verdict — and results are spread out: one per ~1 degree
   cell and at most two per country, so a month is a choice, not one coast.

   Then, among candidates that match about equally well (within one step of the
   best), a recognisable town beats a hamlet: each tenfold drop below a million
   people costs a third of a step. Climate still decides who is in the running;
   size only orders near-equals, as it does for ties everywhere else. */
var sizeCost = function (pop) {
  return Math.max(0, 6 - Math.log(Math.max(pop, 1)) / Math.LN10) / 3;
};
function chaseMatches(on, target, m, pass, n, home) {
  var C = CLIM.cells, d = new Float32Array(C), order = new Array(C), c;
  for (c = 0; c < C; c++) { d[c] = distTo(on, c, m, target); order[c] = c; }
  order.sort(function (a, b) { return d[a] - d[b]; });

  var cosl = Math.cos(LAT[home] * Math.PI / 180), seen = {}, perCountry = {}, out = [];
  var limit = Infinity;
  for (var o = 0; o < C && out.length < n * 8; o++) {
    if (d[order[o]] > limit) break;
    c = order[o];
    var best = -1;
    for (var j = CLIM.start[c]; j < CLIM.start[c + 1]; j++) {
      var p = CLIM.members[j];
      if (best >= 0 && rows[p][7] <= rows[best][7]) continue;
      if (pass(p)) best = p;
    }
    if (best < 0) continue;
    var gy = LAT[best] - LAT[home], gx = (LON[best] - LON[home]) * cosl;
    if (gy * gy + gx * gx < 1.35 * 1.35) continue;          // ~150 km of home
    var cell = Math.round(LAT[best]) + "/" + Math.round(LON[best]), cc = rows[best][4];
    if (seen[cell] || (perCountry[cc] || 0) >= 6) continue;
    seen[cell] = 1;
    perCountry[cc] = (perCountry[cc] || 0) + 1;
    if (!out.length) limit = Math.max(d[c] + 1, CHASE_STAY);
    out.push({ idx: best, d: d[c], cell: c });
  }
  // Country spread is re-applied after reordering, on the final picks.
  out.sort(function (a, b) {
    return (a.d + sizeCost(rows[a.idx][7])) - (b.d + sizeCost(rows[b.idx][7]));
  });
  var picked = [], per = {};
  for (var q = 0; q < out.length && picked.length < n; q++) {
    var k2 = rows[out[q].idx][4];
    if ((per[k2] || 0) >= 2) continue;
    per[k2] = (per[k2] || 0) + 1;
    picked.push(out[q]);
  }
  return picked;
}

// What home is like in a month it falls short: the biggest gap, in words.
function homeGap(on, cell, m, target, tm) {
  if (on !== "climate") {
    var now = cellValues(on, m)[cell], want = cellValues(on, tm)[cell], dv = now - want;
    var spec = METRICS[on];
    if (on === "precipitation")
      return Math.round(Math.abs(dv)) + " mm " + (dv > 0 ? "wetter" : "drier");
    return spec.label.toLowerCase() + " " + fmtDelta(Math.abs(dv), on).replace(/^\+/, "")
      + (spec.unit === "°C" ? "°" : " " + unitOf(on)) + (dv > 0 ? " higher" : " lower");
  }
  var k = climateAt(cell, m);
  var dt = k.t - target.t, dd = k.td - target.td, dr = k.rain - target.rain;
  var gaps = [
    [Math.abs(dt) / CHASE_STEP.t, fmtDelta(Math.abs(dt), "temperature").replace(/^\+/, "")
      + "° " + (dt > 0 ? "warmer" : "colder")],
    [Math.abs(dd) / CHASE_STEP.td, dd > 0 ? "muggier" : "drier air"],
    [Math.abs(dr) / CHASE_STEP.rain, dr > 0 ? "wetter" : "drier"],
  ].sort(function (a, b) { return b[0] - a[0]; });
  return gaps[0][1] + (gaps[1][0] >= 1 ? ", " + gaps[1][1] : "");
}

var chaseSeq = 0;
function showChase() {
  var mine = ++chaseSeq;
  if (!state.city) return show("start");
  var tgt = chaseTargetMonth(), tm = tgt.m, on = matchOn();
  show("chase");
  if (ctl("#chaseControls")) ctl("#chaseControls").paint();
  else renderControls($("#chaseControls"), { measure: false, period: false, rerun: showChase });

  var home = state.city.idx, homeCell = CLIM.cellOf[home], bm = bestMonths(home);
  var target = targetAt(on, homeCell, tm);
  var u = state.fahrenheit ? "°F" : "°C", k0 = climateAt(homeCell, tm);

  $("#chaseTitle").textContent = "Keep " + state.city.name + "’s " + MONTH_NAMES[tm]
    + (on === "climate" ? "" : " " + METRICS[on].label.toLowerCase()) + " all year";
  $("#chaseSub").textContent = (on === "climate"
      ? "Target: " + fmt(k0.t, "temperature") + u + ", dew point " + fmt(k0.td, "dew_point") + u
        + ", " + Math.round(k0.mm) + " mm of rain, wind " + fmt(k0.ws * 3.6, "wind") + " km/h"
      : "Target: " + METRICS[on].label.toLowerCase() + " "
        + fmt(cellValues(on, tm)[homeCell], on) + " " + unitOf(on)
        + " — matched on this alone; other measures may differ")
    + " · " + NORMALS + " normals";

  // Target month picker: it is the app's period, so it moves every screen.
  var pick = $("#chaseMonths");
  pick.innerHTML = "";
  var good = setOf(bm.good);
  MONTHS.forEach(function (name, m) {
    var b = el("button", good[m] ? "good" : null, name);
    b.type = "button";
    b.setAttribute("aria-pressed", String(m === tm));
    b.title = (good[m] ? "Pleasant in " : "") + state.city.name + " in " + MONTH_NAMES[m];
    b.addEventListener("click", function () {
      state.period = m;
      store.set("period", m);
      showChase();
    });
    pick.appendChild(b);
  });

  // Match on the whole climate, or on one measure alone.
  var onSel = $("#chaseOn");
  onSel.innerHTML = "";
  [["climate", "Whole climate"]].concat(Object.keys(MATCH).map(function (k) {
    return [k, METRICS[k].label + " only"];
  })).forEach(function (p) {
    var op = el("option", null, p[1]);
    op.value = p[0];
    op.selected = p[0] === on;
    onSel.appendChild(op);
  });
  onSel.classList.toggle("on", on !== "climate");
  onSel.onchange = function () {
    state.chaseOn = onSel.value;
    store.set("chaseOn", state.chaseOn);
    showChase();
  };

  var box = $("#chaseResults");
  box.innerHTML = "";
  var stays = [], now = new Date().getMonth();

  for (var i = 0; i < 12; i++) {
    var m = (now + i) % 12;
    // Range filters read each month's own figures: a July row, July air.
    var mpass = rowFilter(activeBounds(m));
    var hd = distTo(on, homeCell, m, target);
    var stay = hd <= CHASE_STAY;
    if (stay) stays.push(m);
    var picks = chaseMatches(on, target, m, mpass, stay ? 3 : 4, home);
    if (mine !== chaseSeq) return;

    var blk = el("section", "cm" + (stay ? " stay" : "") + (m === tm ? " target" : ""));
    var head = el("div", "cm-head");
    head.appendChild(el("b", "cm-month", MONTH_NAMES[m] + (i === 0 ? " · now" : "")));
    head.appendChild(el("span", "cm-home", m === tm
      ? "The month you are keeping — stay in " + state.city.name
      : stay ? "Stay in " + state.city.name + " — " + matchWord(hd).toLowerCase()
      : state.city.name + ": " + homeGap(on, homeCell, m, target, tm) + " — go"));
    blk.appendChild(head);

    var list = el("div", "cm-picks");
    if (!picks.length) list.appendChild(el("p", "meta", "Nothing matches the current filters this month."));
    picks.forEach(function (pk) { list.appendChild(chaseCard(describe(pk.idx), pk, m, on)); });
    blk.appendChild(list);
    box.appendChild(blk);
  }

  var lead = tgt.picked ? "No month was selected, so this starts from " + state.city.name
    + "’s most comfortable one, " + MONTH_NAMES[tm] + " — pick any other above. " : "";
  $("#chasePlan").textContent = lead + (stays.length > 1
    ? "Stay home " + stays.length + " months (" + monthRuns(stays) + "). For the other "
      + (12 - stays.length) + ", these are the closest matches on Earth."
    : state.city.name + " only matches its own " + MONTH_NAMES[tm]
      + " in " + MONTH_NAMES[tm] + " — every other month below is a move.");

  // Months away from home is exactly when cover and data abroad matter.
  var away = 12 - stays.length, kit = [];
  if (PARTNERS.insurance) kit.push(partnerLink("insurance", PARTNERS.insurance,
    "Travel medical insurance for the " + away + " months away →"));
  if (PARTNERS.esim) kit.push(partnerLink("esim", PARTNERS.esim, "Mobile data abroad with an eSIM →"));
  $("#chaseKit").innerHTML = kit.join("");
  $("#chaseKit").hidden = !kit.length || !away;

  $("#chaseSource").textContent = (on === "climate"
      ? "Matched on temperature, dew point, rainfall and wind together. One step is 2° of "
        + "temperature or dew point, ~6 km/h of wind, or a modest change in rain"
      : "Matched on " + METRICS[on].label.toLowerCase() + " alone. One step is "
        + (on === "precipitation" ? "a modest change in rain"
           : MATCH[on].step + (METRICS[on].unit === "°C" ? "°" : " " + METRICS[on].unit)))
    + "; “stay” means home is within " + CHASE_STAY + " steps. Month by month across all "
    + N.toLocaleString() + " places. Entry rules for a " + countryName(state.passport)
    + " passport. ERA5 " + NORMALS + " normals, 0.25° grid.";
  syncHash();
}

function chaseCard(c, pk, m, on) {
  var card = el("div", "cmc");
  var air = PM25 ? PM25.month[m][c.idx] : Infinity, code = visaCode(c.cc), k = climateAt(pk.cell, m);
  // The measure being matched leads; the rest are context.
  var lead = on === "climate" ? fmt(k.t, "temperature") + "°"
    : fmt(cellValues(on, m)[pk.cell], on) + (METRICS[on].unit === "°C" ? "°" : " " + unitOf(on));
  var rest = [];
  if (on !== "temperature" && on !== "climate") rest.push("temp " + fmt(k.t, "temperature") + "°");
  if (on !== "dew_point") rest.push("dew " + fmt(k.td, "dew_point") + "°");
  if (on !== "precipitation") rest.push(Math.round(k.mm) + " mm");
  if (isFinite(air)) rest.push("PM2.5 " + air.toFixed(0));
  card.innerHTML =
    '<div class="cmc-top"><b>' + c.name + "</b>" + livBadge(c.cc) + "</div>"
    + '<div class="wh">' + [c.region, c.country].filter(Boolean).join(", ") + "</div>"
    + '<div class="cmc-k">' + (on === "climate" ? "" : '<span class="cmc-on">'
        + METRICS[on].label + "</span> ") + lead
      + rest.map(function (r) { return " <i>" + r + "</i>"; }).join("") + "</div>"
    + '<div class="cmc-foot"><span class="cmc-match">' + matchWord(pk.d) + "</span>"
      + (code ? '<span class="cmc-visa v' + code + '">' + VISA_WORDS[code] + "</span>" : "")
      + linksFor(c) + "</div>"
    + '<div class="cmc-act">'
      + partnerLink("stay", stayUrl(c, m), "Stay in " + MONTHS[m] + " →", "go",
                    "Four weeks in " + c.name + " from " + isoDate(stayDates(m)[0]))
      + ((code === "E" || code === "A") && PARTNERS.visa
          ? partnerLink("visa", PARTNERS.visa, code === "E" ? "Get the e-visa" : "Visa on arrival help")
          : "")
      + "</div>";
  card.tabIndex = 0;
  card.title = "Open " + c.name;
  var open = function (ev) {
    if (ev.target.closest("a")) return;
    selectCity(c);
  };
  card.addEventListener("click", open);
  card.addEventListener("keydown", function (ev) { if (ev.key === "Enter") open(ev); });
  return card;
}

// Every way into Follow the weather goes through here, saying what to match on.
function followWeather(on) {
  state.chaseOn = on;
  store.set("chaseOn", on);
  showChase();
}

/* On the place page: the month you have selected, or — with the whole year
   selected — when this place is at its best, and the way in to following
   that weather around the year. */
function renderChaseCta(city) {
  var box = $("#placeChase");
  if (!box) return;
  var bm = bestMonths(city.idx), chosen = state.period >= 0;
  var m = chosen ? state.period : bm.best, k = climateAt(CLIM.cellOf[city.idx], m);
  var u = state.fahrenheit ? "°F" : "°C";
  box.innerHTML = "";
  var txt = el("div", "pc-txt");
  var at = "In " + MONTH_NAMES[m] + " it averages " + fmt(k.t, "temperature") + u
    + " with a " + fmt(k.td, "dew_point") + u + " dew point and " + Math.round(k.mm) + " mm of rain.";
  txt.innerHTML = (bm.good.length
      ? "<b>" + city.name + " is at its best " + monthRuns(bm.good) + ".</b> "
      : "<b>No month in " + city.name + " is mild by the usual measures.</b> ") + at;
  box.appendChild(txt);
  var go = el("button", "primary", "Follow " + MONTH_NAMES[m] + " in " + city.name + " all year →");
  go.type = "button";
  go.addEventListener("click", function () {
    state.period = m;
    store.set("period", m);
    followWeather("climate");
  });
  box.appendChild(go);
}

/* ------------------------------------------------------------------ chrome */

/* Which screen is up, and how to redraw it. Everything that changes the whole
   view — units, cleared filters — goes through here, so no screen is left
   holding a stale copy of the selection. */
function currentScreen() {
  if (!$("#compare").hidden) return { ctl: "#cmpControls", rerun: runCompare };
  if (!$("#favs").hidden) return { ctl: "#favControls", rerun: showFavourites };
  if (!$("#overall").hidden) return { ctl: "#ovControls", rerun: showOverall };
  if (!$("#chase").hidden) return { ctl: "#chaseControls", rerun: showChase };
  return null;
}

var unitBtn = $("#unit");
var paintUnit = function () { unitBtn.textContent = state.fahrenheit ? "°F" : "°C"; };
paintUnit();
unitBtn.addEventListener("click", function () {
  // Pure formatting — never a refetch, never a rebuild.
  state.fahrenheit = !state.fahrenheit;
  store.set("fahrenheit", state.fahrenheit);
  paintUnit();
  var scr = currentScreen();
  if (scr) {
    if (ctl(scr.ctl)) ctl(scr.ctl).rebuild();   // filter boxes speak the new unit
    scr.rerun();
  } else if (!$("#profile").hidden && state.city) selectCity(state.city);
});

function renderRecents() {
  var box = $("#recents");
  if (!state.recents.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = "";
  state.recents.forEach(function (c) {
    var b = document.createElement("button");
    b.className = "pill";
    b.textContent = c.name;
    b.addEventListener("click", function () { selectCity(c); });
    box.appendChild(b);
  });
}

/* ------------------------------------------------------------ passport */

var passportSel = $("#passport");
Object.keys(LIV.passports)
  .map(function (cc) { return [cc, countryName(cc)]; })
  .sort(function (a, b) { return a[1] < b[1] ? -1 : 1; })
  .forEach(function (p) {
    var op = el("option", null, p[1] + " passport");
    op.value = p[0];
    passportSel.appendChild(op);
  });
passportSel.addEventListener("change", function () { setPassport(passportSel.value); });

// Everything that shows settling in or entry rules is redrawn for the new passport.
function paintPassport() {
  passportSel.value = state.passport;
  passportSel.title = "Settling-in scores and entry filters are for a "
    + countryName(state.passport) + " passport";
  var scr = currentScreen();
  if (scr) scr.rerun();
  else if (!$("#profile").hidden && state.city) selectCity(state.city);
  syncHash();
}

/* --------------------------------------------------------- shareable links */

/* The address bar carries the selection, so any screen can be sent to someone
   and opens on the same place, measure, month and passport. Works from file://
   as well as from a web server. */
var SCREENS = ["profile", "compare", "chase", "overall", "favs"];
function syncHash() {
  if (!state.city) return;
  var scr = "profile";
  SCREENS.forEach(function (n) { if (!$("#" + n).hidden) scr = n; });
  var q = ["p=" + state.city.id, "v=" + scr, "m=" + state.metric, "t=" + state.period,
           "pp=" + state.passport];
  if (scr === "chase" && state.chaseOn !== "climate") q.push("on=" + state.chaseOn);
  if (state.entry !== "any") q.push("e=" + state.entry);
  var h = "#" + q.join("&");
  if (location.hash === h) return;
  try { history.replaceState(null, "", h); } catch (e) { /* sandboxed: harmless */ }
}

function readHash() {
  var q = {};
  location.hash.replace(/^#/, "").split("&").forEach(function (kv) {
    var i = kv.indexOf("=");
    if (i > 0) q[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
  });
  if (!q.p) return null;
  var id = +q.p, at = -1;
  for (var i = 0; i < N; i++) if (rows[i][0] === id) { at = i; break; }
  if (at < 0) return null;
  if (METRICS[q.m]) state.metric = q.m;
  if (q.t != null && +q.t >= -1 && +q.t <= 11) state.period = +q.t;
  if (LIV.passports[q.pp]) state.passport = q.pp;
  if (ENTRY[q.e]) state.entry = q.e;
  if (q.on) state.chaseOn = MATCH[q.on] ? q.on : "climate";
  else if (q.v === "chase") state.chaseOn = "climate";
  return { city: describe(at), screen: q.v };
}

$("#copyLink").addEventListener("click", function () {
  syncHash();
  var b = $("#copyLink"), done = function (t) {
    b.textContent = t;
    setTimeout(function () { b.textContent = "Copy link"; }, 1600);
  };
  if (navigator.clipboard) navigator.clipboard.writeText(location.href)
    .then(function () { done("Copied"); }, function () { done("Copy failed"); });
  else done("Copy the address bar");
});

$("#ovBtn").addEventListener("click", showOverall);
$("#chaseBtn").addEventListener("click", function () { showChase(); });
$("#cmpFollow").addEventListener("click", function () { followWeather(state.metric); });
$("#favBtn").addEventListener("click", showFavourites);
$("#sbFav").addEventListener("click", function () {
  if (state.city) { toggleFav(state.city); paintFavStar(state.city); paintStatus(); }
});
$("#sbClear").addEventListener("click", function () {
  clearFilters();
  var scr = currentScreen();
  if (scr) {
    if (ctl(scr.ctl)) ctl(scr.ctl).rebuild();
    scr.rerun();
  }
  paintStatus();
});
paintFavCount();
paintFooter();
renderRecents();
$("#q").disabled = false;
note(N.toLocaleString() + " places · ten years of climate · entry rules for "
  + Object.keys(LIV.passports).length + " passports.");

passportSel.value = state.passport;

// A shared link opens what was shared; otherwise a refresh lands you back
// where you were, without re-asking for location.
function openLink() {
  var link = readHash();
  if (!link) return false;
  passportSel.value = state.passport;
  LIV_VALUES = null;
  selectCity(link.city);
  if (link.screen === "chase") showChase();
  else if (link.screen === "compare") openCompare(state.metric);
  else if (link.screen === "overall") showOverall();
  else if (link.screen === "favs") showFavourites();
  return true;
}
// A link pasted into a tab that already has Livably open changes only the hash.
window.addEventListener("hashchange", openLink);
if (!openLink() && state.city && typeof state.city.idx === "number") selectCity(state.city);

})();
