"""Unittest suite for saga.py.

The exact rollback sequence is checked against a small independent
*recursive* reference algorithm (reference_rollback) that directly follows
the spec: compensate the failed node's completed children in reverse, then
bubble up letting each parent compensate its previously successful siblings
in reverse.  The implementation under test uses a different construction
(reverse reservation order minus the failing node's ancestors), so agreement
between the two is meaningful.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import saga

REPO = Path(__file__).resolve().parent


def build_order():
    """root -> flight, hotel(room1, room2), car ; total cost 800."""
    return {
        "name": "root", "cost": 0,
        "children": [
            {"name": "flight", "cost": 300},
            {"name": "hotel", "cost": 0, "children": [
                {"name": "room1", "cost": 200},
                {"name": "room2", "cost": 200},
            ]},
            {"name": "car", "cost": 100},
        ],
    }


ALL_PATHS = ["root", "root/flight", "root/hotel",
             "root/hotel/room1", "root/hotel/room2", "root/car"]


def reference_rollback(order, fail_name):
    """Recursive reference algorithm: exact rollback sequence when the
    reserve action of the node named ``fail_name`` fails."""
    root = saga.Node.from_dict(order)
    reserved = []   # nodes confirmed before the failure, in reserve order
    failure = []

    def dfs(node, ancestors):
        if node.name == fail_name:
            failure.append((node, list(ancestors)))
            raise RuntimeError("injected failure")
        reserved.append(node)
        for child in node.children:
            dfs(child, ancestors + [node])

    try:
        dfs(root, [])
    except RuntimeError:
        pass
    if not failure:
        raise AssertionError(f"fail node not found: {fail_name}")
    fail_node, ancestors = failure[0]
    held = {n.path for n in reserved}

    sequence = []

    def rollback_subtree(node):
        # Reverse of the pre-order reservation inside a subtree.
        for child in reversed(node.children):
            rollback_subtree(child)
        if node.path in held:
            sequence.append(node.path)

    # 1. Compensate the failed node's completed children (reverse order).
    rollback_subtree(fail_node)
    # 2. Bubble up: each parent compensates previously successful siblings.
    child = fail_node
    for ancestor in reversed(ancestors):
        index = ancestor.children.index(child)
        for sibling in reversed(ancestor.children[:index]):
            rollback_subtree(sibling)
        child = ancestor
    return sequence


def compensate_events(s):
    return [e["path"] for e in s.journal if e["action"] == "compensate"]


def reserve_events(s):
    return [e["path"] for e in s.journal
            if e["action"] == "reserve" and e["result"] == "ok"]


class SagaSemanticsTest(unittest.TestCase):
    def test_all_succeed_preorder_completion(self):
        s = saga.Saga(build_order(), budget=1000)
        self.assertEqual(s.run(), saga.COMPLETED)
        self.assertEqual(reserve_events(s), ALL_PATHS)
        self.assertEqual(compensate_events(s), [])
        self.assertEqual(s.held_reservations(), ALL_PATHS)

    def test_second_room_failure_rollback_order(self):
        s = saga.Saga(build_order(), budget=1000, fail_at="room2")
        self.assertEqual(s.run(), saga.COMPENSATED)
        # Acceptance: compensation order is room1, then flight.
        self.assertEqual(compensate_events(s),
                         ["root/hotel/room1", "root/flight"])
        self.assertEqual(compensate_events(s),
                         reference_rollback(build_order(), "room2"))
        self.assertEqual(s.held_reservations(),
                         ["root", "root/hotel"])  # ancestors are not rolled back

    def test_budget_exceeded_fails_before_any_action(self):
        s = saga.Saga(build_order(), budget=799)  # total cost is 800
        self.assertEqual(s.run(), saga.FAILED)
        self.assertEqual(s.journal, [])           # no external action at all
        self.assertEqual(s.reserved, [])

    def test_budget_exactly_sufficient(self):
        s = saga.Saga(build_order(), budget=800)
        self.assertEqual(s.run(), saga.COMPLETED)

    def test_crash_at_event_then_recover(self):
        # Events: 1 root, 2 flight, 3 hotel, 4 room1, 5 room2, 6 car.
        s = saga.Saga(build_order(), budget=1000, crash_at=4)
        s.run()
        self.assertEqual(s.state, saga.RUNNING)
        self.assertTrue(s.crashed)
        self.assertEqual(s.reserved, ["root", "root/flight", "root/hotel"])
        unconfirmed = [e for e in s.journal if not e["confirmed"]]
        self.assertEqual(len(unconfirmed), 1)
        self.assertEqual(unconfirmed[0]["path"], "root/hotel/room1")

        self.assertEqual(s.recover(), saga.COMPLETED)
        self.assertFalse(s.crashed)
        # No duplicate reservations after recovery.
        self.assertEqual(sorted(s.reserved), sorted(ALL_PATHS))
        self.assertEqual(len(s.reserved), len(set(s.reserved)))
        # The unconfirmed action was replayed exactly once.
        replays = [e for e in s.journal if "replays" in e]
        self.assertEqual(len(replays), 1)
        self.assertEqual(replays[0]["path"], "root/hotel/room1")
        self.assertEqual(replays[0]["replays"], 4)
        # Confirmed actions were skipped, not re-emitted: among confirmed
        # reserve events every path appears exactly once.
        confirmed_reserves = [e["path"] for e in s.journal
                              if e["action"] == "reserve" and e["confirmed"]]
        self.assertEqual(confirmed_reserves, ALL_PATHS)

    def test_crash_during_compensation_then_recover(self):
        # Events: 1-4 reserves, 5 reserve room2 [failed], 6 compensate room1,
        # 7 compensate flight.  Crash at event 6.
        s = saga.Saga(build_order(), budget=1000, fail_at="room2", crash_at=6)
        s.run()
        self.assertEqual(s.state, saga.COMPENSATING)
        self.assertTrue(s.crashed)
        self.assertEqual(s.compensated, [])

        self.assertEqual(s.recover(), saga.COMPENSATED)
        confirmed_comp = [e["path"] for e in s.journal
                          if e["action"] == "compensate" and e["confirmed"]]
        self.assertEqual(confirmed_comp, ["root/hotel/room1", "root/flight"])
        self.assertEqual(len(s.compensated), len(set(s.compensated)))

    def test_rerun_is_idempotent_no_duplicate_reservations(self):
        s = saga.Saga(build_order(), budget=1000)
        s.run()
        journal_size = len(s.journal)
        self.assertEqual(s.run(), saga.COMPLETED)  # repeat run
        self.assertEqual(len(s.journal), journal_size)
        self.assertEqual(len(reserve_events(s)), len(set(reserve_events(s))))

    def test_reference_algorithm_matches_on_small_trees(self):
        trees = [
            build_order(),
            {"name": "root", "children": [
                {"name": "a", "children": [
                    {"name": "a1"}, {"name": "a2"}, {"name": "a3"}]},
                {"name": "b", "children": [{"name": "b1"}]},
                {"name": "c"},
            ]},
            {"name": "root", "children": [
                {"name": "x", "children": [
                    {"name": "x1", "children": [{"name": "x1a"}, {"name": "x1b"}]},
                    {"name": "x2"},
                ]},
                {"name": "y"},
            ]},
        ]
        for order in trees:
            names = []

            def collect(node):
                names.append(node.name)
                for c in node.children:
                    collect(c)

            collect(saga.Node.from_dict(order))
            for name in names:
                if name == "root":
                    continue
                with self.subTest(order=order["name"], fail=name):
                    s = saga.Saga(order, budget=float("inf"), fail_at=name)
                    self.assertEqual(s.run(), saga.COMPENSATED)
                    self.assertEqual(compensate_events(s),
                                     reference_rollback(order, name))

    def test_fail_at_root_compensates_nothing(self):
        s = saga.Saga(build_order(), budget=1000, fail_at="root")
        self.assertEqual(s.run(), saga.COMPENSATED)
        self.assertEqual(compensate_events(s), [])
        self.assertEqual(reference_rollback(build_order(), "root"), [])


class CliIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        workdir = Path(self.tmp.name)
        self.order_file = workdir / "order.json"
        self.order_file.write_text(json.dumps(
            {"budget": 1000, "order": build_order()}), encoding="utf-8")
        self.env = dict(os.environ,
                        SAGA_STATE_FILE=str(workdir / "session.json"))

    def cli(self, *argv):
        return subprocess.run([sys.executable, str(REPO / "saga.py"), *argv],
                              capture_output=True, text=True, env=self.env)

    def test_full_command_flow(self):
        r = self.cli("run", str(self.order_file))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("state: COMPLETED", r.stdout)

        # Repeated run: idempotent, no duplicate reservations.
        r = self.cli("run", str(self.order_file))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("no new events", r.stdout)

        # fail-at NODE command, then a fresh run compensates room1, flight.
        r = self.cli("fail-at", "room2")
        self.assertEqual(r.returncode, 0, r.stderr)
        r = self.cli("run", str(self.order_file), "--reset")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("state: COMPENSATED", r.stdout)
        comp_lines = [ln for ln in r.stdout.splitlines()
                      if "compensate" in ln]
        self.assertEqual([ln.split()[3] for ln in comp_lines],
                         ["root/hotel/room1", "root/flight"])

        # crash --at EVENT command, then recover.
        r = self.cli("crash", "--at", "4")
        self.assertEqual(r.returncode, 0, r.stderr)
        r = self.cli("run", str(self.order_file), "--reset")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("RUNNING (crashed)", r.stdout)

        r = self.cli("recover")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("replays event 4", r.stdout)

        r = self.cli("state")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("state:", r.stdout)
        self.assertIn("journal", r.stdout)

    def test_budget_exceeded_via_cli(self):
        doc = {"budget": 10, "order": build_order()}
        self.order_file.write_text(json.dumps(doc), encoding="utf-8")
        r = self.cli("run", str(self.order_file))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("state: FAILED", r.stdout)
        self.assertIn("no new events", r.stdout)


if __name__ == "__main__":
    unittest.main()
