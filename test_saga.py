"""Acceptance tests for the saga orchestrator CLI (saga.py)."""
import enum
import json
import os
import subprocess
import sys
import tempfile
import unittest

SAGA_PY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "saga.py")

EXIT_OK = 0
EXIT_CRASH = 3
EXIT_CONFLICT = 9


class Status(enum.Enum):
    RUNNING = "RUNNING"
    CANCELING = "CANCELING"
    CANCELED = "CANCELED"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


class Step(enum.Enum):
    A = "A"
    B = "B"
    C = "C"


class Expected(enum.Enum):
    """Inline expectations: (status, completed steps, pending compensation)."""
    FRESH = (Status.RUNNING, (), ())
    AFTER_A = (Status.RUNNING, (Step.A,), (Step.A,))
    CANCEL_BEFORE_START = (Status.CANCELED, (), ())
    CANCEL_AFTER_A = (Status.CANCELED, (Step.A,), ())
    COMPLETED_ALL = (Status.COMPLETED, (Step.A, Step.B), (Step.B, Step.A))
    CANCELING_AFTER_A = (Status.CANCELING, (Step.A,), (Step.A,))


def steps_of(expected):
    return [step.value for step in expected.value[1]]


class SagaCliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state_dir = os.path.join(self.tmp.name, "state")
        self.def_path = os.path.join(self.tmp.name, "saga.json")
        self.saga_id = "saga-1"
        self.write_definition([
            {"name": "A",
             "commit": {"type": "log", "message": "commit-A"},
             "compensate": {"type": "log", "message": "compensate-A"}},
            {"name": "B",
             "commit": {"type": "log", "message": "commit-B"},
             "compensate": {"type": "log", "message": "compensate-B"}},
        ])

    # -- helpers ---------------------------------------------------------

    def write_definition(self, steps):
        with open(self.def_path, "w", encoding="utf-8") as fh:
            json.dump({"name": "test-saga", "steps": steps}, fh)

    def cli(self, *args):
        return subprocess.run(
            [sys.executable, SAGA_PY, "--state-dir", self.state_dir, *args],
            capture_output=True, text=True)

    def new(self):
        result = self.cli("new", self.def_path, "--id", self.saga_id,
                          "--key", "req-1")
        self.assertEqual(result.returncode, EXIT_OK, result.stderr)

    def state(self):
        result = self.cli("state", "--id", self.saga_id)
        self.assertEqual(result.returncode, EXIT_OK, result.stderr)
        return json.loads(result.stdout)

    def assert_matches(self, expected):
        st = self.state()
        self.assertEqual(st["state"], expected.value[0].value)
        self.assertEqual(st["completed_steps"], steps_of(expected))
        self.assertEqual(st["pending_compensation"],
                         [s.value for s in expected.value[2]])
        return st

    def effect_kinds(self, st):
        return [(e["step"], e["kind"]) for e in st["effects"]]

    # -- acceptance tests --------------------------------------------------

    def test_cancel_before_start_gives_canceled_without_actions(self):
        self.new()
        self.assert_matches(Expected.FRESH)
        result = self.cli("cancel", "--id", self.saga_id)
        self.assertEqual(result.returncode, EXIT_OK, result.stderr)
        st = self.assert_matches(Expected.CANCEL_BEFORE_START)
        self.assertEqual(st["effects"], [])
        self.assertEqual(st["action_journal"], [])
        # A later run must not execute anything either.
        result = self.cli("run", "--id", self.saga_id)
        self.assertEqual(result.returncode, EXIT_OK, result.stderr)
        st = self.assert_matches(Expected.CANCEL_BEFORE_START)
        self.assertEqual(st["effects"], [])

    def test_cancel_before_second_step_compensates_only_a(self):
        self.new()
        result = self.cli("run", "--id", self.saga_id, "--stop-after", "1")
        self.assertEqual(result.returncode, EXIT_OK, result.stderr)
        self.assert_matches(Expected.AFTER_A)
        result = self.cli("cancel", "--id", self.saga_id)
        self.assertEqual(result.returncode, EXIT_OK, result.stderr)
        st = self.assert_matches(Expected.CANCEL_AFTER_A)
        self.assertEqual(self.effect_kinds(st),
                         [("A", "commit"), ("A", "compensate")])
        self.assertEqual(st["compensated_steps"], ["A"])

    def test_cancel_after_completed_conflicts_with_exit_9(self):
        self.new()
        result = self.cli("run", "--id", self.saga_id)
        self.assertEqual(result.returncode, EXIT_OK, result.stderr)
        before = self.assert_matches(Expected.COMPLETED_ALL)
        result = self.cli("cancel", "--id", self.saga_id)
        self.assertEqual(result.returncode, EXIT_CONFLICT)
        after = self.assert_matches(Expected.COMPLETED_ALL)
        self.assertEqual(after["effects"], before["effects"])
        self.assertEqual(after["compensated_steps"], [])

    def test_crash_recovery_still_completes_cancel(self):
        self.new()
        result = self.cli("run", "--id", self.saga_id, "--stop-after", "1")
        self.assertEqual(result.returncode, EXIT_OK, result.stderr)
        # Crash right after the compensation event for A is persisted.
        result = self.cli("cancel", "--id", self.saga_id,
                          "--crash-after", "compensation_started:A")
        self.assertEqual(result.returncode, EXIT_CRASH)
        st = self.assert_matches(Expected.CANCELING_AFTER_A)
        self.assertTrue(st["cancel_requested"])  # flag not lost
        result = self.cli("recover", "--id", self.saga_id)
        self.assertEqual(result.returncode, EXIT_OK, result.stderr)
        st = self.assert_matches(Expected.CANCEL_AFTER_A)
        self.assertEqual(self.effect_kinds(st),
                         [("A", "commit"), ("A", "compensate")])

    def test_repeated_cancel_is_idempotent(self):
        self.new()
        result = self.cli("run", "--id", self.saga_id, "--stop-after", "1")
        self.assertEqual(result.returncode, EXIT_OK, result.stderr)
        for _ in range(3):
            result = self.cli("cancel", "--id", self.saga_id)
            self.assertEqual(result.returncode, EXIT_OK, result.stderr)
        st = self.assert_matches(Expected.CANCEL_AFTER_A)
        self.assertEqual(self.effect_kinds(st),
                         [("A", "commit"), ("A", "compensate")])
        self.assertEqual(len(st["action_journal"]),
                         len(set(st["action_journal"])))

    def test_crash_recovery_completes_run(self):
        self.new()
        # Crash right after the commit action of A is persisted.
        result = self.cli("run", "--id", self.saga_id,
                          "--crash-after", "action:A:commit")
        self.assertEqual(result.returncode, EXIT_CRASH)
        st = self.state()
        self.assertEqual(st["state"], Status.RUNNING.value)
        result = self.cli("recover", "--id", self.saga_id)
        self.assertEqual(result.returncode, EXIT_OK, result.stderr)
        st = self.assert_matches(Expected.COMPLETED_ALL)
        # A's commit ran exactly once despite the crash + resume.
        self.assertEqual(self.effect_kinds(st),
                         [("A", "commit"), ("B", "commit")])

    def test_actions_are_idempotent_by_request_key_and_step(self):
        self.new()
        result = self.cli("run", "--id", self.saga_id,
                          "--crash-after", "step_committed:A")
        self.assertEqual(result.returncode, EXIT_CRASH)
        result = self.cli("recover", "--id", self.saga_id)
        self.assertEqual(result.returncode, EXIT_OK, result.stderr)
        st = self.assert_matches(Expected.COMPLETED_ALL)
        journal = st["action_journal"]
        self.assertEqual(journal, ["req-1:A:commit", "req-1:B:commit"])
        self.assertEqual(len(journal), len(set(journal)))

    def test_failed_action_marks_saga_failed(self):
        self.write_definition([
            {"name": "A", "commit": {"type": "fail", "message": "boom"},
             "compensate": {"type": "log", "message": "compensate-A"}},
        ])
        self.new()
        result = self.cli("run", "--id", self.saga_id)
        self.assertEqual(result.returncode, 1)
        st = self.state()
        self.assertEqual(st["state"], Status.FAILED.value)


if __name__ == "__main__":
    unittest.main()
