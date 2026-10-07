"""JSON CLI for the WAL key-value store.

Reads a JSON object from stdin (or a file given as argv[1])::

    {"script": [
        {"op": "begin", "txn": "T1"},
        {"op": "put", "txn": "T1", "key": "a", "value": "1"},
        {"op": "commit", "txn": "T1"},
        {"op": "checkpoint"},
        {"op": "arm", "boundary": "log_sync", "at": 1},
        {"op": "crash"},
        {"op": "recover"}
    ]}

Writes a JSON object to stdout with per-command results, the recovery
trace (each action with its reason) and the final store state.
"""

import json
import sys

from .db import Database
from .storage import CrashError, InMemoryFileAdapter, LogCorruptionError


def run(script, num_pages=16, page_size=1024):
    adapter = InMemoryFileAdapter()
    db = Database(adapter, num_pages=num_pages, page_size=page_size)
    results = []
    trace = []
    for cmd in script:
        op = cmd["op"]
        try:
            if op == "begin":
                result = db.begin(cmd.get("txn"))
            elif op == "put":
                db.put(cmd["txn"], cmd["key"], cmd["value"])
                result = None
            elif op == "get":
                result = db.get(cmd["txn"], cmd["key"])
            elif op == "delete":
                db.delete(cmd["txn"], cmd["key"])
                result = None
            elif op == "commit":
                db.commit(cmd["txn"])
                result = None
            elif op == "abort":
                db.abort(cmd["txn"])
                result = None
            elif op == "checkpoint":
                result = db.checkpoint()
            elif op == "flush":
                db.flush_all()
                result = None
            elif op == "arm":
                adapter.arm(cmd["boundary"], cmd["at"])
                result = None
            elif op == "crash":
                adapter.crash()
                db = Database(adapter, num_pages=num_pages, page_size=page_size)
                result = None
            elif op == "recover":
                db.recover()
                result = None
            else:
                raise ValueError(f"unknown op {op!r}")
            results.append({"op": op, "ok": True, "result": result})
        except (CrashError, LogCorruptionError, ValueError, KeyError) as exc:
            results.append({"op": op, "ok": False, "error": str(exc)})
        trace.extend(db.trace)
        db.trace = []
    return {"results": results, "trace": trace, "state": db.dump()}


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    if argv:
        with open(argv[0], "r", encoding="utf-8") as fh:
            payload = json.load(fh)
    else:
        payload = json.load(sys.stdin)
    out = run(
        payload["script"],
        num_pages=payload.get("num_pages", 16),
        page_size=payload.get("page_size", 1024),
    )
    json.dump(out, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
