"""Find-back validation of the astronaut-walk route matcher.

A distorted copy of each Moon test route is hidden among the Earth transect library; a good matcher
should rank that copy first. Run with ``python -m pipeline.walkval``; writes
``web/public/data/walk/findback.json``. See ``docs/walk-findback.md``.
"""
