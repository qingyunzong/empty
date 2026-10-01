"""JSON-lines CLI for the snapshot-isolation engine.

Protocol: one JSON object per line on stdin, one JSON object per line on
stdout. Every command carries a "cmd" field; transactional commands also
carry a "txn" field identifying the transaction.

Commands:
  {"cmd": "begin",  "txn": "t1"}                      -> {"ok": true, "snapshot": N}
  {"cmd": "read",   "txn": "t1", "key": "x"}          -> {"ok": true, "value": V|null}
  {"cmd": "write",  "txn": "t1", "key": "x", "value": V} -> {"ok": true}
  {"cmd": "commit", "txn": "t1"}                      -> {"ok": true} | {"error": "WRITE_CONFLICT"}
  {"cmd": "abort",  "txn": "t1"}                      -> {"ok": true}
  {"cmd": "dump"}                                     -> {"ok": true, "state": {...}}

Errors are reported as {"error": CODE}, e.g. UNKNOWN_TXN, TXN_EXISTS,
UNKNOWN_COMMAND, INVALID_COMMAND.
"""

from __future__ import annotations

import json
import sys

from .engine import Engine, TransactionExists, UnknownTransaction, WriteConflict


def handle(engine: Engine, request: dict) -> dict:
    cmd = request.get("cmd")
    if not isinstance(cmd, str):
        return {"error": "INVALID_COMMAND"}
    txn_id = request.get("txn")

    try:
        if cmd == "begin":
            if txn_id is None:
                return {"error": "INVALID_COMMAND"}
            txn = engine.begin(str(txn_id))
            return {"ok": True, "snapshot": txn.snapshot_ts}
        if cmd == "dump":
            return {"ok": True, "state": engine.snapshot_state()}
        if txn_id is None:
            return {"error": "INVALID_COMMAND"}
        txn_id = str(txn_id)
        if cmd == "read":
            key = request.get("key")
            if not isinstance(key, str):
                return {"error": "INVALID_COMMAND"}
            return {"ok": True, "value": engine.read(txn_id, key)}
        if cmd == "write":
            key = request.get("key")
            if not isinstance(key, str) or "value" not in request:
                return {"error": "INVALID_COMMAND"}
            engine.write(txn_id, key, request["value"])
            return {"ok": True}
        if cmd == "commit":
            engine.commit(txn_id)
            return {"ok": True}
        if cmd == "abort":
            engine.abort(txn_id)
            return {"ok": True}
        return {"error": "UNKNOWN_COMMAND"}
    except WriteConflict:
        return {"error": "WRITE_CONFLICT"}
    except UnknownTransaction:
        return {"error": "UNKNOWN_TXN"}
    except TransactionExists:
        return {"error": "TXN_EXISTS"}


def main(stream=None, out=None) -> None:
    stream = stream if stream is not None else sys.stdin
    out = out if out is not None else sys.stdout
    engine = Engine()
    for line in stream:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            response = {"error": "INVALID_JSON"}
        else:
            if not isinstance(request, dict):
                response = {"error": "INVALID_COMMAND"}
            else:
                response = handle(engine, request)
        out.write(json.dumps(response) + "\n")
        out.flush()


if __name__ == "__main__":
    main()
