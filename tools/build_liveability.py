"""Build data/liveability.js from real, openly-licensed sources.

Every figure here is fetched, never recalled. Sources:
  visa     passport-index-data (imorte, MIT) — entry rules for every passport
  income   World Bank GDP per capita, PPP (CC BY 4.0) — a wealth proxy,
           NOT a cost-of-living index; labelled as such in the UI
Anything that cannot be sourced is left null, and the app shows the country as
partially rated rather than inventing a value.

The page used to be built for one passport. It now ships the whole matrix —
about 200 passports by 200 destinations, one letter per pair, ~40 KB — and the
visitor picks theirs. Income is stored relative to INCOME_REF (default IN); the
page re-bases it onto the chosen passport by subtraction, which is exact on a
log scale except where a score sat at the 0/100 clamp.
"""

import csv
import io
import json
import math
import os
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "liveability.js")
REF = os.environ.get("INCOME_REF", "IN")

# imorte/passport-index-data keeps the same schema and vocabulary as ilyankou's
# original but is still being refreshed.
PASSPORT = ("https://raw.githubusercontent.com/imorte/passport-index-data/"
            "main/passport-index-tidy-iso2.csv")
WB_PPP = ("https://api.worldbank.org/v2/country/all/indicator/"
          "NY.GDP.PCAP.PP.CD?format=json&per_page=400&mrv=1")

# One letter per passport/destination pair; the page maps letters to scores.
CODES = {"F": 100, "A": 75, "E": 55, "R": 15, "X": 0}


def get(url, label):
    print(f"  fetching {label} ...")
    req = urllib.request.Request(url, headers={"User-Agent": "livably/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


# Entry rules -> a letter. Visa-free is the only thing that makes a move casual.
def visa_code(req):
    r = (req or "").strip().lower()
    if r in ("visa free", "visa-free", "free", "-1", "hjem"):
        return "F"                        # -1 is your own country
    if r.isdigit():                       # number of visa-free days
        return "F"
    if "on arrival" in r or r == "voa":
        return "A"
    if r.startswith("e-visa") or r == "eta" or "e-visa" in r:
        return "E"
    if "visa required" in r:
        return "R"
    if "covid" in r or "banned" in r or "no admission" in r:
        return "X"
    return None


def income_scores():
    """Log-scaled income vs REF: 50 is parity, each 8x step is 50 points."""
    try:
        wb = json.loads(get(WB_PPP, "World Bank GDP per capita PPP").decode("utf8"))
        if not isinstance(wb, list) or len(wb) < 2 or not wb[1]:
            raise ValueError("unexpected World Bank response: " + str(wb)[:120])
        vals = {}
        for rec in wb[1]:
            cc = (rec.get("country", {}).get("id") or "").upper()
            if rec.get("value") is not None and len(cc) == 2:
                vals[cc] = rec["value"]
        ref = vals[REF]
        return {cc: round(max(0.0, min(100.0, 50.0 + 50.0 * math.log(v / ref) / math.log(8.0))))
                for cc, v in vals.items() if v > 0}
    except Exception as e:
        # Keep what the last successful build fetched rather than dropping a
        # whole dimension because one API was unreachable from this machine.
        print(f"    !! World Bank unavailable ({e}); keeping income from {OUT}")
        with open(OUT, encoding="utf8") as fh:
            old = json.loads(fh.read().split("=", 1)[1].rstrip().rstrip(";"))
        return {cc: r["income"] for cc, r in old["countries"].items() if "income" in r}


def main():
    rows = list(csv.DictReader(io.StringIO(get(PASSPORT, "passport index").decode("utf8"))))
    cols = {c.lower(): c for c in rows[0].keys()}
    pcol, dcol, rcol = cols["passport"], cols["destination"], cols["requirement"]

    rules = {}
    for row in rows:
        code = visa_code(row[rcol])
        if code:
            rules.setdefault(row[pcol].strip().upper(), {})[row[dcol].strip().upper()] = code
    for p in rules:
        rules[p][p] = "F"                 # you can always go home
    dests = sorted({d for r in rules.values() for d in r} | set(rules))
    print(f"    {len(rules)} passports x {len(dests)} destinations")

    income = income_scores()
    print(f"    income levels for {len(income)} countries")

    payload = {
        "incomeRef": REF,
        "weights": {"visa": 3, "income": 1.5},
        "labels": {"visa": "Entry access", "income": "Income level (GDP/capita PPP)"},
        "note": ("Country-level, for the passport you hold. Fields that could not "
                 "be sourced are omitted rather than guessed."),
        "source": "passport-index-data (imorte, MIT); World Bank NY.GDP.PCAP.PP.CD (CC BY 4.0)",
        "codes": CODES,
        # Destinations as one string of ISO2 pairs; each passport's row is a
        # string of the same length, "-" where the rule is unknown.
        "dests": "".join(dests),
        "passports": {p: "".join(rules[p].get(d, "-") for d in dests) for p in sorted(rules)},
        "income": income,
    }

    with open(OUT, "w", encoding="utf8") as fh:
        fh.write("window.LIVEABILITY=")
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write(";")
    print(f"  wrote data/liveability.js ({os.path.getsize(OUT) / 1000:.0f} KB)")


if __name__ == "__main__":
    main()
