#!/usr/bin/env python3
"""Regenerate the committed judge verdicts for a recorded run, using the SHIPPING rubric.

CORE-1169 audit fix (gaps 1, 2, 4, 5): the combined-gate GREEN depended on judge verdicts
that were never committed (an untracked cache) and whose rubric provenance was unverifiable
(no rubric fingerprint, and no per-item reasoning). This tool re-judges every (source,
explanation) in a recorded run.json with the CURRENT judge rubric (judge.RUBRIC, fingerprinted
into every cache key), capturing the judge's reasoning, into a committed fixture cache.

It is the one authorized model step. Once the fixture is committed, the gate reproduces from
it with NO model calls (see verify_gate.py) and is auditable per item (reasoning is stored).

Resumable + progress-logging: verdicts are flushed per chunk, and already-cached items
(same model + rubric + id + text hash) are skipped, so a re-run resumes where it stopped.

  python regen_run_verdicts.py --run reports/run.json \
      --out fixtures/core_1169_judge_verdicts.json --judge local:gpt-oss:20b
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from plaineval import judge as JU  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default=os.path.join(HERE, "reports", "run.json"))
    ap.add_argument("--out", required=True, help="committed verdict cache path")
    ap.add_argument("--judge", default="local:gpt-oss:20b")
    ap.add_argument("--chunk", type=int, default=25)
    args = ap.parse_args()

    run = json.load(open(args.run, encoding="utf-8"))
    items = [
        {"id": it.get("id", it.get("key")), "source": it["source"], "explanation": it["explanation"]}
        for it in run["items"]
    ]
    model_label = args.judge.split(":", 1)[1] if ":" in args.judge else args.judge
    judge = JU.make_judge(args.judge)
    n = len(items)
    sys.stdout.write(
        f"regenerating {n} verdicts | judge={model_label} | rubric_fp={JU.RUBRIC_FP} "
        f"| out={os.path.relpath(args.out, HERE)}\n"
    )
    sys.stdout.flush()

    t0 = time.time()
    done = 0
    stragglers: list[str] = []
    for i in range(0, n, args.chunk):
        chunk = items[i : i + args.chunk]
        # score_items_cached flushes the whole cache after this chunk (resumable) and
        # skips any item already present under the exact (model, rubric, id, text) key.
        # A local judge call can time out transiently under GPU contention; retry the
        # chunk (only the still-missing items are re-judged) so one hiccup does not kill
        # a 90-minute run. After repeated failure, skip and report the stragglers.
        for attempt in range(1, 6):
            try:
                JU.score_items_cached(judge, chunk, args.out, model_label=model_label)
                break
            except Exception as e:  # noqa: BLE001 - transient network/model failure
                if attempt == 5:
                    stragglers += [it["id"] for it in chunk]
                    sys.stdout.write(f"  chunk {i} FAILED after 5 tries ({e}); skipping\n")
                    sys.stdout.flush()
                    break
                time.sleep(min(30, 3 * attempt))
        done += len(chunk)
        elapsed = time.time() - t0
        rate = elapsed / done if done else 0
        eta = rate * (n - done)
        sys.stdout.write(
            f"  {done}/{n}  ({elapsed/60:.1f} min elapsed, ~{eta/60:.0f} min left, {rate:.1f}s/item)\n"
        )
        sys.stdout.flush()
    if stragglers:
        sys.stdout.write(f"WARNING: {len(stragglers)} items unjudged after retries; re-run to finish: {stragglers[:5]}...\n")

    cache = json.load(open(args.out, encoding="utf-8"))
    with_reason = sum(1 for v in cache.values() if (v.get("reasoning") or "").strip())
    sys.stdout.write(
        f"DONE: {len(cache)} verdicts in {(time.time()-t0)/60:.1f} min; "
        f"{with_reason} carry reasoning; all keyed by model|rubric_fp|id|text_sha.\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
