#!/usr/bin/env python3
"""Saga-style tree order reservation simulator.

Input JSON describes an order tree: a root with children such as flight,
hotel, car rental; a hotel may contain multiple rooms. Every node carries a
reserve action, a compensate action and an estimated cost.

Semantics:
  1. Nodes are reserved depth-first, left to right (pre-order).
  2. When a node fails, its already completed children are compensated in
     reverse order first, then the failure bubbles up: each parent compensates
     the previously successful siblings in reverse order.
  3. If the total estimated cost exceeds the budget, the run fails before any
     external action is performed.
  4. Reservations are idempotent by node path.
  5. After a crash, recovery skips confirmed actions and replays unconfirmed
     ones.

CLI commands: run, fail-at NODE, crash --at EVENT, recover, state.
States: RUNNING, COMPENSATING, COMPLETED, COMPENSATED, FAILED.

Python 3.11, standard library only.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

RUNNING = "RUNNING"
COMPENSATING = "COMPENSATING"
COMPLETED = "COMPLETED"
COMPENSATED = "COMPENSATED"
FAILED = "FAILED"

TERMINAL_STATES = (COMPLETED, COMPENSATED, FAILED)

DEFAULT_STATE_FILE = ".saga_session.json"


class NodeFailure(Exception):
    """Raised when the reserve action of the configured fail node is hit."""


class CrashSignal(Exception):
    """Raised when the configured crash event is reached."""


@dataclass
class Node:
    name: str
    cost: float = 0.0
    children: list["Node"] = field(default_factory=list)
    path: str = ""

    @classmethod
    def from_dict(cls, data: dict, parent_path: str = "") -> "Node":
        node = cls(name=str(data["name"]), cost=float(data.get("cost", 0.0)))
        node.path = f"{parent_path}/{node.name}" if parent_path else node.name
        node.children = [cls.from_dict(c, node.path) for c in data.get("children", [])]
        return node

    def total_cost(self) -> float:
        return self.cost + sum(child.total_cost() for child in self.children)

    def find(self, target: str) -> "Node | None":
        if target in (self.name, self.path):
            return self
        for child in self.children:
            hit = child.find(target)
            if hit is not None:
                return hit
        return None

    def ancestor_paths(self) -> list[str]:
        parts = self.path.split("/")[:-1]
        return ["/".join(parts[: i + 1]) for i in range(len(parts))]


class Saga:
    """Executes reserve/compensate actions over an order tree with a journal."""

    def __init__(self, order: dict, budget: float = float("inf"),
                 fail_at: str | None = None, crash_at: int | None = None):
        self.order = order
        self.root = Node.from_dict(order)
        self.budget = float(budget)
        self.fail_at = fail_at
        self.crash_at = crash_at  # 1-based journal sequence number to crash at
        self.state = RUNNING
        self.crashed = False
        self.journal: list[dict] = []
        self.reserved: list[str] = []     # confirmed reserve paths, in order
        self.compensated: list[str] = []  # confirmed compensate paths, in order
        self.failed_path: str | None = None
        self._replays: dict[tuple[str, str], int] = {}

    # ------------------------------------------------------------------ util
    def held_reservations(self) -> list[str]:
        return [p for p in self.reserved if p not in self.compensated]

    def _is_fail_node(self, node: Node) -> bool:
        return self.fail_at is not None and self.fail_at in (node.name, node.path)

    # ---------------------------------------------------------------- events
    def _emit(self, action: str, path: str, result: str = "ok") -> None:
        seq = len(self.journal) + 1
        confirmed = not (self.crash_at is not None and seq == self.crash_at)
        event = {"seq": seq, "action": action, "path": path,
                 "result": result, "confirmed": confirmed}
        key = (action, path)
        if key in self._replays:
            event["replays"] = self._replays.pop(key)
        self.journal.append(event)
        if not confirmed:
            # The action was attempted but its confirmation was lost in the
            # crash; its effect is therefore not recorded and recovery will
            # replay it (idempotently, by node path).
            self.crashed = True
            raise CrashSignal

    # ------------------------------------------------------------------- run
    def run(self) -> str:
        if self.state in TERMINAL_STATES:
            return self.state  # idempotent re-run: no duplicate actions
        self.crashed = False
        try:
            if self.root.total_cost() > self.budget:
                # Budget exceeded: fail before any external action.
                self.state = FAILED
                return self.state
            self._reserve_subtree(self.root)
            self.state = COMPLETED
        except NodeFailure:
            self.state = COMPENSATING
            try:
                self._compensate()
            except CrashSignal:
                return self.state  # crashed mid-compensation
            self.state = COMPENSATED
        except CrashSignal:
            pass  # crashed mid-reservation; state stays RUNNING
        return self.state

    def _reserve_subtree(self, node: Node) -> None:
        if node.path not in self.reserved:
            # Idempotency by node path: confirmed reservations are skipped.
            if self._is_fail_node(node):
                self._emit("reserve", node.path, result="failed")
                self.failed_path = node.path
                raise NodeFailure
            self._emit("reserve", node.path)
            self.reserved.append(node.path)
        for child in node.children:
            self._reserve_subtree(child)

    def _compensate(self) -> None:
        # Rolling back every confirmed reservation except the failing node's
        # ancestors, in reverse reservation order, is exactly "compensate the
        # failed node's completed children in reverse, then bubble up and let
        # each parent compensate its previously successful siblings in
        # reverse".  Tests verify this against a recursive reference
        # implementation of the bubbling formulation.
        fail_node = self.root.find(self.failed_path)
        skip = set(fail_node.ancestor_paths())
        for path in reversed(self.reserved):
            if path in skip or path in self.compensated:
                continue
            self._emit("compensate", path)
            self.compensated.append(path)

    # --------------------------------------------------------------- recover
    def recover(self) -> str:
        """Resume after a crash: confirmed actions are skipped (idempotency),
        unconfirmed actions are replayed."""
        for event in self.journal:
            if not event["confirmed"]:
                self._replays[(event["action"], event["path"])] = event["seq"]
        self.crashed = False
        self.crash_at = None
        return self.run()

    # ---------------------------------------------------------- persistence
    def to_dict(self) -> dict:
        return {
            "order": self.order,
            "budget": None if self.budget == float("inf") else self.budget,
            "fail_at": self.fail_at,
            "crash_at": self.crash_at,
            "state": self.state,
            "crashed": self.crashed,
            "journal": self.journal,
            "reserved": self.reserved,
            "compensated": self.compensated,
            "failed_path": self.failed_path,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Saga":
        budget = data["budget"] if data["budget"] is not None else float("inf")
        saga = cls(data["order"], budget=budget,
                   fail_at=data["fail_at"], crash_at=data["crash_at"])
        saga.state = data["state"]
        saga.crashed = data["crashed"]
        saga.journal = data["journal"]
        saga.reserved = data["reserved"]
        saga.compensated = data["compensated"]
        saga.failed_path = data["failed_path"]
        return saga


# --------------------------------------------------------------------- CLI

def state_file_path(args) -> Path:
    if getattr(args, "state_file", None):
        return Path(args.state_file)
    return Path(os.environ.get("SAGA_STATE_FILE", DEFAULT_STATE_FILE))


def load_store(path: Path) -> dict:
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"config": {}, "session": None}


def save_store(path: Path, store: dict) -> None:
    path.write_text(json.dumps(store, indent=2, ensure_ascii=False) + "\n",
                    encoding="utf-8")


def print_events(events: list[dict]) -> None:
    for e in events:
        mark = "confirmed" if e["confirmed"] else "UNCONFIRMED (crash)"
        result = "" if e["result"] == "ok" else f" [{e['result']}]"
        replay = f" (replays event {e['replays']})" if "replays" in e else ""
        print(f"  event {e['seq']:>3}: {e['action']:<10} {e['path']:<24} "
              f"{mark}{result}{replay}")


def print_state(saga: Saga) -> None:
    crashed = " (crashed)" if saga.crashed else ""
    print(f"state: {saga.state}{crashed}")
    print(f"held reservations: {saga.held_reservations()}")


def cmd_run(args) -> int:
    store = load_store(state_file_path(args))
    order_doc = json.loads(Path(args.order).read_text(encoding="utf-8"))
    order = order_doc["order"]
    budget = args.budget if args.budget is not None else order_doc.get("budget")
    if budget is None:
        budget = float("inf")

    config = store["config"]
    fail_at = args.fail_at or config.get("fail_at")
    crash_at = args.crash_at if args.crash_at is not None else config.get("crash_at")

    session = store["session"]
    if session and not args.reset and session["order"] == order:
        saga = Saga.from_dict(session)
        if args.fail_at:
            saga.fail_at = fail_at
        if args.crash_at is not None:
            saga.crash_at = crash_at
    else:
        saga = Saga(order, budget=budget, fail_at=fail_at, crash_at=crash_at)

    if saga.fail_at and saga.root.find(saga.fail_at) is None:
        print(f"error: fail-at node not found: {saga.fail_at}", file=sys.stderr)
        return 2

    before = len(saga.journal)
    saga.run()
    new_events = saga.journal[before:]
    if new_events:
        print_events(new_events)
    else:
        print("no new events (idempotent run)")
    print_state(saga)

    store["session"] = saga.to_dict()
    save_store(state_file_path(args), store)
    return 0


def cmd_fail_at(args) -> int:
    store = load_store(state_file_path(args))
    store["config"]["fail_at"] = args.node
    if store["session"] and store["session"]["state"] not in TERMINAL_STATES:
        store["session"]["fail_at"] = args.node
    save_store(state_file_path(args), store)
    print(f"fail-at armed: {args.node}")
    return 0


def cmd_crash(args) -> int:
    store = load_store(state_file_path(args))
    store["config"]["crash_at"] = args.at
    if store["session"] and store["session"]["state"] not in TERMINAL_STATES:
        store["session"]["crash_at"] = args.at
    save_store(state_file_path(args), store)
    print(f"crash armed at event: {args.at}")
    return 0


def cmd_recover(args) -> int:
    store = load_store(state_file_path(args))
    if not store["session"]:
        print("error: no session to recover", file=sys.stderr)
        return 2
    saga = Saga.from_dict(store["session"])
    before = len(saga.journal)
    saga.recover()
    new_events = saga.journal[before:]
    if new_events:
        print_events(new_events)
    else:
        print("no events replayed")
    print_state(saga)
    store["session"] = saga.to_dict()
    save_store(state_file_path(args), store)
    return 0


def cmd_state(args) -> int:
    store = load_store(state_file_path(args))
    if not store["session"]:
        print("no session")
        return 0
    saga = Saga.from_dict(store["session"])
    print_state(saga)
    print(f"journal ({len(saga.journal)} events):")
    print_events(saga.journal)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="saga", description=__doc__)
    parser.add_argument("--state-file", help="session state file "
                        "(default: $SAGA_STATE_FILE or .saga_session.json)")
    sub = parser.add_subparsers(dest="command", required=True)

    p_run = sub.add_parser("run", help="reserve the order tree")
    p_run.add_argument("order", help="order JSON file")
    p_run.add_argument("--reset", action="store_true",
                       help="discard the current session and start over")
    p_run.add_argument("--fail-at", metavar="NODE",
                       help="make the reserve action of NODE fail")
    p_run.add_argument("--crash-at", metavar="EVENT", type=int,
                       help="crash when journal event EVENT is reached")
    p_run.add_argument("--budget", type=float, help="override order budget")
    p_run.set_defaults(func=cmd_run)

    p_fail = sub.add_parser("fail-at", help="arm a node failure")
    p_fail.add_argument("node", metavar="NODE")
    p_fail.set_defaults(func=cmd_fail_at)

    p_crash = sub.add_parser("crash", help="arm a crash at a journal event")
    p_crash.add_argument("--at", metavar="EVENT", type=int, required=True)
    p_crash.set_defaults(func=cmd_crash)

    p_rec = sub.add_parser("recover", help="recover from a crash")
    p_rec.set_defaults(func=cmd_recover)

    p_state = sub.add_parser("state", help="show current state and journal")
    p_state.set_defaults(func=cmd_state)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
