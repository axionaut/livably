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

var ERA5 = "https://planette-era5.s3.us-east-2.amazonaws.com/era5";
var era5Url = function (v) {
  return ERA5 + "/" + v + "/month/0p25latx0p25lon/era5_" + v + "_month_0p25latx0p25lon.zarr";
};
var K = 273.15;
// Magnus / Alduchov-Eskridge saturation vapour pressure, hPa.
var svp = function (t) { return 6.1094 * Math.exp((17.625 * t) / (t + 243.04)); };

var METRICS = {
  temperature: { icon: '<path d="M14 4v10.5a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/>', tint: "#f0a35e", label: "Temperature", unit: "°C", vars: ["t2m"], annual: "mean", dp: 1,
    compute: function (v) { return v.t2m - K; } },

  dew_point: { icon: '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5S12.5 5.5 12 3c-.5 2.5-2 4.9-4 6.5S5 13 5 15a7 7 0 0 0 7 7Z"/>', tint: "#5eb3f6", label: "Dew point", unit: "°C", vars: ["td2m"], annual: "mean", dp: 1,
    comfort: true, compute: function (v) { return v.td2m - K; } },

  feels_like: { icon: '<circle cx="12" cy="12" r="3.5"/><path d="M12 2v2m0 16v2M4.2 4.2l1.4 1.4m12.8 12.8 1.4 1.4M2 12h2m16 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>', tint: "#f2778a", label: "Feels like", unit: "°C", vars: ["t2m", "td2m", "u10m", "v10m"],
    annual: "mean", dp: 1, derived: true,
    // Australian BoM apparent temperature.
    compute: function (v) {
      return (v.t2m - K) + 0.33 * svp(v.td2m - K)
             - 0.7 * Math.sqrt(v.u10m * v.u10m + v.v10m * v.v10m) - 4.0;
    } },

  humidity: { icon: '<path d="M7 16.5A3.8 3.8 0 0 0 10.8 12c0-1.1-.6-2.1-1.7-3S7.3 6.6 7 5.2c-.3 1.4-.9 2.7-2 3.6S3.2 10.9 3.2 12A3.8 3.8 0 0 0 7 16.5Z"/><path d="M16.5 20a4.5 4.5 0 0 0 4.5-4.5c0-1.3-.7-2.5-2-3.6s-2.2-2.7-2.5-4.4c-.3 1.7-1.2 3.3-2.5 4.4s-2 2.3-2 3.6A4.5 4.5 0 0 0 16.5 20Z"/>', tint: "#7dd3c0", label: "Relative humidity", unit: "%", vars: ["t2m", "td2m"],
    annual: "mean", dp: 0, derived: true,
    compute: function (v) { return Math.min(100, 100 * svp(v.td2m - K) / svp(v.t2m - K)); } },

  precipitation: { icon: '<path d="M20 15.5A4.5 4.5 0 0 0 17.5 7h-1.7A7 7 0 1 0 4 13.9"/><path d="M8 19v2m4-3v3m4-4v2"/>', tint: "#8ba4f9", label: "Rainfall", unit: "mm", vars: ["pr"], annual: "sum", dp: 0,
    // kg m-2 s-1 is mm/s; scale to the month.
    compute: function (v, days) { return v.pr * 86400 * days; } },

  liveability: {
    icon: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9h13v-9"/><path d="M10 19v-5h4v5"/>',
    tint: "#7dd3c0", label: "Settling in", unit: "score",
    vars: [], statik: "liv", annual: "mean", dp: 0, derived: true,
    note: "Country-level: entry access + income level, relative to "
        + ((window.LIVEABILITY && window.LIVEABILITY.baseCity) || "home"),
    compute: null,
  },

  air_quality: {
    icon: '<path d="M4 8h11a3 3 0 1 0-3-3"/><path d="M2 12h15a3 3 0 1 1-3 3"/><path d="M6 16h7a2.5 2.5 0 1 1-2.5 2.5"/>',
    tint: "#c084fc", label: "Air quality", unit: "µg/m³",
    vars: [], statik: "pm25", monthly: true, annual: "mean", dp: 1,
    note: "PM2.5 from SatPM2.5 V6.GL.03 (ACAG), monthly and annual",
    compute: null,
  },

  wind: { icon: '<path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2M9.6 4.6A2 2 0 1 1 11 8H2m8.8 11.4A2 2 0 1 0 12 16H2"/>', tint: "#a5b4c4", label: "Wind speed", unit: "km/h", vars: ["u10m", "v10m"], annual: "mean", dp: 1,
    derived: true, note: "Vector mean of monthly winds; understates true average speed.",
    compute: function (v) { return Math.sqrt(v.u10m * v.u10m + v.v10m * v.v10m) * 3.6; } },
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
var daysInMonth = function (y, m) { return new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); };

/* ---------------------------------------------------------------- places */

var NLAT = 721, NLON = 1440;
var rows = window.CITIES.rows, COUNTRIES = window.CITIES.countries, N = rows.length;
var LAT = new Float32Array(N), LON = new Float32Array(N);
for (var i = 0; i < N; i++) { LAT[i] = rows[i][5]; LON[i] = rows[i][6]; }

var describe = function (i) {
  var r = rows[i];
  return { idx: i, id: r[0], name: r[1], region: r[3], cc: r[4],
           country: (COUNTRIES[r[4]] || [r[4]])[0], lat: r[5], lon: r[6], pop: r[7] };
};

/* ------------------------------------------------------------ ERA5 layer */

/* Air quality ships as a static per-city array: one annual number per place,
   ~470 KB as int16, which is why it can be ranked like the ERA5 measures
   instead of being a lookup limited to whatever is on screen. */
var PM25 = (function () {
  var d = window.PM25;
  if (!d || !d.b64) return null;
  var bin = atob(d.b64), buf = new ArrayBuffer(bin.length), u8 = new Uint8Array(buf);
  for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  var raw = new Int16Array(buf), all = new Float32Array(raw.length);
  for (var j = 0; j < raw.length; j++)
    all[j] = raw[j] < 0 ? Infinity : raw[j] / d.scale;   // -1 marks no data

  // Slice 0 is the annual mean, slices 1-12 are Jan-Dec.
  var planes = d.planes || 1, n = all.length / planes;
  var byPeriod = [];
  for (var p = 0; p < planes; p++) byPeriod.push(all.subarray(p * n, (p + 1) * n));
  return {
    annual: byPeriod[0],
    month: byPeriod.slice(1),
    values: byPeriod[0],          // default view stays the annual mean
    year: d.year, source: d.source,
  };
})();

/* Liveability is a country-level score, so every city in a country shares it.
   That means huge ties — which the distinct-value stepping already handles by
   showing one representative per value. */
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

var zarr = null, IcechunkStore = null;
var varCache = {}, indexCache = {}, inflight = {};

/* Sampled layers persist in IndexedDB, which works on file:// and survives a
   browser restart. Each entry is 12 x 235,157 float32 (~11 MB), so a full set
   of metrics is around 56 MB. */
var DB = "livably-cache", STORE = "vars";
function idbOpen() {
  return new Promise(function (res, rej) {
    var r = indexedDB.open(DB, 1);
    r.onupgradeneeded = function () { r.result.createObjectStore(STORE); };
    r.onsuccess = function () { res(r.result); };
    r.onerror = function () { rej(r.error); };
  });
}
function cacheGet(k) {
  return idbOpen().then(function (db) {
    return new Promise(function (res) {
      var rq = db.transaction(STORE).objectStore(STORE).get(k);
      rq.onsuccess = function () { res(rq.result || null); };
      rq.onerror = function () { res(null); };
    });
  }).catch(function () { return null; });
}
function cachePut(k, buf) {
  return idbOpen().then(function (db) {
    db.transaction(STORE, "readwrite").objectStore(STORE).put(buf, k);
  }).catch(function () { /* caching is best-effort */ });
}
function cacheClear() {
  return idbOpen().then(function (db) {
    db.transaction(STORE, "readwrite").objectStore(STORE).clear();
  }).catch(function () {});
}

async function deps() {
  if (zarr) return;
  phase("Loading reader");
  // icechunk-js is pure TypeScript. The official @earthmover/icechunk package
  // ships a Node napi binary whose browser build fails in a page with
  // "napi_create_threadsafe_function"; this one has no WASM at all.
  var ic = await import("https://esm.sh/icechunk-js");
  zarr = await import("https://esm.sh/zarrita@0.7");
  IcechunkStore = ic.IcechunkStore;
}

// Bilinear sample of a global 0.25 deg field. lat 90 -> -90, lon -179.75 -> 180.
function sampleGrid(grid, off, out) {
  for (var c = 0; c < N; c++) {
    var fy = (90 - LAT[c]) / 0.25, fx = (LON[c] + 179.75) / 0.25;
    if (fx < 0) fx += NLON;
    var y0 = Math.floor(fy), x0 = Math.floor(fx), wy = fy - y0, wx = fx - x0;
    if (y0 < 0) y0 = 0;
    if (y0 > NLAT - 2) y0 = NLAT - 2;
    var x1 = (x0 + 1) % NLON, r0 = off + y0 * NLON, r1 = off + (y0 + 1) * NLON;
    out[c] = (grid[r0 + x0] * (1 - wx) + grid[r0 + x1] * wx) * (1 - wy)
           + (grid[r1 + x0] * (1 - wx) + grid[r1 + x1] * wx) * wy;
  }
}

function loadVariable(v, year) {
  var key = v + ":" + year;
  if (varCache[key]) return Promise.resolve(varCache[key]);
  if (inflight[key]) return inflight[key];

  inflight[key] = (async function () {
    var hit = await cacheGet(key);
    if (hit) {
      varCache[key] = new Float32Array(hit);
      return varCache[key];
    }

    await deps();
    phase("Loading " + v + " climate layer");

    var store = await IcechunkStore.open(era5Url(v));

    // CF time: "days since <date>", and the start differs per variable
    // (t2m begins 1940-01, pr 1940-04). Decode it, never assume an epoch.
    var tArr = await zarr.open(store.resolve("/time"), { kind: "array" });
    var units = (tArr.attrs && tArr.attrs.units) || "";
    var u = /days since (\d{4})-(\d{2})-(\d{2})/.exec(units);
    if (!u) throw new Error("unexpected time units on " + v + ": " + units);
    var t0 = await zarr.get(tArr, [zarr.slice(0, 1)]);
    var first = new Date(Date.UTC(+u[1], +u[2] - 1, +u[3]) + Number(t0.data[0]) * 86400000);
    var i0 = (year - first.getUTCFullYear()) * 12 - first.getUTCMonth();
    if (i0 < 0 || i0 + 12 > tArr.shape[0]) throw new Error(v + " has no data for " + year);

    var data = await zarr.open(store.resolve("/" + v), { kind: "array" });
    var chunk = await zarr.get(data, [zarr.slice(i0, i0 + 12), null, null]);
    var grid = chunk.data;

    phase("Mapping places onto the grid");
    var out = new Float32Array(12 * N), scratch = new Float32Array(N);
    for (var m = 0; m < 12; m++) {
      sampleGrid(grid, m * NLAT * NLON, scratch);
      out.set(scratch, m * N);
    }
    chunk = null;              // release the raw global grid promptly
    varCache[key] = out;
    cachePut(key, out.buffer.slice(0));
    return out;
  })();
  // Clear the slot either way, so one failure doesn't wedge the metric forever.
  inflight[key]["catch"](function () {})["then"](function () { delete inflight[key]; });
  return inflight[key];
}

// period: 0-11 for a month, -1 for the annual figure.
async function buildIndex(metric, year, period) {
  var ck = metric + ":" + year + ":" + period;
  if (indexCache[ck]) return indexCache[ck];

  var spec = METRICS[metric], loaded = {};

  if (spec.statik) {
    var vS;
    if (spec.statik === "pm25") {
      // Air quality has real monthly fields, so it follows the period like
      // every other measure. Liveability genuinely has none, so it does not.
      vS = PM25 && (period >= 0 && PM25.month.length === 12
                      ? PM25.month[period] : PM25.annual);
    } else {
      vS = livValues();
    }
    if (!vS) throw new Error(spec.label + " data not loaded");
    var ordS = new Uint32Array(N);
    for (var c0 = 0; c0 < N; c0++) ordS[c0] = c0;
    ordS.set(Array.prototype.slice.call(ordS).sort(function (a, b) {
      return vS[a] - vS[b];
    }));
    indexCache[ck] = { values: vS, order: ordS };
    return indexCache[ck];
  }

  for (var k = 0; k < spec.vars.length; k++)
    loaded[spec.vars[k]] = await loadVariable(spec.vars[k], year);

  phase("Building sorted index");
  await new Promise(function (r) { setTimeout(r, 0); });   // let the spinner paint

  var values = new Float32Array(N), scratch = {}, c, m, v;
  for (c = 0; c < N; c++) {
    if (period >= 0) {
      for (v = 0; v < spec.vars.length; v++) scratch[spec.vars[v]] = loaded[spec.vars[v]][period * N + c];
      values[c] = spec.compute(scratch, daysInMonth(year, period));
    } else if (spec.annual === "sum") {
      var total = 0;
      for (m = 0; m < 12; m++) {
        for (v = 0; v < spec.vars.length; v++) scratch[spec.vars[v]] = loaded[spec.vars[v]][m * N + c];
        total += spec.compute(scratch, daysInMonth(year, m));
      }
      values[c] = total;
    } else {
      // Day-weighted, so a 31-day month counts for more than February.
      var acc = 0, days = 0;
      for (m = 0; m < 12; m++) {
        var d = daysInMonth(year, m);
        for (v = 0; v < spec.vars.length; v++) scratch[spec.vars[v]] = loaded[spec.vars[v]][m * N + c];
        acc += spec.compute(scratch, d) * d;
        days += d;
      }
      values[c] = acc / days;
    }
  }

  var order = new Uint32Array(N);
  for (c = 0; c < N; c++) order[c] = c;
  order.set(Array.prototype.slice.call(order).sort(function (a, b) { return values[a] - values[b]; }));

  indexCache[ck] = { values: values, order: order };
  return indexCache[ck];
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

var YEARS = [2024, 2023, 2022, 2021, 2020];
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
var state = {
  city: store.get("city", null), metric: store.get("metric", "dew_point"),
  period: store.get("period", -1), year: store.get("year", YEARS[0]),
  fahrenheit: store.get("fahrenheit", false), recents: store.get("recents", []),
  minPop: store.get("minPop", 0),
  continent: store.get("continent", ""),
  country: store.get("country", ""),
  // metricKey -> {min, max}; constrains results by other measures too.
  ranges: store.get("ranges", {}),
  favs: store.get("favs", []),
};
var POP_TIERS = [[0,"Any size"],[5000,"5k+"],[50000,"50k+"],[250000,"250k+"],[1000000,"1M+"]];

var isTemp = function (m) { return METRICS[m].unit === "°C"; };
var unitOf = function (m) { return isTemp(m) && state.fahrenheit ? "°F" : METRICS[m].unit; };
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
  var el = solarElevation(city.lat, city.lon);
  // Civil twilight is the changeover: below -6 degrees it is properly night.
  var phase = el > 0 ? "day" : el > -6 ? "dusk" : "night";
  document.documentElement.setAttribute("data-daylight", phase);
  var bar = $("#sbSun");
  if (bar) {
    bar.textContent = (phase === "day" ? "☀ Daytime there"
      : phase === "dusk" ? "◑ Twilight there" : "☾ Night there");
    bar.title = "Sun " + (el >= 0 ? "+" : "") + el.toFixed(0)
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
  var pick = function (k) { return prof[k] && isFinite(prof[k].annual) ? prof[k].annual : null; };
  var rh = pick("humidity"), rain = pick("precipitation"), t = pick("temperature");
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

/* Liveability, relative to the base country in data/liveability.js.
   Returns null for anywhere unrated, and the UI says "not rated" rather than
   pretending a gap is a low score. */
var LIV = window.LIVEABILITY || { base: "", weights: {}, countries: {}, labels: {} };

function livScore(cc) {
  var row = LIV.countries && LIV.countries[cc];
  if (!row) return null;
  var total = 0, used = 0, parts = [];
  Object.keys(LIV.weights).forEach(function (k) {
    var v = row[k];
    if (v == null || !isFinite(v)) return;       // missing field, not a zero
    var w = LIV.weights[k];
    total += v * w; used += w;
    parts.push({ key: k, label: (LIV.labels || {})[k] || k, value: v });
  });
  if (!used) return null;
  return { score: Math.round(total / used), parts: parts, source: row.source || "" };
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
  return '<span class="liv ' + band + '" title="Settling-in score vs '
    + (LIV.baseCity || LIV.base) + " — " + r.parts.map(function (p) {
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
  $("#sbPeriod").textContent = (spec.statik && !spec.monthly) ? "Annual"
    : state.period < 0 ? "Annual" : MONTHS[state.period];
  $("#sbYear").textContent = state.year;

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
  if (state.country) bits.push((COUNTRIES[state.country] || [state.country])[0]);
  else if (state.continent) bits.push(state.continent);
  var nr = activeRanges().length;
  if (nr) bits.push(nr + " range" + (nr === 1 ? "" : "s"));
  $("#sbFilters").textContent = bits.length ? bits.join(" · ") : "No filters";
  $("#sbClear").hidden = !bits.length;
  $("#sbFilters").hidden = !bits.length;

  var fav = isFav(state.city.id);
  $("#sbFav").textContent = fav ? "★ Saved" : "☆ Save";
  $("#sbFav").classList.toggle("on", fav);
}

function show(name) {
  ["start", "profile", "compare", "favs", "overall"].forEach(function (s) { $("#" + s).hidden = s !== name; });
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
  $("#metricGrid").innerHTML = '<p class="meta">Loading climate data… the first '
    + 'metric pulls a global layer and takes a moment. Later ones are instant.</p>';
  $("#profileSource").innerHTML = "ERA5 reanalysis, " + state.year
    + ", 0.25° grid · annual figures are day-weighted means (rainfall is a total). "
    + '<button id="clearCache" class="linkish">Clear downloaded climate data</button>';
  $("#clearCache").addEventListener("click", function () {
    cacheClear().then(function () {
      varCache = {}; indexCache = {};
      $("#clearCache").textContent = "Cleared — next metric will re-download.";
    });
  });
  show("profile");

  // Each metric needs its own global layer, so they arrive over tens of seconds.
  // Render them one at a time instead of making the page wait for all of them.
  var token = ++profileSeq;
  try {
    var prof = {}, keys = Object.keys(METRICS);
    for (var i = 0; i < keys.length; i++) {
      var annual = await buildIndex(keys[i], state.year, -1), months = [];
      for (var m = 0; m < 12; m++)
        months.push((await buildIndex(keys[i], state.year, m)).values[city.idx]);
      if (token !== profileSeq) return;      // a different place was chosen
      prof[keys[i]] = { annual: annual.values[city.idx], months: months };
      applyMood(prof.temperature && prof.temperature.annual,
                prof.dew_point && prof.dew_point.annual);
      applyScene(prof);
      lastProfile = prof;
      renderSimilar(city);
      renderProfile(prof, i + 1 < keys.length);
    }
  } catch (err) {
    if (token === profileSeq)
      $("#metricGrid").innerHTML = '<p class="err">' + err.message + "</p>";
  }
}
var profileSeq = 0;
var lastProfile = null;

function coords(la, lo) {
  return Math.abs(la).toFixed(2) + "°" + (la >= 0 ? "N" : "S") + " "
       + Math.abs(lo).toFixed(2) + "°" + (lo >= 0 ? "E" : "W");
}

/* The places most like this one overall — not nearby, but climatically closest.
   Each loaded measure is standardised (z-score across every settlement) so that
   millimetres of rain and degrees of dew point carry comparable weight, then we
   take the smallest Euclidean distance in that space. */
function similarPlaces(idx, n) {
  var keys = Object.keys(METRICS).filter(function (k) {
    return indexCache[k + ":" + state.year + ":-1"];
  });
  if (!keys.length) return { list: [], used: 0 };

  var dims = keys.map(function (k) {
    var v = indexCache[k + ":" + state.year + ":-1"].values;
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
      + encodeURIComponent(city.lat + "," + city.lon) + '">Map</a>';
  box.appendChild(links);

  var yr = document.createElement("label");
  yr.className = "pe-year";
  yr.innerHTML = "<span>Year</span>";
  var sel = document.createElement("select");
  sel.className = "pill";
  YEARS.forEach(function (y) {
    var o = document.createElement("option");
    o.value = y; o.textContent = y; o.selected = y === state.year;
    sel.appendChild(o);
  });
  sel.addEventListener("change", function () {
    state.year = +sel.value;
    store.set("year", state.year);
    $("#year").value = String(state.year);
    selectCity(state.city);
  });
  yr.appendChild(sel);
  box.appendChild(yr);

}

// Rendered once the annual indexes exist, so it can span every loaded measure.
function renderSimilar(city) {
  var box = $("#placeSimilar");
  if (!box) return;
  var res = similarPlaces(city.idx, 8);
  box.innerHTML = "";
  if (!res.list.length) return;

  var head = document.createElement("span");
  head.className = "pe-head";
  head.textContent = "Most similar climates · across " + res.used
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

function renderProfile(prof, more) {
  var g = $("#metricGrid");
  g.innerHTML = "";
  if (more) {
    var p = document.createElement("p");
    p.className = "meta";
    p.style.gridColumn = "1/-1";
    p.textContent = "Loading the remaining measures…";
    g.appendChild(p);
  }
  Object.keys(METRICS).forEach(function (key) {
    var spec = METRICS[key], d = prof[key];
    if (!d) return;
    var card = document.createElement("button");
    card.className = "card";
    var tier = spec.comfort ? dewTier(d.annual) : null;
    card.style.setProperty("--tint", spec.tint);
    card.innerHTML =
      '<div class="k"><span class="kic">' + svgIcon(spec.icon) + "</span>" + spec.label + (spec.annual === "sum" ? " · yearly total" : "") + '</div>'
      + '<div class="v">' + fmt(d.annual, key) + '<span class="u"> ' + unitOf(key) + '</span></div>'
      + (tier ? '<span class="tier ' + tier.cls + '">' + tier.label + "</span>" : "")
      + (spec.derived ? '<div class="tag">derived</div>' : "");
    if (!spec.statik || spec.monthly) card.appendChild(sparkline(d.months));
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

function sparkline(months) {
  var ns = "http://www.w3.org/2000/svg";
  var svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("viewBox", "0 0 120 34");
  svg.setAttribute("preserveAspectRatio", "none");
  var lo = Math.min.apply(null, months), hi = Math.max.apply(null, months), span = hi - lo || 1;
  var line = document.createElementNS(ns, "polyline");
  line.setAttribute("points", months.map(function (v, i) {
    return (i / 11 * 118 + 1) + "," + (31 - (v - lo) / span * 28);
  }).join(" "));
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "currentColor");
  line.setAttribute("stroke-width", "1.6");
  line.setAttribute("opacity", ".55");
  svg.appendChild(line);
  return svg;
}

/* ------------------------------------------------------------- comparison */

function openCompare(metric) {
  state.metric = metric;
  store.set("metric", metric);
  paintStatus();
  show("compare");
  renderPeriods();
  renderRefine();
  runCompare();
}

function renderPeriods() {
  var box = $("#periods");
  box.innerHTML = "";
  var mk = function (label, p) {
    var b = document.createElement("button");
    b.textContent = label;
    b.setAttribute("aria-pressed", String(state.period === p));
    b.addEventListener("click", function () {
      state.period = p; store.set("period", p);
  paintStatus(); renderPeriods(); runCompare();
    });
    box.appendChild(b);
  };
  mk("Year", -1);
  MONTHS.forEach(function (m, i) { mk(m, i); });
  if (METRICS[state.metric].statik && !METRICS[state.metric].monthly) {
    Array.prototype.forEach.call(box.querySelectorAll("button"), function (b, i) {
      b.setAttribute("aria-pressed", String(i === 0));
      if (i > 0) {
        b.disabled = true;
        b.title = METRICS[state.metric].label + " is an annual figure only";
      }
    });
  }

  var picker = function (title, opts, current, onPick) {
    var sel = document.createElement("select");
    sel.className = "pill";
    sel.title = title;
    opts.forEach(function (o) {
      var el = document.createElement("option");
      el.value = o[0]; el.textContent = o[1];
      el.selected = String(o[0]) === String(current);
      sel.appendChild(el);
    });
    sel.addEventListener("change", function () { onPick(sel.value); });
    box.appendChild(sel);
  };

  picker("Only show places at least this big", POP_TIERS, state.minPop, function (v) {
    state.minPop = +v; store.set("minPop", state.minPop);
  paintStatus(); runCompare();
  });

  var conts = [["", "Anywhere"]];
  CONTINENTS.forEach(function (c) { conts.push([c, c]); });
  picker("Limit to a continent", conts, state.continent, function (v) {
    state.continent = v; state.country = "";      // country belongs to a continent
    store.set("continent", v); store.set("country", "");
    renderPeriods(); runCompare();
  });

  var list = [["", state.continent ? "All of " + state.continent : "Any country"]];
  countryList(state.continent).forEach(function (c) { list.push(c); });
  picker("Limit to one country", list, state.country, function (v) {
    state.country = v; store.set("country", v); runCompare();
  });
}

// Continents and countries actually present in the catalogue, named not coded.
var CONTINENTS = (function () {
  var seen = {};
  Object.keys(COUNTRIES).forEach(function (cc) {
    var c = COUNTRIES[cc][1]; if (c) seen[c] = 1;
  });
  return Object.keys(seen).sort();
})();

function countryList(continent) {
  return Object.keys(COUNTRIES)
    .filter(function (cc) { return !continent || COUNTRIES[cc][1] === continent; })
    .map(function (cc) { return [cc, COUNTRIES[cc][0]]; })
    .sort(function (a, b) { return a[1] < b[1] ? -1 : 1; });
}

// Display filters. They decide which rows are worth showing; every place is
// always ranked and the anchor's value never changes.
function rowFilter(bounds) {
  var minPop = state.minPop, cont = state.continent, cc = state.country;
  return function (i) {
    var r = rows[i];
    if (minPop && r[7] < minPop) return false;
    if (cc) { if (r[4] !== cc) return false; }
    else if (cont) { var m = COUNTRIES[r[4]]; if (!m || m[1] !== cont) return false; }
    for (var b = 0; b < bounds.length; b++) {
      var v = bounds[b].values[i];
      if (bounds[b].min != null && v < bounds[b].min) return false;
      if (bounds[b].max != null && v > bounds[b].max) return false;
    }
    return true;
  };
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

var refineTimer;
/* Favourites, side by side on one measure. Same indexes as everything else,
   so this costs no extra network once a measure is loaded. */
async function showFavourites() {
  show("favs");
  var spec = METRICS[state.metric];
  $("#favSub").textContent = spec.label + " · "
    + (state.period < 0 ? "annual" : MONTHS[state.period]) + " · " + state.year;
  renderFavPeriods();

  var box = $("#favResults");
  if (!state.favs.length) {
    box.innerHTML = '<p class="meta">No favourites yet. Open a place and press '
      + "“Save place” to add it here.</p>";
    $("#favSource").textContent = "";
    return;
  }
  box.innerHTML = '<p class="meta">Loading…</p>';

  var index = await buildIndex(state.metric, state.year, state.period);
  var rowsOut = state.favs.map(function (c) {
    return { city: c, value: index.values[c.idx] };
  }).sort(function (a, b) { return a.value - b.value; });

  var lo = rowsOut[0].value, hi = rowsOut[rowsOut.length - 1].value, span = hi - lo || 1;
  box.innerHTML = "";
  rowsOut.forEach(function (r) {
    var tier = spec.comfort ? dewTier(r.value) : null;
    var el = document.createElement("div");
    el.className = "row fav";
    el.innerHTML =
      '<div><div class="nm">' + r.city.name
        + (tier ? ' <span class="tier ' + tier.cls + '">' + tier.label + "</span>" : "")
      + '</div><div class="wh">'
        + [r.city.region, r.city.country].filter(Boolean).join(", ") + "</div></div>"
      + '<div class="favbar"><span style="width:'
        + (12 + (r.value - lo) / span * 88).toFixed(1) + '%"></span></div>'
      + '<div class="val">' + fmt(r.value, state.metric)
        + '<span class="vu">' + unitOf(state.metric) + "</span></div>"
      + '<button class="details" type="button">Open</button>'
      + '<button class="details drop" type="button" title="Remove">✕</button>';
    el.querySelectorAll(".details")[0].addEventListener("click", function () {
      selectCity(r.city);
    });
    el.querySelector(".drop").addEventListener("click", function () {
      toggleFav(r.city); showFavourites();
    });
    box.appendChild(el);
  });

  $("#favSource").textContent = "Ranked among your saved places only. ERA5 reanalysis, "
    + state.year + ", 0.25° grid" + (spec.derived ? " · derived value" : "");
}

function renderFavPeriods() {
  var box = $("#favPeriods");
  box.innerHTML = "";
  var mk = function (label, p) {
    var b = document.createElement("button");
    b.textContent = label;
    b.setAttribute("aria-pressed", String(state.period === p));
    b.addEventListener("click", function () {
      state.period = p; store.set("period", p); showFavourites();
    });
    box.appendChild(b);
  };
  mk("Year", -1);
  MONTHS.forEach(function (m, i) { mk(m, i); });

  var sel = document.createElement("select");
  sel.className = "pill";
  sel.title = "Measure";
  Object.keys(METRICS).forEach(function (k) {
    var o = document.createElement("option");
    o.value = k; o.textContent = METRICS[k].label; o.selected = k === state.metric;
    sel.appendChild(o);
  });
  sel.addEventListener("change", function () {
    state.metric = sel.value; store.set("metric", state.metric); showFavourites();
  });
  box.appendChild(sel);
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

async function showOverall() {
  show("overall");
  renderOvWeights();
  if (!state.city) return;
  $("#ovProgress").hidden = false;
  $("#ovResults").innerHTML = "";
  await new Promise(function (r) { setTimeout(r, 0); });

  var anchor = state.city.idx, comps = [], names = [], i, k;

  // 1. climate similarity, standardised across every climate measure
  var climKeys = Object.keys(METRICS).filter(function (m) { return !METRICS[m].statik; });
  var dims = [];
  for (k = 0; k < climKeys.length; k++) {
    var v = (await buildIndex(climKeys[k], state.year, -1)).values;
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

  if (PM25) { comps.push({ key: "air", pct: percentiles(PM25.values, true) }); names.push("air quality"); }

  var lv = livValues(), anyLiv = false;
  for (i = 0; i < N; i++) if (isFinite(lv[i])) { anyLiv = true; break; }
  if (anyLiv) { comps.push({ key: "settling", pct: percentiles(lv, false) }); names.push("settling in"); }

  var wsum = 0;
  comps.forEach(function (c) { wsum += (ovWeights[c.key] || 0); });
  if (!wsum) wsum = 1;

  var score = new Float32Array(N), pass = rowFilter([]);
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
    + " \u00b7 relative to " + state.city.name + " \u00b7 " + state.year;

  var box = $("#ovResults");
  box.innerHTML = "";
  top.forEach(function (idx, rank) {
    var c = describe(idx);
    var el = document.createElement("div");
    el.className = "row ov" + (idx === anchor ? " anchor" : "");
    var parts = comps.map(function (cm) {
      return '<span class="ovpart"><i>' + cm.key.slice(0, 3) + "</i>"
        + Math.round(cm.pct[idx]) + "</span>";
    }).join("");
    el.innerHTML =
      '<div class="ovrank">' + (rank + 1) + "</div>"
      + '<div><div class="nm">' + c.name + livBadge(c.cc) + linksFor(c) + "</div>"
      + '<div class="wh">' + [c.region, c.country].filter(Boolean).join(", ") + "</div></div>"
      + '<div class="ovparts">' + parts + "</div>"
      + '<div class="val">' + score[idx].toFixed(0) + '<span class="vu">/100</span></div>'
      + '<button class="details" type="button">Open</button>';
    el.querySelector(".details").addEventListener("click", function () { selectCity(c); });
    box.appendChild(el);
  });

  $("#ovSource").textContent = "Each component becomes a percentile before blending, "
    + "so units never dominate. Climate similarity is measured against "
    + state.city.name + "; air quality and settling-in are absolute. "
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

function renderRefine() {
  var body = $("#refineBody");
  body.innerHTML = "";
  Object.keys(METRICS).forEach(function (key) {
    var spec = METRICS[key], r = state.ranges[key] || {};
    var wrap = document.createElement("div");
    wrap.className = "rf";
    wrap.innerHTML =
      '<span class="rf-ic" style="color:' + spec.tint + '">' + svgIcon(spec.icon) + "</span>"
      + '<span class="rf-l">' + spec.label + "</span>"
      + '<input class="rf-i" type="number" step="any" placeholder="min"'
        + (r.min != null ? ' value="' + r.min + '"' : "") + ">"
      + '<input class="rf-i" type="number" step="any" placeholder="max"'
        + (r.max != null ? ' value="' + r.max + '"' : "") + ">"
      + '<span class="rf-u">' + spec.unit + "</span>";
    var ins = wrap.querySelectorAll(".rf-i");
    var upd = function () {
      state.ranges[key] = {
        min: ins[0].value === "" ? null : +ins[0].value,
        max: ins[1].value === "" ? null : +ins[1].value,
      };
      store.set("ranges", state.ranges);
  paintStatus();
      markRefine();
      clearTimeout(refineTimer);
      refineTimer = setTimeout(runCompare, 350);   // settle before refetching
    };
    ins[0].addEventListener("change", upd);
    ins[1].addEventListener("change", upd);
    ins[0].addEventListener("input", upd);
    ins[1].addEventListener("input", upd);
    body.appendChild(wrap);
  });

  var clr = document.createElement("button");
  clr.className = "linkish";
  clr.textContent = "Clear all filters";
  clr.addEventListener("click", function () {
    state.ranges = {};
    store.set("ranges", {});
    renderRefine(); markRefine(); runCompare();
  });
  body.appendChild(clr);
  markRefine();
}

// Values are filtered in the metric's own base unit, which the panel labels.
function markRefine() {
  var n = activeRanges().length;
  $("#refineLabel").textContent = n
    ? "Refine — " + n + " active" : "Refine by other measures";
  $("#refine").classList.toggle("on", n > 0);
}

/* Air quality can't be ranked: ERA5 carries no aerosols, so there is no global
   index to binary-search. What we can do honestly is fetch it for the ~21 places
   actually on screen, which sits well inside the free rate limit. It is LIVE
   data from a different source than the climate figures, and is labelled so. */
var aqCache = {}, aqSeq = 0;

var AQ_BANDS = [[10,"Good","aq1"],[20,"Fair","aq2"],[25,"Moderate","aq3"],
                [50,"Poor","aq4"],[75,"Very poor","aq5"],[1e9,"Hazardous","aq6"]];
function aqBand(v){ for (var i=0;i<AQ_BANDS.length;i++) if (v < AQ_BANDS[i][0]) return AQ_BANDS[i]; }

function paintAir(entry) {
  var hit = aqCache[entry.c.id];
  if (!hit || !entry.el.isConnected) return;
  var chips = entry.el.querySelector(".chips");
  if (!chips || chips.querySelector(".aq")) return;
  var band = aqBand(hit.pm25);
  var sp = document.createElement("span");
  sp.className = "chip aq " + band[2];
  sp.innerHTML = "<em>AQ</em><b>" + hit.pm25.toFixed(0) + "</b><i>µg/m³ " + band[1] + "</i>";
  sp.title = "PM2.5 right now, " + band[1] + " — live reading, not a climate average";
  chips.appendChild(sp);
}

async function decorateAir(entries) {
  var mine = ++aqSeq;
  entries.forEach(paintAir);                       // anything already known
  var need = entries.filter(function (e) { return !aqCache[e.c.id]; });
  if (!need.length) return;
  try {
    var la = need.map(function (e) { return e.c.lat; }).join(",");
    var lo = need.map(function (e) { return e.c.lon; }).join(",");
    var r = await fetch("https://air-quality-api.open-meteo.com/v1/air-quality"
      + "?latitude=" + la + "&longitude=" + lo + "&current=pm2_5");
    if (!r.ok) return;
    var j = await r.json();
    if (!Array.isArray(j)) j = [j];
    if (mine !== aqSeq) return;
    need.forEach(function (e, i) {
      var cur = j[i] && j[i].current;
      if (cur && cur.pm2_5 != null) aqCache[e.c.id] = { pm25: cur.pm2_5 };
    });
    need.forEach(paintAir);
  } catch (err) { /* air quality is a bonus; never break the comparison */ }
}

var compareSeq = 0;
async function runCompare() {
  var mine = ++compareSeq, spec = METRICS[state.metric];
  // Liveability is genuinely annual-only; air quality now has monthly fields.
  var period = (spec.statik && !spec.monthly) ? -1 : state.period;
  $("#cmpTitle").textContent = spec.label + " closest to " + state.city.name;
  $("#cmpSub").textContent = ((spec.statik && !spec.monthly) ? "annual only" :
      period < 0 ? "annual" : MONTHS[period]) + " · " + state.year;
  $("#progress").hidden = false;
  phase("Preparing");

  try {
    var index = await buildIndex(state.metric, state.year, state.period);

    // Each constraining measure needs its own layer; they load on demand.
    var act = activeRanges(), bounds = [];
    for (var a = 0; a < act.length; a++) {
      phase("Applying " + METRICS[act[a].metric].label.toLowerCase() + " filter");
      var bi = await buildIndex(act[a].metric, state.year, state.period);
      bounds.push({ values: bi.values, min: act[a].min, max: act[a].max });
    }
    if (mine !== compareSeq) return;          // a newer request owns the screen

    // Monthly shape of the active metric — same layer, so this costs no network.
    var monthly = null;
    if (!spec.statik || spec.monthly) {
      monthly = [];
      for (var mm = 0; mm < 12; mm++)
        monthly.push((await buildIndex(state.metric, state.year, mm)).values);
    }

    // Any other measure whose layers are already loaded rides along for free.
    var extras = [];
    var mk = Object.keys(METRICS);
    for (var e = 0; e < mk.length; e++) {
      if (mk[e] === state.metric) continue;
      var need = METRICS[mk[e]].vars, have = true;
      for (var nv = 0; nv < need.length; nv++)
        if (!varCache[need[nv] + ":" + state.year]) { have = false; break; }
      if (have) extras.push({ key: mk[e],
        values: (await buildIndex(mk[e], state.year,
                   (METRICS[mk[e]].statik && !METRICS[mk[e]].monthly) ? -1 : period)).values });
    }
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
    $("#results").innerHTML = '<p class="err">' + err.message + "</p>";
  } finally {
    // Whoever is newest owns the spinner; stale runs must not strand it.
    if (mine === compareSeq) $("#progress").hidden = true;
  }
}

function renderResults(index, anchor, nb, monthly, extras) {
  var m = state.metric, spec = METRICS[m];
  var slot = $("#anchorSlot"), lowBox = $("#lowerCol"), highBox = $("#higherCol");
  slot.innerHTML = ""; lowBox.innerHTML = ""; highBox.innerHTML = "";
  var box = slot;                      // row() appends to whatever box points at
  var visible = [];

  var row = function (entry, isAnchor) {
    var idx = isAnchor ? state.city.idx : entry.idx;
    var c = describe(idx), value = index.values[idx];
    // A div rather than a button, so the details control can nest inside it.
    var el = document.createElement("div");
    el.className = "row" + (isAnchor ? " anchor" : "");
    var tier = spec.comfort ? dewTier(value) : null;
    var shared = !isAnchor && entry.shared
      ? ' <span class="wh">+' + entry.shared.toLocaleString() + " more at this value</span>" : "";
    el.innerHTML =
      '<div><div class="nm">' + c.name + livBadge(c.cc)
        + (tier ? ' <span class="tier ' + tier.cls + '">' + tier.label + "</span>" : "")
      + '</div><div class="wh">' + [c.region, c.country].filter(Boolean).join(", ")
        + shared + linksFor(c) + '</div><div class="chips"></div></div>' 
      + '<div class="spark-cell"></div>'
      + '<div class="val">' + fmt(value, m) + '<span class="vu">' + unitOf(m) + "</span></div>"
      + '<div class="dl">' + (isAnchor ? "here" : fmtDelta(value - anchor, m)) + "</div>"
      + '<button class="rowfav" type="button" title="Save this place">'
        + svgIcon(STAR) + "</button>"
      + '<button class="details" title="Every measure for this place">Details</button>';

    var star = el.querySelector(".rowfav");
    var paintStar = function () {
      var on = isFav(c.id);
      star.classList.toggle("on", on);
      star.title = on ? "Saved — click to remove" : "Save this place";
    };
    paintStar();
    star.addEventListener("click", function (ev) {
      ev.stopPropagation();            // starring is not a re-anchor
      toggleFav(c);
      paintStar();
      paintStatus();
    });

    // Chips for whatever else is already known about this place.
    if (extras && extras.length) {
      var chips = el.querySelector(".chips");
      extras.forEach(function (x) {
        var sp = document.createElement("button");
        sp.className = "chip";
        sp.type = "button";
        sp.style.setProperty("--tint", METRICS[x.key].tint);
        sp.innerHTML = svgIcon(METRICS[x.key].icon)
          + "<b>" + fmt(x.values[idx], x.key) + "</b>"
          + "<i>" + unitOf(x.key) + "</i>";
        sp.title = "Compare " + METRICS[x.key].label.toLowerCase() + " from " + c.name;
        sp.addEventListener("click", function (ev) {
          ev.stopPropagation();              // not a re-anchor on the old metric
          state.city = c;
          store.set("city", c);
          openCompare(x.key);                // same place, different measure
        });
        chips.appendChild(sp);
      });
    }
    if (monthly) el.querySelector(".spark-cell").appendChild(rowSpark(monthly, idx, spec));

    el.querySelector(".details").addEventListener("click", function (ev) {
      ev.stopPropagation();          // don't also re-anchor
      selectCity(c);
    });
    if (!isAnchor) {
      el.tabIndex = 0;
      el.addEventListener("click", function (ev) {
        if (ev.target.closest("a,button")) return;   // links and buttons act alone
        reanchor(c);
      });
      el.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); reanchor(c); }
      });
    }
    visible.push({ c: c, el: el });
    box.appendChild(el);
  };

  // Your place sits on top; the two directions read away from it in parallel.
  box = slot;
  row(null, true);

  $("#lowerBand").textContent = nb.below.length
    ? "Lower \u2014 " + nb.below.length + " steps down" : "Nothing lower";
  $("#higherBand").textContent = nb.above.length
    ? "Higher \u2014 " + nb.above.length + " steps up" : "Nothing higher";

  box = lowBox;
  nb.below.forEach(function (e) { row(e, false); });
  box = highBox;
  nb.above.forEach(function (e) { row(e, false); });

  decorateAir(visible);

  $("#cmpSource").textContent =
    "Ranked against all " + N.toLocaleString() + " settlements in the GeoNames catalogue, "
    + "purely by " + spec.label.toLowerCase() + " value. ERA5 reanalysis, " + state.year
    + ", 0.25° grid" + (spec.derived ? " · derived value" : "")
    + (spec.note ? " · " + spec.note : "")
    + " · AQ chips are live PM2.5 (Open-Meteo), not a climate average"
    + (state.country ? " · showing only " + COUNTRIES[state.country][0]
       : state.continent ? " · showing only " + state.continent : "");
}

// Clicking a neighbour re-anchors, keeping the metric and the period.
function reanchor(city) {
  state.city = city;
  store.set("city", city);
  $("#placeName").textContent = city.name;
  $("#placeMeta").textContent = [city.region, city.country].filter(Boolean).join(", ");
  runCompare();
}

/* ------------------------------------------------------------------ chrome */

var yearSel = $("#year");
YEARS.forEach(function (y) {
  var o = document.createElement("option");
  o.value = y; o.textContent = y; o.selected = y === state.year;
  yearSel.appendChild(o);
});
yearSel.addEventListener("change", function () {
  state.year = +yearSel.value; store.set("year", state.year);
  if (state.city) selectCity(state.city);
});

var unitBtn = $("#unit");
var paintUnit = function () { unitBtn.textContent = state.fahrenheit ? "°F" : "°C"; };
paintUnit();
unitBtn.addEventListener("click", function () {
  // Pure formatting — never a refetch, never a rebuild.
  state.fahrenheit = !state.fahrenheit;
  store.set("fahrenheit", state.fahrenheit);
  paintUnit();
  if (!$("#compare").hidden) runCompare();
  else if (!$("#profile").hidden && state.city) selectCity(state.city);
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

$("#ovBtn").addEventListener("click", showOverall);
$("#favBtn").addEventListener("click", showFavourites);
$("#sbFav").addEventListener("click", function () {
  if (state.city) { toggleFav(state.city); paintFavStar(state.city); paintStatus(); }
});
$("#sbClear").addEventListener("click", function () {
  state.minPop = 0; state.continent = ""; state.country = ""; state.ranges = {};
  store.set("minPop", 0); store.set("continent", ""); store.set("country", "");
  store.set("ranges", {});
  if (!$("#compare").hidden) { renderPeriods(); renderRefine(); runCompare(); }
  paintStatus();
});
paintFavCount();
renderRecents();
$("#q").disabled = false;
note(N.toLocaleString() + " places ready. Climate data loads when you pick a figure.");

// A refresh should land you back where you were, not re-ask for permission.
if (state.city && typeof state.city.idx === "number") selectCity(state.city);

})();
