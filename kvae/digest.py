"""Bucket digests: 16 fixed equal-width buckets over key space [0, 255].

digest(bucket) == 0 for an empty bucket; otherwise a deterministic fold of
(key, version-vector) pairs ordered by sorted key.
"""

import hashlib
import json

NUM_BUCKETS = 16
BUCKET_SIZE = 16  # 256 keys / 16 buckets


def bucket_of(key):
    return key // BUCKET_SIZE


def _entry_bytes(key, entry):
    return json.dumps(
        [key, entry["vv"]], sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def bucket_digest(items):
    """items: iterable of (key, entry). Empty bucket -> 0."""
    ordered = sorted(items, key=lambda pair: pair[0])
    if not ordered:
        return 0
    state = b""
    for key, entry in ordered:
        state = hashlib.sha256(state + _entry_bytes(key, entry)).digest()
    return int.from_bytes(state, "big")


def replica_digests(rep):
    """Return [digest per bucket] for a replica."""
    buckets = [[] for _ in range(NUM_BUCKETS)]
    for skey, entry in rep["data"].items():
        key = int(skey)
        buckets[bucket_of(key)].append((key, entry))
    return [bucket_digest(items) for items in buckets]
