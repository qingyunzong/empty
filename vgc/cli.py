"""JSON-lines CLI for the vgc MVCC garbage collector.

Reads one JSON object per line from stdin, writes one JSON object per line
to stdout.  Supported ops:

  {"op": "config", "max_versions": 3}
  {"op": "begin",  "txn": "t1"}                    -> {"status": "OK", "snapshot_ts": N}
  {"op": "put",    "txn": "t1", "key": "k", "value": V}
  {"op": "commit", "txn": "t1"}                    -> {"status": "OK", "commit_ts": N}
  {"op": "abort",  "txn": "t1"}
  {"op": "get",    "txn": "t1", "key": "k"}
  {"op": "gc"}                                     -> {"status": "OK"|"GC_DEFERRED", ...}
  {"op": "as_of",  "key": "k", "ts": N}            -> OK / NOT_FOUND / SNAPSHOT_EXPIRED
  {"op": "stats"}
"""

from __future__ import annotations

import argparse
import json
import sys

from .core import (
    ERROR,
    GC_DEFERRED,
    NOT_FOUND,
    OK,
    SNAPSHOT_EXPIRED,
    MVCCStore,
    SnapshotExpired,
    TxnError,
)


def _require(request: dict, *fields: str):
    missing = [f for f in fields if f not in request]
    if missing:
        raise ValueError(f"missing field(s): {', '.join(missing)}")
    return [request[f] for f in fields]


def handle(store: MVCCStore, request: dict) -> dict:
    op = request.get("op")
    if op == "config":
        (max_versions,) = _require(request, "max_versions")
        if max_versions is not None:
            max_versions = int(max_versions)
            if max_versions < 1:
                raise ValueError("max_versions must be >= 1")
        store.max_versions = max_versions
        return {"status": OK, "max_versions": store.max_versions}
    if op == "begin":
        (txn,) = _require(request, "txn")
        return {"status": OK, "snapshot_ts": store.begin(txn)}
    if op == "put":
        txn, key, value = _require(request, "txn", "key", "value")
        store.put(txn, key, value)
        return {"status": OK}
    if op == "commit":
        (txn,) = _require(request, "txn")
        return {"status": OK, "commit_ts": store.commit(txn)}
    if op == "abort":
        (txn,) = _require(request, "txn")
        store.abort(txn)
        return {"status": OK}
    if op == "get":
        txn, key = _require(request, "txn", "key")
        value = store.get(txn, key)
        if value is None:
            return {"status": NOT_FOUND}
        return {"status": OK, "value": value}
    if op == "gc":
        result = store.gc()
        return {
            "status": result.status,
            "collected": result.collected,
            "low_watermark": result.low_watermark,
            "deferred_keys": result.deferred_keys,
            "versions_remaining": result.versions_remaining,
        }
    if op == "as_of":
        key, ts = _require(request, "key", "ts")
        try:
            value = store.as_of(key, int(ts))
        except SnapshotExpired as exc:
            return {"status": SNAPSHOT_EXPIRED, "key": exc.key, "ts": exc.ts}
        if value is None:
            return {"status": NOT_FOUND}
        return {"status": OK, "value": value}
    if op == "stats":
        return {"status": OK, **store.stats()}
    raise ValueError(f"unknown op: {op!r}")


def serve(store: MVCCStore, stdin, stdout) -> None:
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("request must be a JSON object")
            response = handle(store, request)
        except SnapshotExpired as exc:
            response = {"status": SNAPSHOT_EXPIRED, "key": exc.key, "ts": exc.ts}
        except (TxnError, ValueError, KeyError, TypeError) as exc:
            response = {"status": ERROR, "error": str(exc)}
        stdout.write(json.dumps(response) + "\n")
        stdout.flush()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="vgc", description="MVCC version garbage collector (JSON-lines protocol)"
    )
    parser.add_argument(
        "--max-versions",
        type=int,
        default=None,
        help="per-key version budget (default: unlimited)",
    )
    args = parser.parse_args(argv)
    store = MVCCStore(max_versions=args.max_versions)
    serve(store, sys.stdin, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
