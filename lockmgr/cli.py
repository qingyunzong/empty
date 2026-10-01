"""JSON-lines CLI for the lock manager.

Input (one JSON object per line):
  {"op": "begin",  "txn": 1}
  {"op": "lock",   "txn": 1, "resource": "A", "mode": "S"|"X"}
  {"op": "commit", "txn": 1}
  {"op": "abort",  "txn": 1}

Output (one JSON object per line):
  {"status": "BEGUN",     "txn": 1}
  {"status": "GRANTED",   "txn": 1, "resource": "A", "mode": "S"}
  {"status": "DEADLOCK",  "victim": 2, "cycle": [1, 2]}
  {"status": "COMMITTED", "txn": 1}
  {"status": "ABORTED",   "txn": 1}
  {"status": "ERROR",     "message": "..."}

A blocked lock request produces no output until it is woken and granted.
"""

from __future__ import annotations

import json
import sys

from .manager import LockManager


def _dispatch(manager: LockManager, request) -> list:
    if not isinstance(request, dict):
        return [{"status": "ERROR", "message": "request must be a JSON object"}]
    op = request.get("op")
    try:
        if op == "begin":
            manager.begin(request["txn"])
        elif op == "lock":
            manager.lock(request["txn"], request["resource"], request["mode"])
        elif op == "commit":
            manager.commit(request["txn"])
        elif op == "abort":
            manager.abort(request["txn"])
        else:
            return [{"status": "ERROR", "message": f"unknown op {op!r}"}]
    except KeyError as exc:
        return [{"status": "ERROR", "message": f"missing field {exc}"}]
    return manager.drain_events()


def run(stream, out) -> None:
    manager = LockManager()
    for line in stream:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            events = [{"status": "ERROR", "message": f"invalid JSON: {exc}"}]
        else:
            events = _dispatch(manager, request)
        for event in events:
            out.write(json.dumps(event) + "\n")
        out.flush()


def main() -> None:
    run(sys.stdin, sys.stdout)
