"""
sovereign-contracts/resolver.py

Resolves SAM.gov awardee company names to stock tickers.
Uses the same mapping logic as signal/ticker_map.py but as
a standalone module for the contracts service.
"""

_MAP = {
    "lockheed martin": "LMT",
    "lockheed": "LMT",
    "raytheon": "RTX",
    "rtx corporation": "RTX",
    "northrop grumman": "NOC",
    "general dynamics": "GD",
    "boeing": "BA",
    "huntington ingalls": "HII",
    "l3harris": "LHX",
    "l3 technologies": "LHX",
    "leidos": "LDOS",
    "saic": "SAIC",
    "science applications international": "SAIC",
    "booz allen hamilton": "BAH",
    "booz allen": "BAH",
    "palantir": "PLTR",
    "kratos defense": "KTOS",
    "kratos": "KTOS",
    "aerovironment": "AVAV",
    "caci international": "CACI",
    "caci": "CACI",
    "mantech": "MANT",
    "bae systems": "BAESY",
    "textron": "TXT",
    "transdigm": "TDG",
    "curtiss-wright": "CW",
    "heico": "HEI",
    "vectrus": "VEC",
    "parsons corporation": "PSN",
    "parsons": "PSN",
    "amentum": "AMTM",
    "microsoft": "MSFT",
    "amazon web services": "AMZN",
    "amazon": "AMZN",
    "google": "GOOGL",
    "alphabet": "GOOGL",
    "oracle": "ORCL",
    "ibm": "IBM",
    "dell technologies": "DELL",
    "dell": "DELL",
    "hewlett packard enterprise": "HPE",
    "hp enterprise": "HPE",
    "accenture": "ACN",
    "snowflake": "SNOW",
    "servicenow": "NOW",
    "crowdstrike": "CRWD",
    "palo alto networks": "PANW",
    "fortinet": "FTNT",
    "rocket lab": "RKLB",
    "maxar": "MAXR",
    "planet labs": "PL",
    "blacksky": "BKSY",
    "nvidia": "NVDA",
    "intel": "INTC",
    "qualcomm": "QCOM",
}


def awardee_to_ticker(awardee: str) -> str | None:
    """Case-insensitive longest-match lookup."""
    lower = awardee.lower().strip()
    best, best_len = None, 0
    for key, ticker in _MAP.items():
        if key in lower and len(key) > best_len:
            best, best_len = ticker, len(key)
    return best
