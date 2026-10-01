"""JSON-lines CLI for the vgc MVCC garbage collector.

Reads one JSON object per line from stdin and writes one JSON object
per line to stdout.

Commands:
  {"op": "begin",  "txn": "t1"}                       -> {"ok": true, "snapshot_ts": N}
  {"op": "put",    "txn": "t1", "key": "k", "value": V} -> {"ok": true}
  {"op": "commit", "txn": "t1"}                       -> {"ok": true, "commit_ts": N}
  {"op": "gc"}                                        -> {"ok": true, "status": "GC_OK"|"GC_DEFERRED", ...}
  {"op": "as_of", "ts": N, "key": "k"}                -> {"ok": true, "found": bool, "value": V}
                                                         or {"ok": false, "error": "SNAPSHOT_EXPIRED", ...}
  {"op": "get",   "key": "k"}                         -> {"ok": true, "found": bool, "value": V}
  {"op": "stats"}                                     -> {"ok": true, "stats": {...}}
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Dict, TextIO

from .core import GC_OK, MVCCStore, SnapshotExpired, TxnError


def handle(store: MVCCStore, cmd: Dict[str, Any]) -> Dict[str, Any]:
    op = cmd.get("op")
    if op == "begin":
        snapshot_ts = store.begin(str(cmd["txn"]))
        return {"ok": True, "snapshot_ts": snapshot_ts}
    if op == "put":
        store.put(str(cmd["txn"]), str(cmd["key"]), cmd.get("value"))
        return {"ok": True}
    if op == "commit":
        commit_ts = store.commit(str(cmd["txn"]))
        return {"ok": True, "commit_ts": commit_ts}
    if op == "gc":
        report = store.gc()
        return {"ok": True, **report}
    if op == "as_of":
        key = str(cmd["key"])
        ts = int(cmd["ts"])
        try:
            value = store.as_of(ts, key)
        except SnapshotExpired as exc:
            return {"ok": False, "error": "SNAPSHOT_EXPIRED",
                    "key": exc.key, "ts": exc.ts}
        return {"ok": True, "found": value is not None, "value": value}
    if op == "get":
        value = store.get(str(cmd["key"]))
        return {"ok": True, "found": value is not None, "value": value}
    if op == "stats":
        return {"ok": True, "stats": store.stats()}
    return {"ok": False, "error": f"unknown op: {op!r}"}


def run(store: MVCCStore, fin: TextIO, fout: TextIO) -> None:
    for line in fin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
            if not isinstance(cmd, dict):
                raise ValueError("command must be a JSON object")
            reply = handle(store, cmd)
        except (TxnError, KeyError, TypeError, ValueError) as exc:
            reply = {"ok": False, "error": str(exc)}
        fout.write(json.dumps(reply) + "\n")
        fout.flush()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="vgc", description="MVCC version garbage collector (JSON-lines CLI)"
    )
    parser.add_argument(
        "--max-versions",
        type=int,
        default=3,
        help="per-key version budget (default: 3)",
    )
    args = parser.parse_args(argv)
    store = MVCCStore(max_versions=args.max_versions)
    run(store, sys.stdin, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
