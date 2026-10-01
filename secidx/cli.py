"""JSON-lines CLI for secidx.

Reads one JSON command object per line on stdin, writes one JSON
response object per line on stdout.

Commands:
  {"op": "begin"}                                  -> {"ok": true, "txn": N}
  {"op": "commit", "txn": N}                       -> {"ok": true}
  {"op": "abort",  "txn": N}                       -> {"ok": true}
  {"op": "create_index", "name": S, "field": S, "unique": B}
  {"op": "insert", "txn": N, "pk": K, "fields": {...}}
  {"op": "update", "txn": N, "pk": K, "fields": {...}}
  {"op": "delete", "txn": N, "pk": K}
  {"op": "find", "index": S, "key": V, "txn": N?}  -> {"ok": true, "rows": [...]}
  {"op": "scan", "index": S, "start": V?, "end": V?, "txn": N?}
                                                   -> {"ok": true, "rows": [...]}

Errors: {"ok": false, "error": CODE, "message": S}; a unique-index
conflict reports "error": "UNIQUE_VIOLATION" and rolls the transaction
back with no partial effects. Empty query results return "rows": [].
"""

import json
import sys

from .store import Store, SecIdxError, BadRequest


def _require(cmd, *names):
    for name in names:
        if name not in cmd:
            raise BadRequest("missing field: %r" % name)
    return [cmd[n] for n in names]


def handle(store, cmd):
    if not isinstance(cmd, dict):
        raise BadRequest("command must be a JSON object")
    op = cmd.get("op")
    if op == "begin":
        txn = store.begin()
        return {"ok": True, "txn": txn.tid}
    if op == "commit":
        store.commit(store.get_txn(cmd.get("txn")))
        return {"ok": True}
    if op == "abort":
        store.abort(store.get_txn(cmd.get("txn")))
        return {"ok": True}
    if op == "create_index":
        _require(cmd, "name", "field")
        idx = store.create_index(cmd["name"], cmd["field"],
                                 bool(cmd.get("unique", False)))
        return {"ok": True, "index": idx.name,
                "field": idx.field, "unique": idx.unique}
    if op == "insert":
        _require(cmd, "txn", "pk", "fields")
        store.insert(store.get_txn(cmd["txn"]), cmd["pk"], cmd["fields"])
        return {"ok": True}
    if op == "update":
        _require(cmd, "txn", "pk", "fields")
        store.update(store.get_txn(cmd["txn"]), cmd["pk"], cmd["fields"])
        return {"ok": True}
    if op == "delete":
        _require(cmd, "txn", "pk")
        store.delete(store.get_txn(cmd["txn"]), cmd["pk"])
        return {"ok": True}
    if op == "find":
        _require(cmd, "index", "key")
        txn = store.get_txn(cmd["txn"]) if cmd.get("txn") is not None else None
        rows = store.find(txn, cmd["index"], cmd["key"])
        return {"ok": True, "rows": rows}
    if op == "scan":
        _require(cmd, "index")
        txn = store.get_txn(cmd["txn"]) if cmd.get("txn") is not None else None
        rows = store.scan(txn, cmd["index"],
                          cmd.get("start"), cmd.get("end"))
        return {"ok": True, "rows": rows}
    raise BadRequest("unknown op: %r" % (op,))


def main(stream=None, out=None):
    stream = stream if stream is not None else sys.stdin
    out = out if out is not None else sys.stdout
    store = Store()
    for line in stream:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError as exc:
            resp = {"ok": False, "error": "BAD_JSON", "message": str(exc)}
        else:
            try:
                resp = handle(store, cmd)
            except SecIdxError as exc:
                resp = {"ok": False, "error": exc.code, "message": str(exc)}
            except Exception as exc:  # defensive: never crash the loop
                resp = {"ok": False, "error": "INTERNAL", "message": str(exc)}
        out.write(json.dumps(resp) + "\n")
        out.flush()
