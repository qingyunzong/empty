"""JSON-lines CLI.

Usage:
    python3.11 -m budgetgate.cli STATE_FILE < commands.jsonl

Each input line is one JSON command; each produces one JSON result line on
stdout.  State is persisted to STATE_FILE after every command, so a crash
between the durable write and the response is recoverable by replaying the
command (operations are idempotent).

Commands:
    {"op": "configure", "timezones": {...}, "nodes": {...}}
    {"op": "reserve", "request_id": ..., "subject": ..., "amount": ...,
     "execute_at": ..., "confirm_deadline": ..., "now": ...}
    {"op": "confirm", "request_id": ..., "version": ..., "now": ...}
    {"op": "cancel",  "request_id": ..., "version": ..., "now": ...}
    {"op": "expire",  "now": ...}          # run due versioned timers
    {"op": "set_capacity", "node": ..., "window": ..., "capacity": ..., "now": ...}
    {"op": "status"}
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from .errors import GateError
from .gate import BudgetGate


def _load(path: str) -> BudgetGate | None:
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as fh:
            snapshot = json.load(fh)
        return BudgetGate.restore(snapshot)
    return None


def _save(path: str, gate: BudgetGate) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(gate.snapshot(), fh)
    os.replace(tmp, path)


def run_command(gate: BudgetGate | None, cmd: dict) -> tuple[BudgetGate | None, dict]:
    op = cmd.get("op")
    if op == "configure":
        if gate is not None:
            raise GateError("state file is already configured")
        config = {"timezones": cmd.get("timezones", {}), "nodes": cmd.get("nodes", {})}
        return BudgetGate(config), {"status": "ok", "op": "configure"}
    if gate is None:
        raise GateError("state file is not configured yet; send 'configure' first")
    if op == "reserve":
        return gate, gate.reserve(
            request_id=cmd["request_id"],
            subject=cmd["subject"],
            amount=cmd["amount"],
            execute_at=cmd["execute_at"],
            confirm_deadline=cmd["confirm_deadline"],
            now=cmd.get("now"),
        )
    if op == "confirm":
        return gate, gate.confirm(cmd["request_id"], version=cmd.get("version"), now=cmd.get("now"))
    if op == "cancel":
        return gate, gate.cancel(cmd["request_id"], version=cmd.get("version"), now=cmd.get("now"))
    if op == "expire":
        return gate, {"status": "ok", "expired": gate.run_due_timers(now=cmd.get("now"))}
    if op == "set_capacity":
        return gate, gate.set_capacity(
            cmd["node"], cmd["window"], cmd["capacity"], now=cmd.get("now")
        )
    if op == "status":
        return gate, {"status": "ok", "state": gate.status()}
    raise GateError(f"unknown op: {op!r}")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="budgetgate.cli")
    parser.add_argument("state_file")
    parser.add_argument("--command", help="single JSON command instead of stdin")
    args = parser.parse_args(argv)

    lines = [args.command] if args.command else [
        line for line in sys.stdin if line.strip()
    ]
    gate = _load(args.state_file)
    exit_code = 0
    for line in lines:
        try:
            cmd = json.loads(line)
            gate, result = run_command(gate, cmd)
            _save(args.state_file, gate)
        except (GateError, KeyError, ValueError) as exc:
            result = {"status": "error", "error": f"{type(exc).__name__}: {exc}"}
            exit_code = 1
        print(json.dumps(result, sort_keys=True), flush=True)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
