"""Two-replica key-value anti-entropy core.

Keys are integers in [0, 255]. Values carry version vectors.
The key space is split into 16 equal-width buckets (16 keys each).
A bucket digest is a deterministic hash folded over sorted keys.
"""
from __future__ import annotations

import hashlib
import json

NUM_BUCKETS = 16
KEY_SPACE = 256
BUCKET_WIDTH = KEY_SPACE // NUM_BUCKETS  # 16 keys per bucket

DEFAULT_MAX_ROUNDS = 8
DEFAULT_MAX_KEYS_PER_ROUND = 32

COMPLETE = "COMPLETE"
INCOMPLETE = "INCOMPLETE"


class KVError(Exception):
    """User-facing error; CLI maps it to exit code 5."""


def validate_key(key) -> int:
    if isinstance(key, bool) or not isinstance(key, int):
        raise KVError(f"key must be an integer, got {key!r}")
    if not 0 <= key < KEY_SPACE:
        raise KVError(f"key {key} out of range [0, 255]")
    return key


def bucket_of(key: int) -> int:
    return key // BUCKET_WIDTH


def empty_store(replica: str) -> dict:
    return {"replica": replica, "data": {}, "conflicts": []}


def put(store: dict, replica: str, key: int, value: str) -> dict:
    """Local write: bump the writer's component of the version vector."""
    validate_key(key)
    data = store["data"]
    entry = data.get(str(key))
    if entry is None:
        version = {}
    else:
        version = dict(entry["version"])
    version[replica] = version.get(replica, 0) + 1
    data[str(key)] = {"value": value, "version": version}
    return data[str(key)]


def _entry_payload(key: int, value, version: dict) -> bytes:
    return json.dumps(
        [key, value, sorted((str(r), int(c)) for r, c in version.items())],
        separators=(",", ":"),
        sort_keys=False,
    ).encode("utf-8")


def digest_entries(entries) -> int:
    """Digest of one bucket: 0 when empty, else folded over sorted keys."""
    if not entries:
        return 0
    acc = 0
    for key, value, version in sorted(entries, key=lambda e: e[0]):
        block = acc.to_bytes(8, "big") + _entry_payload(key, value, version)
        acc = int.from_bytes(hashlib.sha256(block).digest()[:8], "big")
    return acc


def bucket_summary(store: dict, bucket: int) -> dict:
    """Summary used by the protocol: count + key-xor + digest.

    count/xork let the protocol fall back to per-key exchange even when
    two different bucket contents collide on the digest itself.
    """
    entries = []
    xork = 0
    for raw_key, entry in store["data"].items():
        key = int(raw_key)
        if bucket_of(key) != bucket:
            continue
        entries.append((key, entry["value"], entry["version"]))
        xork ^= key
    return {
        "count": len(entries),
        "xork": xork,
        "digest": digest_entries(entries),
    }


def all_summaries(store: dict) -> list:
    return [bucket_summary(store, b) for b in range(NUM_BUCKETS)]


def compare_versions(v1: dict, v2: dict):
    """-1 if v1 < v2, 1 if v1 > v2, 0 if equal, None if concurrent."""
    less = greater = False
    for replica in set(v1) | set(v2):
        a = v1.get(replica, 0)
        b = v2.get(replica, 0)
        if a < b:
            less = True
        elif a > b:
            greater = True
    if less and greater:
        return None
    if less:
        return -1
    if greater:
        return 1
    return 0


def _snapshot(entry: dict) -> dict:
    return {"value": entry["value"], "version": dict(entry["version"])}


def reconcile(a: dict, b: dict,
              max_rounds: int = DEFAULT_MAX_ROUNDS,
              max_keys_per_round: int = DEFAULT_MAX_KEYS_PER_ROUND) -> dict:
    """Build a reconciliation plan between stores a and b.

    Round 1 exchanges the 16 bucket summaries. Only buckets whose
    summaries differ proceed to per-key version exchange, so the message
    count grows monotonically with the number of differing buckets.
    Each later round resolves at most `max_keys_per_round` keys and the
    protocol stops after `max_rounds` rounds, reporting INCOMPLETE with
    the safely resolved prefix if keys remain.
    """
    if max_rounds < 1:
        raise KVError("max_rounds must be >= 1")
    if max_keys_per_round < 1:
        raise KVError("max_keys_per_round must be >= 1")

    plan = {
        "status": COMPLETE,
        "rounds": 0,
        "messages": 0,
        "pull": [],      # entries a must pull from b
        "push": [],      # entries a must push to b
        "conflict": [],  # concurrent versions; no automatic winner
        "pending": [],   # keys left unresolved when INCOMPLETE
    }

    # Round 1: digest exchange (one message each direction).
    rounds = 1
    messages = 2
    sum_a = all_summaries(a)
    sum_b = all_summaries(b)
    diff_buckets = [i for i in range(NUM_BUCKETS) if sum_a[i] != sum_b[i]]

    if diff_buckets:
        diff_set = set(diff_buckets)
        keys = sorted(
            int(k) for k in set(a["data"]) | set(b["data"])
            if bucket_of(int(k)) in diff_set
        )
        idx = 0
        while idx < len(keys):
            if rounds >= max_rounds:
                plan["status"] = INCOMPLETE
                plan["pending"] = keys[idx:]
                break
            rounds += 1
            messages += 2  # key-version request + response
            chunk = keys[idx:idx + max_keys_per_round]
            idx += len(chunk)
            for key in chunk:
                _classify(a, b, key, plan)

    plan["rounds"] = rounds
    plan["messages"] = messages
    return plan


def _classify(a: dict, b: dict, key: int, plan: dict) -> None:
    ea = a["data"].get(str(key))
    eb = b["data"].get(str(key))
    if ea is None and eb is None:
        return
    if ea is None:
        plan["pull"].append({"key": key, **_snapshot(eb)})
        return
    if eb is None:
        plan["push"].append({"key": key, **_snapshot(ea)})
        return
    if ea["value"] == eb["value"] and ea["version"] == eb["version"]:
        return  # identical despite bucket-summary mismatch (collision)
    order = compare_versions(ea["version"], eb["version"])
    if order == -1:
        plan["pull"].append({"key": key, **_snapshot(eb)})
    elif order == 1:
        plan["push"].append({"key": key, **_snapshot(ea)})
    else:
        # Concurrent versions (or same version, different value):
        # never pick a winner automatically.
        plan["conflict"].append({
            "key": key,
            "a": _snapshot(ea),
            "b": _snapshot(eb),
        })


def apply_plan(plan: dict, a: dict, b: dict) -> dict:
    """Execute a plan: transfer pull/push entries, record conflicts.

    Both replicas append the identical conflict record, so their conflict
    lists stay equal. Returns counts of applied operations.
    """
    applied = 0
    for op in plan.get("pull", []):
        a["data"][str(op["key"])] = {
            "value": op["value"], "version": dict(op["version"])}
        applied += 1
    for op in plan.get("push", []):
        b["data"][str(op["key"])] = {
            "value": op["value"], "version": dict(op["version"])}
        applied += 1
    conflicts = 0
    for c in plan.get("conflict", []):
        record = {
            "key": c["key"],
            "a": {"value": c["a"]["value"], "version": dict(c["a"]["version"])},
            "b": {"value": c["b"]["value"], "version": dict(c["b"]["version"])},
        }
        a["conflicts"].append(record)
        b["conflicts"].append(json.loads(json.dumps(record)))
        conflicts += 1
    return {
        "status": plan.get("status", COMPLETE),
        "applied": applied,
        "conflicts": conflicts,
        "pending": len(plan.get("pending", [])),
    }
