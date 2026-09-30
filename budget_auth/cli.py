"""JSON command-line interface.

Reads a JSON document from stdin:
  {"log": <path or null>, "commands": [{"op": ..., ...params}]}
Executes the commands in order against an Authorizer (recovering from the
log first when given) and writes {"results": [...]} to stdout.
"""

from __future__ import annotations

import json
import os
import sys

from .engine import Authorizer

_OPS = {
    "add_budget": lambda a, p: a.add_budget(**p),
    "add_rule": lambda a, p: a.add_rule(**p),
    "set_quota": lambda a, p: a.set_quota(**p),
    "reserve": lambda a, p: a.reserve(**p),
    "confirm": lambda a, p: a.confirm(**p),
    "release": lambda a, p: a.release(**p),
    "advance_time": lambda a, p: a.advance_time(**p),
    "state": lambda a, p: a.state(),
}


def run_document(doc: dict) -> dict:
    log = doc.get("log")
    if log and os.path.exists(log):
        auth = Authorizer.recover(log)
    else:
        auth = Authorizer(log_path=log)
    results = []
    try:
        for cmd in doc.get("commands", []):
            cmd = dict(cmd)
            op = cmd.pop("op", None)
            handler = _OPS.get(op)
            if handler is None:
                results.append({"ok": False,
                                "error": {"code": "unknown_op",
                                          "message": f"unknown op {op!r}"}})
                continue
            try:
                results.append(handler(auth, cmd))
            except TypeError as exc:
                results.append({"ok": False,
                                "error": {"code": "bad_params",
                                          "message": str(exc)}})
    finally:
        auth.close()
    return {"results": results}


def main(argv: list[str] | None = None) -> int:
    doc = json.load(sys.stdin)
    json.dump(run_document(doc), sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
