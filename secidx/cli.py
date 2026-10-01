"""JSON-lines CLI for secidx.

Reads one JSON command object per line from stdin and writes one JSON
response object per line to stdout.

Commands
--------
  {"cmd": "begin",    "txn": "t1"}
  {"cmd": "commit",   "txn": "t1"}
  {"cmd": "abort",    "txn": "t1"}
  {"cmd": "create_index", "field": "email", "unique": true}
  {"cmd": "insert",   "txn": "t1", "pk": 1, "fields": {"email": "a@x"}}
  {"cmd": "update",   "txn": "t1", "pk": 1, "fields": {"email": "b@x"}}
  {"cmd": "delete",   "txn": "t1", "pk": 1}
  {"cmd": "find",     "txn": "t1", "field": "email", "value": "a@x"}
  {"cmd": "scan",     "txn": "t1"}
  {"cmd": "reset"}

``txn`` is optional on insert/update/delete/find/scan: when omitted the
command runs in its own auto-committed transaction.

Responses
---------
  success: {"ok": true, ...}            (find/scan add "rows": [...])
  failure: {"ok": false, "error": {"code": "...", "message": "..."}}

A UNIQUE_VIOLATION (or TXN_CONFLICT) aborts the offending transaction
wholesale; later commands naming it get NO_SUCH_TXN.
"""

from __future__ import annotations

import json
import sys

from .core import BadRequest, Database, ErrorCode, SecIdxError


def _require(req: dict, *names: str):
    values = []
    for name in names:
        if name not in req:
            raise BadRequest(f"missing field {name!r}")
        values.append(req[name])
    return values[0] if len(values) == 1 else values


class Session:
    """Dispatches commands against one Database, handling auto-commit."""

    def __init__(self, db: Database | None = None):
        self.db = db or Database()
        self._autotxn = 0

    def execute(self, req: dict) -> dict:
        cmd = _require(req, "cmd")
        handler = getattr(self, f"_cmd_{cmd}", None)
        if handler is None:
            raise BadRequest(f"unknown command {cmd!r}")
        return handler(req)

    # -- transaction-scoped commands (support autocommit) ------------------

    def _with_txn(self, req: dict, fn):
        txn_id = req.get("txn")
        if txn_id is not None:
            return fn(txn_id)
        self._autotxn += 1
        auto = f"__auto_{self._autotxn}"
        self.db.begin(auto)
        try:
            result = fn(auto)
        except BaseException:
            if auto in self.db.txns:
                self.db.abort(auto)
            raise
        self.db.commit(auto)
        return result

    # -- command handlers ---------------------------------------------------

    def _cmd_begin(self, req):
        self.db.begin(_require(req, "txn"))
        return {}

    def _cmd_commit(self, req):
        self.db.commit(_require(req, "txn"))
        return {}

    def _cmd_abort(self, req):
        self.db.abort(_require(req, "txn"))
        return {}

    def _cmd_create_index(self, req):
        field = _require(req, "field")
        self.db.create_index(field, bool(req.get("unique", False)))
        return {}

    def _cmd_insert(self, req):
        pk, fields = _require(req, "pk", "fields")
        return self._with_txn(req, lambda t: self.db.insert(t, pk, fields) or {})

    def _cmd_update(self, req):
        pk, fields = _require(req, "pk", "fields")
        return self._with_txn(req, lambda t: self.db.update(t, pk, fields) or {})

    def _cmd_delete(self, req):
        pk = _require(req, "pk")
        return self._with_txn(req, lambda t: self.db.delete(t, pk) or {})

    def _cmd_find(self, req):
        field, value = _require(req, "field", "value")
        rows = self._with_txn(req, lambda t: self.db.find(t, field, value))
        return {"rows": rows}

    def _cmd_scan(self, req):
        rows = self._with_txn(req, lambda t: self.db.scan(t))
        return {"rows": rows}

    def _cmd_reset(self, req):
        self.db = Database()
        return {}


def execute_line(session: Session, line: str) -> dict:
    try:
        req = json.loads(line)
    except json.JSONDecodeError as exc:
        return {"ok": False, "error": {"code": ErrorCode.BAD_REQUEST,
                                       "message": f"invalid JSON: {exc}"}}
    if not isinstance(req, dict):
        return {"ok": False, "error": {"code": ErrorCode.BAD_REQUEST,
                                       "message": "command must be an object"}}
    try:
        result = session.execute(req)
        return {"ok": True, **result}
    except SecIdxError as exc:
        return {"ok": False, "error": {"code": exc.code, "message": exc.message}}
    except Exception as exc:  # defensive: never crash the protocol loop
        return {"ok": False, "error": {"code": ErrorCode.BAD_REQUEST,
                                       "message": f"{type(exc).__name__}: {exc}"}}


def main(stream=None, out=None) -> int:
    stream = stream if stream is not None else sys.stdin
    out = out if out is not None else sys.stdout
    session = Session()
    for line in stream:
        line = line.strip()
        if not line:
            continue
        response = execute_line(session, line)
        out.write(json.dumps(response) + "\n")
        out.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
