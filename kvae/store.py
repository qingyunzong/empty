"""Replica state: load/save, seed, put."""

import json
import random

MIN_KEY = 0
MAX_KEY = 255


class StoreError(Exception):
    pass


def validate_key(key):
    if not isinstance(key, int) or isinstance(key, bool):
        raise StoreError(f"key must be an integer, got {key!r}")
    if key < MIN_KEY or key > MAX_KEY:
        raise StoreError(f"key {key} out of range [{MIN_KEY}, {MAX_KEY}]")
    return key


def new_replica(replica_id):
    if not replica_id:
        raise StoreError("replica id must be non-empty")
    return {"id": replica_id, "data": {}, "conflicts": []}


def load(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            rep = json.load(fh)
    except OSError as exc:
        raise StoreError(f"cannot read replica {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise StoreError(f"replica {path} is not valid JSON: {exc}") from exc
    if not isinstance(rep, dict) or "id" not in rep or "data" not in rep:
        raise StoreError(f"replica {path} missing 'id'/'data' fields")
    rep.setdefault("conflicts", [])
    return rep


def save(rep, path):
    try:
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(rep, fh, sort_keys=True)
            fh.write("\n")
    except OSError as exc:
        raise StoreError(f"cannot write replica {path}: {exc}") from exc


def put(rep, key, value):
    """Local write: bump this replica's counter in the version vector."""
    validate_key(key)
    skey = str(key)
    entry = rep["data"].get(skey)
    vv = dict(entry["vv"]) if entry else {}
    vv[rep["id"]] = vv.get(rep["id"], 0) + 1
    rep["data"][skey] = {"value": value, "vv": vv}
    return rep["data"][skey]


def seed(replica_id, num_keys, seed_value):
    """Deterministically generate a replica with random keys/values."""
    if num_keys < 0 or num_keys > 256:
        raise StoreError(f"keys must be in [0, 256], got {num_keys}")
    rng = random.Random(seed_value)
    rep = new_replica(replica_id)
    for key in rng.sample(range(MIN_KEY, MAX_KEY + 1), num_keys):
        put(rep, key, f"v{rng.randrange(1_000_000)}")
    return rep
