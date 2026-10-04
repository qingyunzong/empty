"""Shared helpers for the kvstore test-suite."""

import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from kvstore import Engine, FaultController, FaultyAdapter  # noqa: E402
from kvstore.engine import page_id_for  # noqa: E402


class TempDB:
    """Context manager handing out a fresh DB dir + fault-injected engine."""

    def __init__(self, **cfg):
        self.cfg = {"num_pages": 16, "page_size": 256, "pool_capacity": 4}
        self.cfg.update(cfg)
        self.dir = tempfile.mkdtemp(prefix="kvtest-")
        self.faults = FaultController()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        shutil.rmtree(self.dir, ignore_errors=True)

    def open(self):
        return Engine.open(self.dir, adapter=FaultyAdapter(self.faults),
                           faults=self.faults, **self.cfg)

    def wal_bytes(self) -> bytes:
        with open(os.path.join(self.dir, "wal.log"), "rb") as fh:
            return fh.read()


def keys_on_same_page(num_pages, count=2, prefix="k"):
    """Find `count` distinct keys hashing to the same page."""
    buckets = {}
    i = 0
    while True:
        key = f"{prefix}{i}"
        pid = page_id_for(key, num_pages)
        bucket = buckets.setdefault(pid, [])
        if key not in bucket:
            bucket.append(key)
            if len(bucket) >= count:
                return bucket[:count]
        i += 1


def keys_on_distinct_pages(num_pages, count=2, prefix="p"):
    keys, seen = [], set()
    i = 0
    while len(keys) < count:
        key = f"{prefix}{i}"
        pid = page_id_for(key, num_pages)
        if pid not in seen:
            seen.add(pid)
            keys.append(key)
        i += 1
    return keys
