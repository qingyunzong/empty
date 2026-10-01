"""JSON-lines CLI for the lock manager.

Input (one JSON object per line on stdin):
  {"op": "lock",   "txn": 1, "resource": "A", "mode": "S"}
  {"op": "commit", "txn": 1}
  {"op": "abort",  "txn": 1}

Output (one JSON object per line on stdout):
  {"event": "granted",  "txn": 1, "resource": "A", "mode": "S"}
  {"event": "waiting",  "txn": 1, "resource": "A", "mode": "X"}
  {"event": "deadlock", "txn": 2, "resource": "B", "mode": "X"}
  {"event": "error",    "txn": 3, "reason": "..."}
  {"event": "committed", "txn": 1} / {"event": "aborted", "txn": 1}

A blocked request only produces its "waiting" event immediately; the
"granted" event is emitted later, when the request is actually woken.
"""

from __future__ import annotations

import json
import sys
from typing import IO, Any, Dict, List

from .manager import LockManager, LockMode, RequestStatus


class _CliLockManager(LockManager):
    """LockManager that records grant/wake events for the CLI."""

    def __init__(self) -> None:
        super().__init__()
        self.events: List[Dict[str, Any]] = []

    def _grant_event(self, txn_id: int, resource: str, mode: LockMode) -> None:
        self.events.append(
            {
                "event": "granted",
                "txn": txn_id,
                "resource": resource,
                "mode": mode.value,
            }
        )

    def _on_victim(self, txn_id: int) -> None:
        self.events.append({"event": "deadlock", "txn": txn_id})

    def _acquire(self, txn_id, resource, mode, state):
        status = super()._acquire(txn_id, resource, mode, state)
        if status is RequestStatus.GRANTED:
            self._grant_event(txn_id, resource, mode)
        return status

    def _upgrade(self, txn_id, resource, state):
        status = super()._upgrade(txn_id, resource, state)
        if status is RequestStatus.GRANTED:
            self._grant_event(txn_id, resource, LockMode.X)
        return status

    def _drain_queues(self) -> None:
        changed = True
        while changed:
            changed = False
            for resource in sorted(self._resources):
                state = self._resources[resource]
                while state.queue:
                    req = state.queue[0]
                    if req.upgrade:
                        grantable = not any(
                            t != req.txn_id for t in state.holders
                        )
                    elif req.mode is LockMode.S:
                        grantable = all(
                            m is LockMode.S for m in state.holders.values()
                        )
                    else:
                        grantable = not state.holders
                    if not grantable:
                        break
                    state.queue.pop(0)
                    state.holders[req.txn_id] = req.mode
                    self._locks_held.setdefault(req.txn_id, set()).add(resource)
                    self._grant_event(req.txn_id, resource, req.mode)
                    changed = True


def run(stdin: IO[str], stdout: IO[str]) -> None:
    manager = _CliLockManager()

    def emit(event: Dict[str, Any]) -> None:
        stdout.write(json.dumps(event) + "\n")

    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            op = json.loads(line)
        except json.JSONDecodeError as exc:
            emit({"event": "error", "reason": f"invalid json: {exc}"})
            continue

        kind = op.get("op")
        txn = op.get("txn")
        manager.events = []

        if kind == "lock":
            try:
                mode = LockMode.parse(op.get("mode", ""))
            except ValueError as exc:
                emit({"event": "error", "txn": txn, "reason": str(exc)})
                continue
            status = manager.lock(txn, op["resource"], mode)
            if status is RequestStatus.WAITING:
                if not manager.is_aborted(txn):
                    emit(
                        {
                            "event": "waiting",
                            "txn": txn,
                            "resource": op["resource"],
                            "mode": mode.value,
                        }
                    )
            elif status is RequestStatus.ERROR:
                emit({"event": "error", "txn": txn, "reason": "txn not active"})
            for event in manager.events:
                emit(event)
        elif kind == "commit":
            status = manager.commit(txn)
            if status is RequestStatus.ERROR:
                emit({"event": "error", "txn": txn, "reason": "txn not active"})
            else:
                emit({"event": "committed", "txn": txn})
            for event in manager.events:
                emit(event)
        elif kind == "abort":
            status = manager.abort(txn)
            if status is RequestStatus.ERROR:
                emit({"event": "error", "txn": txn, "reason": "txn not active"})
            else:
                emit({"event": "aborted", "txn": txn})
            for event in manager.events:
                emit(event)
        else:
            emit({"event": "error", "txn": txn, "reason": f"unknown op: {kind!r}"})

    stdout.flush()


def main() -> None:
    run(sys.stdin, sys.stdout)


if __name__ == "__main__":
    main()
