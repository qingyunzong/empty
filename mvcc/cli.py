"""JSON-lines CLI for the MVCC store.

Reads one JSON command object per line from stdin, writes one JSON
response per line to stdout. Any command-level error is reported as
{"ok": false, ...} and makes the process exit with status 10.

Commands:
  {"cmd": "init",   "replicas": 3, "max_keys": 500, "max_versions": 5000}
  {"cmd": "begin",  "txn": "t1", "replica": "r0", "ctx": {...}, "timeout_ms": 100}
  {"cmd": "read",   "txn": "t1", "key": "k"}
  {"cmd": "write",  "txn": "t1", "key": "k", "value": 42}
  {"cmd": "commit", "txn": "t1"}
  {"cmd": "abort",  "txn": "t1"}
  {"cmd": "gc"}
"""

from __future__ import annotations

import json
import sys

from .errors import MvccError
from .store import MVCCStore

EXIT_ERROR = 10


def _execute(store, req):
    cmd = req.get("cmd")
    if cmd == "init":
        store = MVCCStore(
            num_replicas=int(req.get("replicas", 3)),
            max_keys=int(req.get("max_keys", 500)),
            max_versions=int(req.get("max_versions", 5000)),
        )
        return store, {"ok": True}
    if store is None:
        store = MVCCStore()
    if cmd == "begin":
        ctx = store.begin(
            req["txn"],
            ctx=req.get("ctx"),
            replica=req.get("replica"),
            timeout_ms=req.get("timeout_ms"),
        )
        return store, {"ok": True, "txn": req["txn"], "ctx": ctx}
    if cmd == "read":
        value = store.read(req["txn"], req["key"])
        return store, {"ok": True, "value": value, "found": value is not None}
    if cmd == "write":
        store.write(req["txn"], req["key"], req.get("value"))
        return store, {"ok": True}
    if cmd == "commit":
        ctx = store.commit(req["txn"])
        return store, {"ok": True, "txn": req["txn"], "ctx": ctx}
    if cmd == "abort":
        store.abort(req["txn"])
        return store, {"ok": True}
    if cmd == "gc":
        watermark, collected = store.gc()
        return store, {"ok": True, "watermark": watermark,
                       "collected": collected}
    raise MvccError("BAD_REQUEST", "unknown command %r" % (cmd,))


def main(argv=None, stdin=None, stdout=None):
    stdin = stdin if stdin is not None else sys.stdin
    stdout = stdout if stdout is not None else sys.stdout
    store = None
    had_error = False
    for lineno, line in enumerate(stdin, 1):
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            if not isinstance(req, dict):
                raise MvccError("BAD_REQUEST", "command must be a JSON object")
            store, resp = _execute(store, req)
        except MvccError as exc:
            resp = {"ok": False, "error": exc.code, "message": exc.message}
            had_error = True
        except (KeyError, TypeError, ValueError) as exc:
            resp = {"ok": False, "error": "BAD_REQUEST",
                    "message": "line %d: %s" % (lineno, exc)}
            had_error = True
        stdout.write(json.dumps(resp) + "\n")
        stdout.flush()
    return EXIT_ERROR if had_error else 0


if __name__ == "__main__":
    raise SystemExit(main())
