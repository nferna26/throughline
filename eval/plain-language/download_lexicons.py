#!/usr/bin/env python3
"""Optional: fetch the Kuperman age-of-acquisition norms into vendor/aoa_kuperman.csv.

The harness runs fully offline WITHOUT this file: wordfreq (rarity) + Dale-Chall
(familiarity) are bundled and carry the gate, and the difficulty blend re-normalizes
over the available signals, logging AoA coverage as 0. AoA strengthens the blend when
present.

Kuperman, Stadthagen-Gonzalez & Brysbaert (2012), Behavior Research Methods 44(4).
The canonical source is the Ghent CRR page; mirrors come and go, so this tries a few
and validates. If all fail, download "AoA_ratings_Kuperman_et_al_BRM.xlsx" by hand
from a CRR mirror, keep the columns Word + Rating.Mean, and save it as
vendor/aoa_kuperman.csv (CSV) here.
"""

from __future__ import annotations

import csv
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "vendor", "aoa_kuperman.csv")

MIRRORS = [
    "https://raw.githubusercontent.com/lcompton1/AoA/master/AoA_ratings_Kuperman_et_al_BRM.csv",
    "https://raw.githubusercontent.com/ArtsEngine/concreteness/master/AoA_ratings_Kuperman_et_al_BRM.csv",
    "http://crr.ugent.be/papers/AoA_ratings_Kuperman_et_al_BRM.zip",
]


def _looks_like_aoa(text: str) -> bool:
    head = text[:2000].lower()
    return "word" in head and ("rating.mean" in head or "aoa_kup" in head or "rating_mean" in head)


def _normalize_to_csv(raw: bytes) -> str | None:
    # Try plain CSV first.
    try:
        text = raw.decode("utf-8", errors="replace")
    except Exception:
        text = ""
    if _looks_like_aoa(text):
        return text
    # Try a zip containing an .xlsx or .csv.
    try:
        import zipfile

        zf = zipfile.ZipFile(io.BytesIO(raw))
        for name in zf.namelist():
            if name.lower().endswith(".csv"):
                t = zf.read(name).decode("utf-8", errors="replace")
                if _looks_like_aoa(t):
                    return t
            if name.lower().endswith(".xlsx"):
                import openpyxl

                wb = openpyxl.load_workbook(io.BytesIO(zf.read(name)), read_only=True)
                ws = wb.active
                rows = ws.iter_rows(values_only=True)
                header = [str(c) for c in next(rows)]
                buf = io.StringIO()
                w = csv.writer(buf)
                w.writerow(header)
                for r in rows:
                    w.writerow(["" if c is None else c for c in r])
                t = buf.getvalue()
                if _looks_like_aoa(t):
                    return t
    except Exception:
        pass
    return None


def main() -> int:
    import urllib.request

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    for url in MIRRORS:
        try:
            with urllib.request.urlopen(url, timeout=45) as resp:
                raw = resp.read()
            csv_text = _normalize_to_csv(raw)
            if csv_text and len(csv_text) > 200_000:
                with open(OUT, "w", encoding="utf-8") as fh:
                    fh.write(csv_text)
                n = csv_text.count("\n")
                print(f"OK: wrote {OUT} (~{n} rows) from {url}")
                return 0
            print(f"  skip (not valid AoA / too small): {url}")
        except Exception as e:
            print(f"  fail {url}: {e}")
    print(
        "\nCould not auto-fetch AoA. The harness still runs WITHOUT it (rarity + Dale-Chall "
        "carry the gate). To add AoA: download AoA_ratings_Kuperman_et_al_BRM.xlsx from a CRR "
        "mirror, keep columns Word + Rating.Mean, save as CSV at vendor/aoa_kuperman.csv."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
