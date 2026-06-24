"""Human-readable report: per-item table, per-category breakdown, red/green headline."""

from __future__ import annotations

from . import gate as G


def _bar(passed: bool) -> str:
    return "PASS" if passed else "FAIL"


def render(rows: list[G.Row], result: G.GateResult, *, prompt_version: str, coverage_flags: int) -> str:
    out: list[str] = []
    out.append("=" * 78)
    out.append(f"PLAIN-LANGUAGE EVAL  ·  prompt={prompt_version}  ·  items={result.n_items}")
    out.append("=" * 78)

    # Per-item table (sorted hardest-first so regressions are at the top).
    out.append("")
    out.append(f"{'passage':10} {'cat':10} {'tier':5} {'model':9} {'delta':>8} {'harder':>6} {'jargon':>6}")
    out.append("-" * 78)
    for r in sorted(rows, key=lambda x: -x.delta):
        jl = ",".join(r.jargon_lemmas[:3]) if r.jargon_lemmas else ""
        out.append(
            f"{r.passage_id:10} {r.category:10} {r.tier:5} {r.model:9} {r.delta:8.3f} "
            f"{'YES' if r.harder_than_source else '.':>6} {r.n_jargon:>6}  {jl}"
        )

    # Per-category breakdown.
    out.append("")
    out.append("PER-CATEGORY (harder-than-source count):")
    cats: dict[str, list[G.Row]] = {}
    for r in rows:
        cats.setdefault(r.category, []).append(r)
    for cat in sorted(cats):
        cr = cats[cat]
        n_h = sum(1 for r in cr if r.harder_than_source)
        med = sorted(r.delta for r in cr)[len(cr) // 2] if cr else 0.0
        flag = "  <-- OVER LIMIT" if n_h > 1 else ""
        out.append(f"  {cat:12} items={len(cr):3}  harder={n_h:3}  median_delta={med:7.3f}{flag}")

    # Gate conditions.
    out.append("")
    out.append("GATE CONDITIONS:")
    for c in result.conditions:
        out.append(f"  [{_bar(c.passed)}] {c.name:26} {c.detail}")

    if coverage_flags:
        out.append("")
        out.append(f"NOTE: {coverage_flags} item(s) flagged LOW lexicon coverage (archaic/proper-heavy); read their D with caution.")

    # Failing items detail.
    if result.failing_items:
        out.append("")
        out.append("FAILING / FLAGGED ITEMS:")
        for r in result.failing_items[:25]:
            reason = []
            if r.harder_than_source:
                reason.append(f"harder(+{r.delta:.3f})")
            if r.n_jargon:
                reason.append(f"jargon[{','.join(r.jargon_lemmas)}]")
            out.append(f"  {r.passage_id}/{r.tier}/{r.model}: {'; '.join(reason)}")

    out.append("")
    out.append("-" * 78)
    out.append(
        f"  harder-than-source: {result.n_harder}/{result.n_items}   "
        f"median delta: {result.median_delta:.3f}   undefined-hard-words: {result.n_undefined_hard}"
        + (f"   judge-pass: {result.judge_pass_rate:.2f}" if result.judge_pass_rate is not None else "")
    )
    out.append("=" * 78)
    out.append(f"HEADLINE: {result.headline}")
    out.append("=" * 78)
    return "\n".join(out)
