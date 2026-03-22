"""
sovereign-signal/ticker_map.py

Maps organisation names (from NER) → stock tickers.
Covers the top ~300 US defence, aerospace, cyber, and big-tech
government contractors that regularly appear in SAM.gov awards.
"""

# Canonical company name fragments → ticker
# Matching is case-insensitive substring. Longer strings take priority.
_MAP: dict[str, str] = {
    # ── Defence primes ────────────────────────────────────────────────────────
    "lockheed martin":          "LMT",
    "lockheed":                 "LMT",
    "raytheon":                 "RTX",
    "rtx":                      "RTX",
    "northrop grumman":         "NOC",
    "northrop":                 "NOC",
    "general dynamics":         "GD",
    "boeing":                   "BA",
    "huntington ingalls":       "HII",
    "l3harris":                 "LHX",
    "l3 harris":                "LHX",
    "harris corporation":       "LHX",
    "leidos":                   "LDOS",
    "saic":                     "SAIC",
    "science applications":     "SAIC",
    "booz allen":               "BAH",
    "booz allen hamilton":      "BAH",
    "palantir":                 "PLTR",
    "kratos":                   "KTOS",
    "aeroviro":                 "AVAV",
    "aerovironment":            "AVAV",
    "caci":                     "CACI",
    "mantech":                  "MANT",
    "bae systems":              "BAESY",
    "textron":                  "TXT",
    "transdigm":                "TDG",
    "curtiss-wright":           "CW",
    "heico":                    "HEI",
    "moog":                     "MOG.A",
    "ducommun":                 "DCO",
    "vectrus":                  "VEC",
    "parsons":                  "PSN",
    "amentum":                  "AMTM",
    "peraton":                  None,    # private
    "leidos holdings":          "LDOS",
    "general atomics":          None,    # private

    # ── Cyber / Intelligence ──────────────────────────────────────────────────
    "crowdstrike":              "CRWD",
    "palo alto networks":       "PANW",
    "fortinet":                 "FTNT",
    "mandiant":                 "MNDT",
    "solarwinds":               "SWI",
    "tenable":                  "TENB",
    "sailpoint":                "SAIL",
    "varonis":                  "VRNS",
    "rapid7":                   "RPD",
    "qualys":                   "QLYS",
    "verint":                   "VRNT",
    "axonius":                  None,    # private

    # ── Cloud / Tech with large gov contracts ─────────────────────────────────
    "microsoft":                "MSFT",
    "amazon web services":      "AMZN",
    "amazon":                   "AMZN",
    "google":                   "GOOGL",
    "alphabet":                 "GOOGL",
    "oracle":                   "ORCL",
    "ibm":                      "IBM",
    "dell":                     "DELL",
    "hp inc":                   "HPQ",
    "hewlett packard enterprise":"HPE",
    "accenture":                "ACN",
    "deloitte":                 None,    # private
    "pwc":                      None,    # private
    "cgtech":                   None,    # private
    "snowflake":                "SNOW",
    "servicenow":               "NOW",
    "salesforce":               "CRM",

    # ── Space ─────────────────────────────────────────────────────────────────
    "spacex":                   None,    # private
    "rocket lab":               "RKLB",
    "virgin galactic":          "SPCE",
    "maxar":                    "MAXR",
    "planet labs":              "PL",
    "blacksky":                 "BKSY",
    "spire global":             "SPIR",

    # ── Semiconductors / Hardware ─────────────────────────────────────────────
    "nvidia":                   "NVDA",
    "intel":                    "INTC",
    "amd":                      "AMD",
    "qualcomm":                 "QCOM",
    "texas instruments":        "TXN",
    "broadcom":                 "AVGO",
}


def resolve_tickers(org_names: list[str]) -> list[str]:
    """
    Given a list of org name strings from NER, return a deduplicated list
    of stock tickers. Names are matched case-insensitively against _MAP keys.
    """
    tickers: list[str] = []
    for name in org_names:
        lower = name.lower().strip()
        # Try longest-match first so "lockheed martin" beats "lockheed"
        best = None
        best_len = 0
        for key, ticker in _MAP.items():
            if ticker and key in lower and len(key) > best_len:
                best = ticker
                best_len = len(key)
        if best and best not in tickers:
            tickers.append(best)
    return tickers
