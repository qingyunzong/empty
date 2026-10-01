"""JSON-lines CLI for the snapshot isolation engine.

Reads one JSON command per line from stdin, writes one JSON response per
line to stdout. Every command carries a "cmd" field; transactional commands
also carry a "txn" field identifying the transaction.

Commands:
  {"cmd": "begin",  "txn": "t1"}                       -> {"ok": true, "snapshot": N}
  {"cmd": "read",   "txn": "t1", "key": "x"}           -> {"ok": true, "value": V|null}
  {"cmd": "write",  "txn": "t1", "key": "x", "value": V} -> {"ok": true}
  {"cmd": "commit", "txn": "t1"}                       -> {"ok": true, "commit_ts": N}
                                                        | {"error": "WRITE_CONFLICT", "conflicts": [...]}
  {"cmd": "abort",  "txn": "t1"}                       -> {"ok": true}
  {"cmd": "dump"}                                      -> {"ok": true, "state": {...}}

Errors are reported as {"error": CODE, ...}; the CLI never crashes on bad
input, it answers with an error object instead.
"""

from __future__ import annotations

import json
import sys
from typing import IO, Any, Dict

from .engine import (
    Engine,
    TransactionStateError,
    UnknownTransactionError,
    WriteConflictError,
)


def handle(engine: Engine, request: Dict[str, Any]) -> Dict[str, Any]:
    cmd = request.get("cmd")
    try:
        if cmd == "begin":
            snapshot = engine.begin(_require(request, "txn"))
            return {"ok": True, "snapshot": snapshot}
        if cmd == "read":
            value = engine.read(_require(request, "txn"), _require(request, "key"))
            return {"ok": True, "value": value}
        if cmd == "write":
            engine.write(
                _require(request, "txn"),
                _require(request, "key"),
                request.get("value"),
            )
            return {"ok": True}
        if cmd == "commit":
            commit_ts = engine.commit(_require(request, "txn"))
            return {"ok": True, "commit_ts": commit_ts}
        if cmd == "abort":
            engine.abort(_require(request, "txn"))
            return {"ok": True}
        if cmd == "dump":
            return {"ok": True, "state": engine.snapshot_state()}
        return {"error": "BAD_COMMAND", "cmd": cmd}
    except WriteConflictError as exc:
        return {"error": "WRITE_CONFLICT", "conflicts": exc.conflicts}
    except UnknownTransactionError:
        return {"error": "UNKNOWN_TXN", "txn": request.get("txn")}
    except TransactionStateError as exc:
        return {"error": "TXN_STATE", "detail": str(exc)}
    except (KeyError, TypeError) as exc:
        return {"error": "BAD_REQUEST", "detail": str(exc)}


def _require(request: Dict[str, Any], field: str) -> Any:
    if field not in request:
        raise KeyError(f"missing field {field!r}")
    return request[field]


def run(engine: Engine, instream: IO[str], outstream: IO[str]) -> None:
    for line in instream:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            response: Dict[str, Any] = {"error": "BAD_JSON", "detail": str(exc)}
        else:
            if not isinstance(request, dict):
                response = {"error": "BAD_REQUEST", "detail": "expected a JSON object"}
            else:
                response = handle(engine, request)
        outstream.write(json.dumps(response) + "\n")
        outstream.flush()


def main() -> None:
    run(Engine(), sys.stdin, sys.stdout)


if __name__ == "__main__":
    main()
