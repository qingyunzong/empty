"""Unittest suite for saga.py.

Expected reserve/rollback sequences are produced by a small independent
reference recursive algorithm (see ref_* below) and compared against the
real engine journal, event by event.  The CLI is exercised through real
subprocesses so exit codes are genuine.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
SAGA = os.path.join(ROOT_DIR, "saga.py")
ORDER = os.path.join(ROOT_DIR, "order.json")


# --------------------------------------------------------------------------
# Reference recursive algorithm (independent of saga.py internals)
# --------------------------------------------------------------------------
class RefNode:
    def __init__(self, name, parent):
        self.name = name
        self.parent = parent
        self.children = []
        if parent is None:
            self.path = "/"
        elif parent.path == "/":
            self.path = "/" + name
        else:
            self.path = parent.path + "/" + name


def ref_build(data, parent=None):
    node = RefNode(data["name"], parent)
    node.children = [ref_build(c, node) for c in data.get("children", [])]
    return node


def ref_preorder(node):
    """Depth-first, left to right."""
    yield node
    for child in node.children:
        yield from ref_preorder(child)


def ref_reserve_paths(root):
    return [n.path for n in ref_preorder(root)]


def ref_rollback_paths(root, fail_path):
    """Exact rollback sequence for a failure at fail_path.

    Rule: compensate the completed children of the failed node (reverse
    order), then bubble up; every ancestor compensates the previously
    successful siblings of the child on the failure path (reverse order).
    Subtrees are rolled back recursively, children before the node itself.
    """
    reserved = []
    fail = None
    for node in ref_preorder(root):
        if node.path == fail_path:
            fail = node
            break
        reserved.append(node.path)
    assert fail is not None, fail_path
    reserved = set(reserved)
    plan = []

    def comp(node):
        for child in reversed(node.children):
            if child.path in reserved:
                comp(child)
        if node.path in reserved:
            plan.append(node.path)

    for child in reversed(fail.children):
        if child.path in reserved:
            comp(child)
    child, parent = fail, fail.parent
    while parent is not None:
        index = parent.children.index(child)
        for sibling in reversed(parent.children[:index]):
            if sibling.path in reserved:
                comp(sibling)
        child, parent = parent, parent.parent
    return plan


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def load_tree():
    with open(ORDER, "r", encoding="utf-8") as handle:
        return json.load(handle)


class SagaTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state_dir = os.path.join(self.tmp.name, "state")
        self.ref_root = ref_build(load_tree())

    def cli(self, *args):
        return subprocess.run(
            [sys.executable, SAGA, *args, "--state-dir", self.state_dir],
            capture_output=True, text=True)

    def journal(self):
        with open(os.path.join(self.state_dir, "journal.json"),
                  encoding="utf-8") as handle:
            return json.load(handle)

    def world(self):
        with open(os.path.join(self.state_dir, "world.json"),
                  encoding="utf-8") as handle:
            return json.load(handle)

    def event_paths(self, action):
        return [e["path"] for e in self.journal()["events"]
                if e["action"] == action]


# --------------------------------------------------------------------------
# Acceptance tests
# --------------------------------------------------------------------------
class TestRunAllSuccess(SagaTestCase):
    def test_run_all_success(self):
        result = self.cli("run", "--input", ORDER, "--budget", "1000")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.journal()["state"], "COMPLETED")
        expected = ref_reserve_paths(self.ref_root)
        self.assertEqual(self.event_paths("reserve"), expected)
        self.assertEqual(self.event_paths("compensate"), [])
        self.assertEqual(self.world()["reservations"], expected)
        state = self.cli("state")
        self.assertEqual(state.returncode, 0)
        self.assertIn("COMPLETED", state.stdout)


class TestSecondRoomFailure(SagaTestCase):
    def test_rollback_order_is_room1_then_flight(self):
        result = self.cli("fail-at", "room2", "--input", ORDER,
                          "--budget", "1000")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.journal()["state"], "COMPENSATED")
        expected = ref_rollback_paths(self.ref_root, "/hotel/room2")
        self.assertEqual(expected, ["/hotel/room1", "/flight"])
        self.assertEqual(self.event_paths("compensate"), expected)
        self.assertEqual(self.world()["compensations"], expected)


class TestOverBudget(SagaTestCase):
    def test_over_budget_fails_before_any_external_action(self):
        result = self.cli("run", "--input", ORDER, "--budget", "100")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.journal()["state"], "FAILED")
        self.assertEqual(self.journal()["events"], [])
        self.assertEqual(self.world()["reservations"], [])
        self.assertEqual(self.world()["compensations"], [])


class TestCrashAndRecover(SagaTestCase):
    def test_crash_at_event_then_recover(self):
        all_paths = ref_reserve_paths(self.ref_root)
        crash = self.cli("crash", "--at", "3", "--input", ORDER,
                         "--budget", "1000")
        self.assertEqual(crash.returncode, 1)
        events = self.journal()["events"]
        self.assertEqual([e["status"] for e in events],
                         ["confirmed", "confirmed", "pending"])
        # pending event not yet applied to the external world
        self.assertEqual(self.world()["reservations"], all_paths[:2])

        recover = self.cli("recover")
        self.assertEqual(recover.returncode, 0, recover.stderr)
        self.assertEqual(self.journal()["state"], "COMPLETED")
        events = self.journal()["events"]
        self.assertEqual(len(events), len(all_paths))
        self.assertTrue(all(e["status"] == "confirmed" for e in events))
        self.assertEqual([e["path"] for e in events], all_paths)
        # replay happened exactly once: no duplicate reservations
        reservations = self.world()["reservations"]
        self.assertEqual(reservations, all_paths)
        self.assertEqual(len(reservations), len(set(reservations)))

    def test_crash_during_compensation_then_recover(self):
        # reserves occupy events 1..4, room2 fails, compensations are 5,6
        crash = self.cli("crash", "--at", "6", "--fail-at", "room2",
                         "--input", ORDER, "--budget", "1000")
        self.assertEqual(crash.returncode, 1)
        self.assertEqual(self.journal()["state"], "COMPENSATING")
        self.assertEqual(self.world()["compensations"], ["/hotel/room1"])

        recover = self.cli("recover")
        self.assertEqual(recover.returncode, 0, recover.stderr)
        self.assertEqual(self.journal()["state"], "COMPENSATED")
        expected = ref_rollback_paths(self.ref_root, "/hotel/room2")
        self.assertEqual(self.event_paths("compensate"), expected)
        compensations = self.world()["compensations"]
        self.assertEqual(compensations, expected)
        self.assertEqual(len(compensations), len(set(compensations)))


class TestIdempotentRerun(SagaTestCase):
    def test_repeated_run_has_no_duplicate_reservations(self):
        first = self.cli("run", "--input", ORDER, "--budget", "1000")
        self.assertEqual(first.returncode, 0, first.stderr)
        events_before = list(self.journal()["events"])
        world_before = dict(self.world())

        second = self.cli("run", "--input", ORDER, "--budget", "1000")
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(self.journal()["state"], "COMPLETED")
        self.assertEqual(self.journal()["events"], events_before)
        self.assertEqual(self.world(), world_before)
        reservations = self.world()["reservations"]
        self.assertEqual(len(reservations), len(set(reservations)))


class TestRollbackMatchesReference(SagaTestCase):
    def test_every_fail_point_matches_reference_algorithm(self):
        for fail_path in ref_reserve_paths(self.ref_root):
            with self.subTest(fail_at=fail_path):
                self.setUp()
                result = self.cli("fail-at", fail_path, "--input", ORDER,
                                  "--budget", "1000")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.journal()["state"], "COMPENSATED")
                self.assertEqual(
                    self.event_paths("compensate"),
                    ref_rollback_paths(self.ref_root, fail_path))
                reserved_before = ref_reserve_paths(self.ref_root)
                reserved_before = reserved_before[:reserved_before.index(fail_path)]
                self.assertEqual(self.event_paths("reserve"), reserved_before)


if __name__ == "__main__":
    unittest.main()
