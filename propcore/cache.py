"""Known-failure cache (the --db file)."""

import json

CACHE_VERSION = 1


def empty_db():
    return {"version": CACHE_VERSION, "failures": {}}


def load_db(path):
    """Load a cache db; a missing/corrupt/foreign file yields an empty db."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return empty_db()
    if (
        not isinstance(data, dict)
        or data.get("version") != CACHE_VERSION
        or not isinstance(data.get("failures"), dict)
    ):
        return empty_db()
    return data


def save_db(path, db):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(db, fh, indent=2, sort_keys=True)
        fh.write("\n")
