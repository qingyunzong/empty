"""Persistent cache of known failures.

Cache keys are a hash of the property name, the generator spec, the
property expression, the generator version and the failing value.  Because
the generator version is part of the key, changing generator semantics
invalidates old entries automatically.  A corrupt or unreadable cache file
is treated as empty so it can never mask failures.
"""

import hashlib
import json
import os

CACHE_FORMAT = 1


def make_key(property_name, gen, expr, gen_version, value):
    payload = {
        "property": property_name,
        "gen": gen,
        "expr": expr,
        "gen_version": gen_version,
        "value": value,
    }
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


class Cache:
    def __init__(self, path=None):
        self.path = path
        self.entries = {}
        if path and os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as handle:
                    raw = json.load(handle)
            except (OSError, json.JSONDecodeError):
                raw = None
            if isinstance(raw, dict) and isinstance(raw.get("failures"), dict):
                self.entries = dict(raw["failures"])

    def get(self, key):
        return self.entries.get(key)

    def add(self, key, record):
        self.entries[key] = record

    def discard(self, key):
        self.entries.pop(key, None)

    def save(self):
        if not self.path:
            return
        tmp_path = self.path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as handle:
            json.dump(
                {"format": CACHE_FORMAT, "failures": self.entries},
                handle,
                indent=2,
                sort_keys=True,
            )
        os.replace(tmp_path, self.path)
