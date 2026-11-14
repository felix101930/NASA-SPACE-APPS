"""CLI: python -m pipeline.walkval [--routes 300] [--seed 2026]

Re-runnable: reads walk/transects.* and the Moon tiles fresh every time and overwrites
walk/findback.json.
"""
from __future__ import annotations

import argparse
import logging
import time
from pathlib import Path

from pipeline.common.config import WEB_DATA
from pipeline.walkval.findback import evaluate, write

log = logging.getLogger("pipeline.walkval")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--routes", type=int, default=300)
    ap.add_argument("--seed", type=int, default=2026)
    ap.add_argument("--out", default=str(WEB_DATA / "walk" / "findback.json"))
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s",
                        datefmt="%H:%M:%S")
    t0 = time.perf_counter()
    result = evaluate(WEB_DATA, n_routes=args.routes, seed=args.seed)
    write(result, Path(args.out))
    for m in result["matchers"]:
        log.info("%-22s top1=%.3f top5=%.3f median_rank=%s ms/query=%.1f", m["name"], m["top1"], m["top5"],
                 m["median_rank"], m["ms_per_query"])
    log.info("winner: %s (%.0f s total)", result["winner"], time.perf_counter() - t0)


if __name__ == "__main__":
    main()
