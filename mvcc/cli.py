"""JSON-lines CLI for the MVCC store.

Reads one JSON command per line from stdin, writes one JSON result per
line to stdout. Errors are reported as {"error": CODE} and the process
keeps running.

Commands:
  {"op": "begin",  "mode": "snapshot"|"read_committed"} -> {"txn": N}
  {"op": "get",    "txn": N, "key": K}                  -> {"value": V|null}
  {"op": "put",    "txn": N, "key": K, "value": V}      -> {"ok": true}
  {"op": "delete", "txn": N, "key": K}                  -> {"ok": true}
  {"op": "commit", "txn": N}                            -> {"ok": true, "commit_ts": T}
  {"op": "abort",  "txn": N}                            -> {"ok": true}
"""

from __future__ import annotations

import json
import sys

from . import MVCCError, Store


def execute(store: Store, cmd: dict) -> dict:
    op = cmd.get("op")
    if op == "begin":
        return {"txn": store.begin(cmd.get("mode"))}
    if op == "get":
        return {"value": store.get(cmd["txn"], cmd["key"])}
    if op == "put":
        store.put(cmd["txn"], cmd["key"], cmd.get("value"))
        return {"ok": True}
    if op == "delete":
        store.delete(cmd["txn"], cmd["key"])
        return {"ok": True}
    if op == "commit":
        return {"ok": True, "commit_ts": store.commit(cmd["txn"])}
    if op == "abort":
        store.abort(cmd["txn"])
        return {"ok": True}
    return {"error": "UNKNOWN_OP"}


def main(stream=None, out=None) -> None:
    stream = stream if stream is not None else sys.stdin
    out = out if out is not None else sys.stdout
    store = Store()
    for line in stream:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
            if not isinstance(cmd, dict):
                raise ValueError("command must be a JSON object")
            result = execute(store, cmd)
        except MVCCError as exc:
            result = {"error": exc.code}
        except (json.JSONDecodeError, ValueError):
            result = {"error": "BAD_JSON"}
        except (KeyError, TypeError):
            result = {"error": "BAD_REQUEST"}
        out.write(json.dumps(result) + "\n")
        out.flush()


if __name__ == "__main__":
    main()
