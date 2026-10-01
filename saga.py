#!/usr/bin/env python3
"""Saga orchestrator for tree-structured orders.

The input JSON describes a tree of order nodes (flight / hotel / car ...).
Every node owns an implicit `reserve` and `compensate` action plus an
estimated cost.  The engine reserves nodes depth-first, left to right, and
rolls back on failure with a deterministic recursive compensation plan.

State machine: RUNNING -> COMPLETED
             RUNNING -> COMPENSATING -> COMPENSATED
             (before any external action) -> FAILED   (budget exceeded)

Durability: every external action is journaled as an event
(pending -> confirmed) inside the state directory.  After a simulated
crash, `recover` re-runs the deterministic plan: confirmed events are
skipped, pending events are replayed.  Reservations are idempotent by
node path, so repeating a run never duplicates a reservation.

Exit codes: 0 = COMPLETED/COMPENSATED, 1 = crashed (simulated),
            2 = FAILED (budget) or usage/state error.
"""
import argparse
import json
import os
import sys

STATES = ("RUNNING", "COMPENSATING", "COMPLETED", "COMPENSATED", "FAILED")


class Crash(Exception):
    """Simulated process crash raised right after a pending event is written."""

    def __init__(self, seq):
        super().__init__("crashed at event %d" % seq)
        self.seq = seq


class NodeFailure(Exception):
    """Injected reserve failure at a specific node."""

    def __init__(self, node):
        super().__init__("reserve failed at %s" % node.path)
        self.node = node


class Node:
    __slots__ = ("name", "estimate", "children", "parent", "path")

    def __init__(self, name, estimate, parent):
        self.name = name
        self.estimate = estimate
        self.parent = parent
        self.children = []
        if parent is None:
            self.path = "/"
        elif parent.path == "/":
            self.path = "/" + name
        else:
            self.path = parent.path + "/" + name


def parse_tree(data, parent=None):
    node = Node(data["name"], data.get("estimate", 0), parent)
    node.children = [parse_tree(child, node) for child in data.get("children", [])]
    return node


def preorder(node):
    yield node
    for child in node.children:
        yield from preorder(child)


def total_estimate(root):
    return sum(node.estimate for node in preorder(root))


def find_node(root, target):
    for node in preorder(root):
        if node.path == target or node.name == target:
            return node
    return None


def compensation_plan(fail_node, reserved):
    """Exact rollback sequence for a failure at `fail_node`.

    1. Compensate the failed nodes already completed children (whole
       subtrees, reverse order).
    2. Bubble up: each ancestor compensates the previously successful
       siblings of the child on the failure path (reverse order).
    """
    plan = []

    def comp_subtree(node):
        for child in reversed(node.children):
            if child.path in reserved:
                comp_subtree(child)
        if node.path in reserved:
            plan.append(node.path)

    for child in reversed(fail_node.children):
        if child.path in reserved:
            comp_subtree(child)
    child = fail_node
    parent = fail_node.parent
    while parent is not None:
        index = parent.children.index(child)
        for sibling in reversed(parent.children[:index]):
            if sibling.path in reserved:
                comp_subtree(sibling)
        child = parent
        parent = parent.parent
    return plan


def load_json(path, default=None):
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    return default


def save_json(path, data):
    tmp_path = path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    os.replace(tmp_path, path)


def apply_external(world, action, path):
    """External world side effect; idempotent by node path."""
    if action == "reserve":
        if path not in world["reservations"]:
            world["reservations"].append(path)
    else:
        if path in world["reservations"]:
            world["reservations"].remove(path)
        if path not in world["compensations"]:
            world["compensations"].append(path)


class Engine:
    def __init__(self, state_dir):
        self.state_dir = state_dir
        self.journal_path = os.path.join(state_dir, "journal.json")
        self.world_path = os.path.join(state_dir, "world.json")

    def execute(self, input_file, budget, fail_at=None, crash_at=None):
        journal = load_json(self.journal_path)
        if journal is None:
            journal = {
                "state": "RUNNING",
                "input_file": input_file,
                "budget": budget,
                "fail_at": fail_at,
                "events": [],
                "next_seq": 1,
            }
        else:
            input_file = journal["input_file"]
            budget = journal["budget"]
            fail_at = journal["fail_at"]
        world = load_json(self.world_path, {"reservations": [], "compensations": []})

        with open(input_file, "r", encoding="utf-8") as handle:
            root = parse_tree(json.load(handle))

        if total_estimate(root) > budget:
            journal["state"] = "FAILED"
            self._persist(journal, world)
            return journal, world

        journal["state"] = "RUNNING"
        fail_node = find_node(root, fail_at) if fail_at else None
        if fail_at and fail_node is None:
            raise SystemExit("unknown node for fail-at: %s" % fail_at)

        try:
            for node in preorder(root):
                if fail_node is not None and node is fail_node:
                    raise NodeFailure(node)
                self._perform(journal, world, "reserve", node.path, crash_at)
        except NodeFailure as failure:
            journal["state"] = "COMPENSATING"
            self._persist(journal, world)
            reserved = set()
            for node in preorder(root):
                if node is failure.node:
                    break
                reserved.add(node.path)
            try:
                for path in compensation_plan(failure.node, reserved):
                    self._perform(journal, world, "compensate", path, crash_at)
            except Crash:
                self._persist(journal, world)
                raise
            journal["state"] = "COMPENSATED"
        except Crash:
            self._persist(journal, world)
            raise

        if journal["state"] == "RUNNING":
            journal["state"] = "COMPLETED"
        self._persist(journal, world)
        return journal, world

    def _perform(self, journal, world, action, path, crash_at):
        for event in journal["events"]:
            if event["action"] == action and event["path"] == path:
                if event["status"] == "pending":
                    apply_external(world, action, path)  # replay unconfirmed
                    event["status"] = "confirmed"
                return event  # confirmed events are skipped
        event = {
            "seq": journal["next_seq"],
            "action": action,
            "path": path,
            "status": "pending",
        }
        journal["next_seq"] += 1
        journal["events"].append(event)
        if crash_at is not None and event["seq"] == crash_at:
            raise Crash(event["seq"])
        apply_external(world, action, path)
        event["status"] = "confirmed"
        return event

    def _persist(self, journal, world):
        os.makedirs(self.state_dir, exist_ok=True)
        save_json(self.journal_path, journal)
        save_json(self.world_path, world)


def print_state(state_dir):
    journal = load_json(os.path.join(state_dir, "journal.json"))
    if journal is None:
        print("no saga state found in %s" % state_dir)
        return 2
    world = load_json(os.path.join(state_dir, "world.json"),
                      {"reservations": [], "compensations": []})
    print("state: %s" % journal["state"])
    print("events:")
    for event in journal["events"]:
        print("  #%d %-10s %-20s %s" % (event["seq"], event["action"],
                                         event["path"], event["status"]))
    print("reservations: %s" % (", ".join(world["reservations"]) or "(none)"))
    print("compensations: %s" % (", ".join(world["compensations"]) or "(none)"))
    return 0


def run_saga(args, fail_at=None, crash_at=None):
    engine = Engine(args.state_dir)
    try:
        journal, world = engine.execute(args.input, args.budget,
                                        fail_at=fail_at, crash_at=crash_at)
    except Crash as crash:
        print("CRASHED at event #%d (state persisted, run `recover`)" % crash.seq)
        return 1
    state = journal["state"]
    reserves = [e for e in journal["events"] if e["action"] == "reserve"]
    compensates = [e for e in journal["events"] if e["action"] == "compensate"]
    print("state: %s (reserves=%d, compensations=%d)" % (state, len(reserves),
                                                         len(compensates)))
    if state == "FAILED":
        print("total estimate exceeds budget; failed before any external action")
        return 2
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="saga", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    def add_common(subparser, need_input=True):
        if need_input:
            subparser.add_argument("--input", default="order.json",
                                   help="order tree JSON (default: order.json)")
            subparser.add_argument("--budget", type=float, required=True,
                                   help="budget for the total estimate")
        subparser.add_argument("--state-dir", default=".saga",
                               help="state directory (default: .saga)")

    sub_run = sub.add_parser("run", help="run the saga to completion")
    add_common(sub_run)
    sub_run.add_argument("--fail-at", default=None, help="inject failure at node")

    sub_fail = sub.add_parser("fail-at", help="run with a failure injected at NODE")
    sub_fail.add_argument("node", help="node path or name that fails to reserve")
    add_common(sub_fail)

    sub_crash = sub.add_parser("crash", help="run but crash at event --at N")
    sub_crash.add_argument("--at", type=int, required=True,
                           help="crash when event N is pending")
    sub_crash.add_argument("--fail-at", default=None, help="inject failure at node")
    add_common(sub_crash)

    sub_recover = sub.add_parser("recover", help="recover from a crash")
    add_common(sub_recover, need_input=False)

    sub_state = sub.add_parser("state", help="show current saga state")
    add_common(sub_state, need_input=False)

    args = parser.parse_args(argv)

    if args.command == "state":
        return print_state(args.state_dir)
    if args.command == "recover":
        journal = load_json(os.path.join(args.state_dir, "journal.json"))
        if journal is None:
            print("nothing to recover: no journal in %s" % args.state_dir)
            return 2
        engine = Engine(args.state_dir)
        journal, _ = engine.execute(journal["input_file"], journal["budget"])
        print("recovered; state: %s" % journal["state"])
        return 0 if journal["state"] != "FAILED" else 2
    if args.command == "run":
        return run_saga(args, fail_at=args.fail_at)
    if args.command == "fail-at":
        return run_saga(args, fail_at=args.node)
    if args.command == "crash":
        if args.at < 1:
            print("--at must be >= 1")
            return 2
        return run_saga(args, fail_at=args.fail_at, crash_at=args.at)
    return 2


if __name__ == "__main__":
    sys.exit(main())
