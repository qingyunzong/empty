"""JSON command-line interface.

Usage:
    python3.11 -m budget_gate.cli --state STATE.json OP [OP_JSON]

OP_JSON is a JSON object; when omitted it is read from stdin. The result
is printed as a single JSON object:
    {"ok": true,  "result": {...}}   -- applied (business rejections
                                        appear as result.status="rejected")
    {"ok": false, "error": {...}}    -- protocol/state error

Ops:
  add_subject  {"op":"add_subject","subject":"s1","parents":["p1"]}
  set_quota    {"op":"set_quota","subject":"p1","rule_id":"r1",
                "windows":[{"type":"business_day","tz":"Asia/Shanghai","capacity":10},
                           {"type":"rolling","seconds":3600,"capacity":5},
                           {"type":"calendar","unit":"week","tz":"UTC","capacity":20}]}
  reserve      {"op":"reserve","id":"q1","subject":"s1","amount":3,
                "execute_at":1696118400,"confirm_by":1696119000,"now":1696118400}
  confirm      {"op":"confirm","id":"q1","version":1,"now":...}
  cancel       {"op":"cancel","id":"q1","version":1,"now":...}
  expire       {"op":"expire","id":"q1","version":1,"now":...}
  tick         {"op":"tick","now":...}
  occupancy    {"op":"occupancy","subject":"s1","execute_at":...}
  status       {"op":"status"}

Every op is one linearized critical section; the state file is rewritten
atomically before the response is printed. Setting the environment
variable BUDGET_GATE_CRASH_AFTER_WRITE=1 makes the process exit with
code 75 right after the state write and before printing the response,
to exercise crash-and-replay idempotency.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from . import store
from .gate import BudgetGate, GateError
from .model import WindowSpec


def apply_op(gate: BudgetGate, op: dict) -> dict:
    kind = op.get("op")
    if kind == "add_subject":
        return gate.add_subject(op["subject"], op.get("parents") or [])
    if kind == "set_quota":
        windows = [WindowSpec.from_dict(w) for w in op["windows"]]
        return gate.set_quota(op["subject"], op["rule_id"], windows)
    if kind == "reserve":
        return gate.reserve(
            id=op["id"], subject=op["subject"], amount=op["amount"],
            execute_at=op["execute_at"], confirm_by=op["confirm_by"], now=op["now"],
        )
    if kind == "confirm":
        return gate.confirm(id=op["id"], version=op["version"], now=op["now"])
    if kind == "cancel":
        return gate.cancel(id=op["id"], version=op["version"], now=op["now"])
    if kind == "expire":
        return gate.expire(id=op["id"], version=op["version"], now=op["now"])
    if kind == "tick":
        return gate.tick(now=op["now"])
    if kind == "occupancy":
        return {"windows": gate.occupancy_report(op["subject"], op["execute_at"])}
    if kind == "status":
        return gate.status()
    raise GateError("bad_input", f"unknown op {kind!r}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="budget_gate.cli")
    parser.add_argument("--state", required=True, help="path to the JSON state file")
    parser.add_argument("op_json", nargs="?", default=None,
                        help="operation JSON (default: read from stdin)")
    args = parser.parse_args(argv)

    raw = args.op_json if args.op_json is not None else sys.stdin.read()
    try:
        op = json.loads(raw)
        if not isinstance(op, dict):
            raise ValueError("op must be a JSON object")
        gate = BudgetGate(store.load_state(args.state))
        result = apply_op(gate, op)
        store.save_state(gate.state, args.state)
        if os.environ.get("BUDGET_GATE_CRASH_AFTER_WRITE") == "1":
            os._exit(75)  # simulated crash: state committed, response lost
        print(json.dumps({"ok": True, "result": result}, sort_keys=True))
        return 0
    except GateError as exc:
        print(json.dumps({"ok": False, "error": exc.to_dict()}, sort_keys=True))
        return 2
    except (KeyError, ValueError, TypeError) as exc:
        err = {"code": "bad_input", "message": str(exc)}
        print(json.dumps({"ok": False, "error": err}, sort_keys=True))
        return 2


if __name__ == "__main__":
    sys.exit(main())
