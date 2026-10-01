"""JSON-lines CLI for the MVCC store.

Reads one JSON object per line from stdin and writes one JSON response
per line to stdout.  Semantic errors (WRITE_SKEW, TXN_ABORTED, ...) are
reported as {"ok": false, "error": CODE} and the session continues.
Protocol errors (bad JSON, unknown op, bad arguments) print an error
object and terminate the process with exit code 10.

Commands:
  {"op": "configure", "replicas": 3}                (must come first)
  {"op": "begin",  "txn": "t1", "replica": 0, "ctx": [0,0,0], "timeout_ms": 100}
  {"op": "read",   "txn": "t1", "key": "k"}
  {"op": "write",  "txn": "t1", "key": "k", "value": 42}
  {"op": "commit", "txn": "t1"}
  {"op": "abort",  "txn": "t1"}
  {"op": "gc"}
"""

from __future__ import annotations

import argparse
import json
import sys

from .store import MVCCError, MVCCStore

EXIT_PROTOCOL_ERROR = 10


class ProtocolError(Exception):
    pass


def _require(obj: dict, *fields: str) -> None:
    for f in fields:
        if f not in obj:
            raise ProtocolError(f"missing field {f!r} for op {obj.get('op')!r}")


class Session:
    def __init__(self, num_replicas: int = 3, out=sys.stdout):
        self.store = MVCCStore(num_replicas=num_replicas)
        self.configured = False
        self.out = out

    def handle(self, obj: dict) -> dict:
        op = obj.get("op")
        if not isinstance(op, str):
            raise ProtocolError("missing or invalid 'op' field")
        handler = getattr(self, f"_op_{op}", None)
        if handler is None:
            raise ProtocolError(f"unknown op {op!r}")
        return handler(obj)

    # -- ops -----------------------------------------------------------
    def _op_configure(self, obj: dict) -> dict:
        if self.configured or self.store._txns or self.store._data:
            raise ProtocolError("configure must be the first command")
        _require(obj, "replicas")
        replicas = obj["replicas"]
        if not isinstance(replicas, int) or replicas < 1:
            raise ProtocolError("replicas must be a positive integer")
        self.store = MVCCStore(num_replicas=replicas)
        self.configured = True
        return {"ok": True, "replicas": replicas}

    def _op_begin(self, obj: dict) -> dict:
        _require(obj, "txn")
        ctx = self.store.begin(
            obj["txn"],
            replica=obj.get("replica", 0),
            ctx=obj.get("ctx"),
            timeout_ms=obj.get("timeout_ms"),
        )
        return {"ok": True, "txn": obj["txn"], "ctx": list(ctx)}

    def _op_read(self, obj: dict) -> dict:
        _require(obj, "txn", "key")
        found, value, vec = self.store.read(obj["txn"], obj["key"])
        resp = {"ok": True, "found": found}
        if found:
            resp["value"] = value
            if vec is not None:
                resp["version"] = list(vec)
        return resp

    def _op_write(self, obj: dict) -> dict:
        _require(obj, "txn", "key", "value")
        self.store.write(obj["txn"], obj["key"], obj["value"])
        return {"ok": True}

    def _op_commit(self, obj: dict) -> dict:
        _require(obj, "txn")
        ctx = self.store.commit(obj["txn"])
        return {"ok": True, "ctx": list(ctx)}

    def _op_abort(self, obj: dict) -> dict:
        _require(obj, "txn")
        self.store.abort(obj["txn"])
        return {"ok": True}

    def _op_gc(self, obj: dict) -> dict:
        watermark = self.store.gc_watermark()
        collected = self.store.gc()
        return {
            "ok": True,
            "watermark": list(watermark) if watermark is not None else None,
            "collected": collected,
        }

    def _op_txn_state(self, obj: dict) -> dict:
        _require(obj, "txn")
        return {"ok": True, "state": self.store.txn_state(obj["txn"])}


def run(session: Session, inp, out) -> int:
    for line in inp:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            if not isinstance(obj, dict):
                raise ProtocolError("each line must be a JSON object")
        except json.JSONDecodeError as exc:
            json.dump(
                {"ok": False, "error": "BAD_JSON", "message": str(exc)}, out
            )
            out.write("\n")
            out.flush()
            return EXIT_PROTOCOL_ERROR
        try:
            resp = session.handle(obj)
        except ProtocolError as exc:
            json.dump({"ok": False, "error": "PROTOCOL", "message": str(exc)}, out)
            out.write("\n")
            out.flush()
            return EXIT_PROTOCOL_ERROR
        except MVCCError as exc:
            resp = {"ok": False, "error": exc.code, "message": str(exc)}
        json.dump(resp, out)
        out.write("\n")
        out.flush()
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="mvcc", description=__doc__)
    parser.add_argument("--replicas", type=int, default=3)
    args = parser.parse_args(argv)
    session = Session(num_replicas=args.replicas)
    return run(session, sys.stdin, sys.stdout)


if __name__ == "__main__":
    sys.exit(main())
