"""CLI: python -m pipeline.alberta {all,screen,refine,export,calgary} [--force]

Every step is cached and idempotent; --force recomputes the selected step(s).
"""
from __future__ import annotations

import argparse
import json
import logging
import time

from pipeline.alberta.common import INTERIM, setup_logging

log = logging.getLogger("pipeline.alberta")
TIMES = INTERIM / "step_times.json"


def _times() -> dict:
    return json.loads(TIMES.read_text()) if TIMES.exists() else {}


def _record(step: str, t0: float) -> None:
    t = _times()
    t[step] = round(time.time() - t0, 1)
    TIMES.write_text(json.dumps(t, indent=1))


def run_screen(force: bool) -> tuple[dict, dict, dict]:
    from pipeline.alberta import screen as S
    t0 = time.time()
    win = S.build_windows(force=force)
    fps = S.fingerprint_all(win["rows"], force=force)
    dist = S.compute_distances(win["rows"], fps, force=force or not S.DIST_JSON.exists())
    _record("screen", t0)
    return win, fps, dist


def run_refine(win: dict, dist: dict, force: bool) -> dict:
    from pipeline.alberta import refine as RF
    t0 = time.time()
    rows = {r["id"]: r for r in win["rows"]}
    ids = sorted({t["id"] for s in dist["searches"].values() for t in s["top"]})
    out = RF.refine_many([{"id": i, "lat": rows[i]["lat"], "lon": rows[i]["lon"]} for i in ids], force=force)
    _record("refine", t0)
    return out


def run_export(win: dict, fps: dict, dist: dict, refined: dict) -> None:
    from pipeline.alberta import export as E
    t0 = time.time()
    E.export(win, fps, dist, refined, _times())
    _record("export", t0)


def run_calgary(force: bool) -> dict:
    from pipeline.alberta import calgary_walks as W
    t0 = time.time()
    out = W.run(force=force)
    _record("calgary", t0)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(prog="python -m pipeline.alberta")
    ap.add_argument("step", choices=["all", "screen", "refine", "export", "calgary"], nargs="?", default="all")
    ap.add_argument("--force", action="store_true", help="recompute instead of using caches")
    a = ap.parse_args()
    setup_logging()
    if a.step in ("all", "screen", "refine", "export"):
        win, fps, dist = run_screen(a.force and a.step in ("all", "screen"))
        if a.step != "screen":
            refined = run_refine(win, dist, a.force and a.step in ("all", "refine"))
            run_export(win, fps, dist, refined)
    if a.step in ("all", "calgary"):
        log.info("calgary: %s", run_calgary(a.force))


if __name__ == "__main__":
    main()
