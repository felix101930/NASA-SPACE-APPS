"""CLI: python -m pipeline.moon {all,regions,windows,compute,validate,fingerprints} [--force]

Every step is idempotent: cached outputs in data/interim/moon and web/public/data/moon are reused
unless --force is given.
"""
from __future__ import annotations

import argparse
import logging
import time

from pipeline.moon.common import setup_logging

log = logging.getLogger("pipeline.moon")

STEPS = ("regions", "windows", "fingerprints", "compute", "validate")


def run_step(step: str, force: bool) -> None:
    t0 = time.time()
    if step == "regions":
        from pipeline.moon.regions import build_regions
        build_regions(force=force)
    elif step == "windows":
        from pipeline.moon.windows import run
        run(force=force)
    elif step == "fingerprints":
        from pipeline.moon.fingerprints import run
        run(force=force)
    elif step == "compute":
        from pipeline.moon.compute import build_regions_json, metrics_ready
        if not metrics_ready():
            log.error("pipeline.metrics not available; skipping compute")
            return
        build_regions_json(force=force)
    elif step == "validate":
        from pipeline.moon.validate_pgda import run
        run(force=force)
    log.info("step %s done in %.1f s", step, time.time() - t0)


def main() -> None:
    ap = argparse.ArgumentParser(prog="python -m pipeline.moon")
    ap.add_argument("step", choices=("all",) + STEPS)
    ap.add_argument("--force", action="store_true", help="recompute even if cached")
    args = ap.parse_args()
    setup_logging()
    steps = STEPS if args.step == "all" else (args.step,)
    # validation feeds pgda numbers into regions.json; in 'all' run it before compute writes JSON
    if args.step == "all":
        steps = ("regions", "windows", "fingerprints", "validate", "compute")
    t0 = time.time()
    for s in steps:
        run_step(s, args.force)
    log.info("pipeline.moon %s finished in %.1f s", args.step, time.time() - t0)


if __name__ == "__main__":
    main()
