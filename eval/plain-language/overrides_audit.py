#!/usr/bin/env python3
"""Audit the judge OVERRIDES the combined-gate GREEN depends on, from committed fixtures.

The lexical spine alone flags 72/960 items as "harder"; the combined gate is GREEN only
because the judge OVERRIDES most of those (a borderline lexical flag the judge reads as
confidently plain). That is a lot of trust placed in the judge, so this makes every override
auditable and checks the honesty invariants:

  * an override may fire ONLY on a borderline lexical flag (0 < delta < OVERRIDE_DELTA_MAX)
    with a confidently-plain judge (score >= PLAIN_FLOOR). If ANY override cleared a
    genuinely-harder item (delta >= OVERRIDE_DELTA_MAX), the green is inflated -> reported LOUD.
  * every override carries the judge's stated reason (regenerated with reasoning), so a human
    can check the call.

Outputs (committed):
  reports/core_1169_overrides_audit.md   - every override + every judge-added catch, with reasons
  reports/core_1169_review_worksheet.md  - a deterministic sample for Nick to grade by hand

  python overrides_audit.py
"""
from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from plaineval import judge as JU  # noqa: E402
from plaineval import referee as RF  # noqa: E402

RUN = os.path.join(HERE, "fixtures", "core_1169_run.json")
VERDICTS = os.path.join(HERE, "fixtures", "core_1169_judge_verdicts.json")
AUDIT_MD = os.path.join(HERE, "reports", "core_1169_overrides_audit.md")
WORKSHEET_MD = os.path.join(HERE, "reports", "core_1169_review_worksheet.md")
JUDGE_LABEL = "gpt-oss:20b"


class _CacheOnly(JU.Judge):
    name = JUDGE_LABEL

    def score(self, source, explanation):  # pragma: no cover
        raise RuntimeError("verdict missing from committed fixture cache; run regen_run_verdicts.py")


def _rows():
    run = json.load(open(RUN, encoding="utf-8"))
    items = run["items"]
    for it in items:
        it.setdefault("id", it.get("key"))
    scores = JU.score_items_cached(
        _CacheOnly(),
        [{"id": it["id"], "source": it["source"], "explanation": it["explanation"]} for it in items],
        VERDICTS,
        model_label=JUDGE_LABEL,
    )
    rows = []
    for it in items:
        # Committed deterministic lexical scores (from the recorded run), not recomputed.
        lex_harder = it["lex_harder"]
        lex_delta = it["lex_delta"]
        lex_njargon = it["lex_n_jargon"]
        s = scores[it["id"]]
        c = RF.combine(
            lexical_harder=lex_harder,
            lexical_delta=lex_delta,
            lexical_jargon=lex_njargon,
            judge_score=s["score"],
            judge_q3=s["q3"],
        )
        rows.append({"it": it, "harder": lex_harder, "delta": lex_delta, "njargon": lex_njargon,
                     "lemmas": it.get("lex_jargon_lemmas", []), "s": s, "c": c})
    return rows


def _fmt(r):
    it, s, c = r["it"], r["s"], r["c"]
    return (
        f"- **{it['category']} / {it['id']}** (tier {it['tier']}, model {it['model']})  \n"
        f"  lexical delta `{r['delta']:+.3f}` | judge score `{s['score']}` q3(no-register)=`{s['q3']}` "
        f"| jargon lemmas: {r['lemmas'] or 'none'}  \n"
        f"  SOURCE: {it['source'][:300]}  \n"
        f"  ANSWER: {it['explanation'][:400]}  \n"
        f"  JUDGE REASON: {(s.get('reasoning') or '(none)')[:400]}\n"
    )


def main() -> int:
    rows = _rows()
    overrides = [r for r in rows if r["harder"] and not r["c"].harder]
    adds = [r for r in rows if r["c"].harder and not r["harder"]]
    jargon_overrides = [r for r in rows if r["njargon"] > 0 and not r["c"].jargon]

    # Honesty invariants: an override must be borderline (delta < cap) AND judge-confident.
    cap = RF.DEFAULT_OVERRIDE_DELTA_MAX
    floor = RF.DEFAULT_JUDGE_PLAIN_FLOOR
    inflated = [r for r in overrides if not (0.0 < r["delta"] < cap) or r["s"]["score"] < floor]

    os.makedirs(os.path.dirname(AUDIT_MD), exist_ok=True)
    with open(AUDIT_MD, "w", encoding="utf-8") as fh:
        fh.write("# CORE-1169 judge-override audit (from committed fixtures)\n\n")
        fh.write(
            f"Lexical-harder items: {sum(1 for r in rows if r['harder'])}/960. "
            f"After the judge override the combined gate flags "
            f"{sum(1 for r in rows if r['c'].harder)}/960 as harder.\n\n"
            f"- **Harder overrides** (lexical said harder, judge cleared): **{len(overrides)}**\n"
            f"- **Judge-added harder catches** (lexical missed, judge caught): **{len(adds)}**\n"
            f"- **Jargon overrides** (lexical jargon, judge cleared): **{len(jargon_overrides)}**\n\n"
            f"Override rule: fires only when `0 < delta < {cap}` AND `judge score >= {floor}`.\n\n"
        )
        if inflated:
            fh.write(
                f"## ⚠️ HONESTY FLAG: {len(inflated)} override(s) fired OUTSIDE the borderline rule "
                f"(delta >= {cap} or judge score < {floor}) — the green may be inflated:\n\n"
            )
            for r in inflated:
                fh.write(_fmt(r))
            fh.write("\n")
        else:
            fh.write(
                f"## Honesty check: PASS — every one of the {len(overrides)} harder overrides is "
                f"borderline (delta < {cap}) with a confident-plain judge (score >= {floor}). "
                f"No genuinely-harder item was silenced.\n\n"
            )
        fh.write("## All harder overrides (the 8th-grade call the green rests on)\n\n")
        for r in sorted(overrides, key=lambda r: (r["it"]["category"], -r["delta"])):
            fh.write(_fmt(r))
        fh.write("\n## All judge-added harder catches\n\n")
        for r in sorted(adds, key=lambda r: (r["it"]["category"], r["s"]["score"])):
            fh.write(_fmt(r))

    # Human-review worksheet: deterministic stratified sample (no RNG) - a few overrides per
    # category + a few plain non-flagged outputs, for Nick to grade against the 8th-grade bar.
    def stratified(pool, per_cat):
        by_cat: dict = {}
        for r in sorted(pool, key=lambda r: r["it"]["id"]):
            by_cat.setdefault(r["it"]["category"], []).append(r)
        picked = []
        for cat, rs in sorted(by_cat.items()):
            step = max(1, len(rs) // per_cat)
            picked += rs[::step][:per_cat]
        return picked

    plain_real = [r for r in rows if not r["c"].harder and not r["c"].jargon and r["delta"] < -0.3]
    sample_over = stratified(overrides, 3)
    sample_real = stratified(plain_real, 2)
    with open(WORKSHEET_MD, "w", encoding="utf-8") as fh:
        fh.write("# CORE-1169 human-review worksheet (Nick)\n\n")
        fh.write(
            "Grade each ANSWER against the 8th-grade plain-language bar: is it as easy as or "
            "easier than the SOURCE, with no undefined hard words? Write PLAIN or HARDER in the "
            "call column. The machine verdict is shown so you can spot disagreements.\n\n"
            "## A) Overrides the machine cleared (spot-check the green)\n\n"
        )
        for r in sample_over:
            fh.write(_fmt(r))
            fh.write("  YOUR CALL: ____________\n\n")
        fh.write("## B) Plain outputs the machine passed outright (spot-check the baseline)\n\n")
        for r in sample_real:
            fh.write(_fmt(r))
            fh.write("  YOUR CALL: ____________\n\n")

    print(f"overrides: {len(overrides)} harder, {len(jargon_overrides)} jargon; judge-added: {len(adds)}")
    print(f"honesty: {'PASS (all borderline+confident)' if not inflated else f'FLAG {len(inflated)} out-of-rule'}")
    print(f"wrote {os.path.relpath(AUDIT_MD, HERE)} and {os.path.relpath(WORKSHEET_MD, HERE)}")
    return 1 if inflated else 0


if __name__ == "__main__":
    raise SystemExit(main())
