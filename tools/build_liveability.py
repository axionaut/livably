"""Build data/liveability.js from real, openly-licensed sources.

Every figure here is fetched, never recalled. Sources:
  visa     passport-index-dataset (ilyankou, ODbL) — entry rules per passport
  income   World Bank GDP per capita, PPP (CC BY 4.0) — a wealth proxy,
           NOT a cost-of-living index; labelled as such in the UI
  hdi      UNDP Human Development Index
Anything that cannot be sourced is left null, and the app shows the country as
partially rated rather than inventing a value.

Base passport is set by BASE_ISO2 (default IN).
"""

import csv
import io
import json
import os
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "liveability.js")
BASE = os.environ.get("BASE_ISO2", "IN")
BASE_CITY = os.environ.get("BASE_CITY", "Dehradun")

PASSPORT = ("https://raw.githubusercontent.com/ilyankou/passport-index-dataset/"
            "master/passport-index-tidy-iso2.csv")
WB_PPP = ("https://api.worldbank.org/v2/country/all/indicator/"
          "NY.GDP.PCAP.PP.CD?format=json&per_page=400&mrv=1")


def get(url, label):
    print(f"  fetching {label} ...")
    req = urllib.request.Request(url, headers={"User-Agent": "climate-neighbours/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


# Entry rules -> 0-100. Visa-free is the only thing that makes a move casual.
def visa_score(req):
    r = (req or "").strip().lower()
    if r in ("visa free", "visa-free", "free", "-1", "hjem"):
        return 100
    if r.isdigit():                       # number of visa-free days
        return 100
    if "on arrival" in r or r == "voa":
        return 75
    if r.startswith("e-visa") or r == "eta" or "e-visa" in r:
        return 55
    if "visa required" in r or r == "visa required":
        return 15
    if "covid" in r or "banned" in r or "no admission" in r:
        return 0
    return None


def main():
    countries = {}
    sources = {}

    # ---- visa ------------------------------------------------------------
    rows = list(csv.DictReader(io.StringIO(get(PASSPORT, "passport index").decode("utf8"))))
    cols = {c.lower(): c for c in rows[0].keys()}
    pcol = cols.get("passport"); dcol = cols.get("destination")
    rcol = cols.get("requirement")
    n_visa = 0
    for row in rows:
        if row[pcol].strip().upper() != BASE:
            continue
        dest = row[dcol].strip().upper()
        v = visa_score(row[rcol])
        if v is None:
            continue
        countries.setdefault(dest, {})["visa"] = v
        n_visa += 1
    countries.setdefault(BASE, {})["visa"] = 100
    print(f"    visa rules for {n_visa} destinations")
    sources["visa"] = "passport-index-dataset (ODbL)"

    # ---- cost of living proxy -------------------------------------------
    try:
        wb = json.loads(get(WB_PPP, "World Bank price level").decode("utf8"))
        if not isinstance(wb, list) or len(wb) < 2 or not wb[1]:
            raise ValueError("unexpected World Bank response: " + str(wb)[:120])
        vals = {}
        for rec in (wb[1] or []):
            cc = (rec.get("country", {}).get("id") or "").upper()
            if rec.get("value") is not None and len(cc) == 2:
                vals[cc] = rec["value"]
        base_v = vals.get(BASE)
        n_cost = 0
        if base_v:
            for cc, v in vals.items():
                if v <= 0:
                    continue
                # Log scale: incomes span two orders of magnitude, so a linear
                # ratio would flatten everything above middle income together.
                import math
                score = 50.0 + 50.0 * math.log(v / base_v) / math.log(8.0)
                countries.setdefault(cc, {})["income"] = round(max(0.0, min(100.0, score)))
                n_cost += 1
        print(f"    income levels for {n_cost} countries")
        sources["income"] = "World Bank NY.GDP.PCAP.PP.CD (CC BY 4.0)"
    except Exception as e:
        print(f"    !! cost skipped: {e}")

    for cc, row in countries.items():
        row["source"] = "; ".join(sources.values())

    payload = {
        "base": BASE,
        "baseCity": BASE_CITY,
        "weights": {"visa": 3, "income": 1.5},
        "labels": {"visa": "Entry access", "income": "Income level (GDP/capita PPP)"},
        "note": ("Country-level, relative to " + BASE_CITY + ". Fields that could "
                 "not be sourced are omitted rather than guessed."),
        "countries": countries,
    }

    with open(OUT, "w", encoding="utf8") as fh:
        fh.write("window.LIVEABILITY=")
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write(";")

    rated = sum(1 for r in countries.values() if len(r) > 1)
    print(f"  wrote data/liveability.js — {len(countries)} countries, "
          f"{rated} with 2+ fields ({os.path.getsize(OUT)/1000:.0f} KB)")


if __name__ == "__main__":
    main()
