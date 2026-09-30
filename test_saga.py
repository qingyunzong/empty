"""Acceptance tests for the saga CLI.

Each test declares its expectations as inline enumerations of states,
completed steps and steps to compensate, then asserts the real CLI behavior
against them. The CLI is exercised through real subprocesses so that the
simulated-crash exit path is genuinely abrupt.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

SAGA_PY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "saga.py")

EXIT_OK = 0
EXIT_CONFLICT = 9
EXIT_CRASH = 99


class Status:
    RUNNING = "RUNNING"
    CANCELING = "CANCELING"
    CANCELED = "CANCELED"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


class SagaCliTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state_dir = os.path.join(self.tmp.name, "state")
        self.def_path = os.path.join(self.tmp.name, "def.json")
        self.saga_id = "saga-1"
        self.request_key = "req-1"
        self.write_definition([
            {"name": "A", "commit": {"op": "log"}, "compensate": {"op": "log"}},
            {"name": "B", "commit": {"op": "log"}, "compensate": {"op": "log"}},
            {"name": "C", "commit": {"op": "log"}, "compensate": {"op": "log"}},
        ])

    # ------------------------------------------------------------ helpers

    def write_definition(self, steps):
        with open(self.def_path, "w", encoding="utf-8") as fh:
            json.dump({"steps": steps}, fh)

    def cli(self, *argv, crash_after=None):
        env = dict(os.environ)
        if crash_after:
            env["SAGA_CRASH_AFTER"] = crash_after
        else:
            env.pop("SAGA_CRASH_AFTER", None)
        return subprocess.run(
            [sys.executable, SAGA_PY, *argv, "--state-dir", self.state_dir],
            capture_output=True, text=True, env=env, check=False,
        )

    def new_saga(self):
        result = self.cli("new", "--id", self.saga_id,
                          "--def", self.def_path, "--key", self.request_key)
        self.assertEqual(result.returncode, EXIT_OK, result.stderr)

    def read_state(self):
        result = self.cli("state", "--id", self.saga_id)
        self.assertEqual(result.returncode, EXIT_OK, result.stderr)
        return json.loads(result.stdout)

    def read_effects(self):
        path = os.path.join(self.state_dir, self.saga_id + ".effects.log")
        if not os.path.exists(path):
            return []
        with open(path, "r", encoding="utf-8") as fh:
            return [line.split()[1:] for line in fh.read().splitlines()]

    def assert_outcome(self, expected_status, expected_completed,
                       expected_to_compensate):
        state = self.read_state()
        self.assertEqual(state["status"], expected_status)
        self.assertEqual(state["completed_steps"], expected_completed)
        self.assertEqual(state["compensated_steps"], expected_to_compensate)
        return state


class CancelBeforeStartTest(SagaCliTestCase):
    def test_cancel_before_start_yields_canceled_with_no_actions(self):
        EXPECTED_STATE_SEQUENCE = [Status.RUNNING, Status.CANCELED]
        EXPECTED_COMPLETED_STEPS = []
        EXPECTED_STEPS_TO_COMPENSATE = []
        EXPECTED_EFFECTS = []

        self.new_saga()
        observed_states = [self.read_state()["status"]]

        cancel = self.cli("cancel", "--id", self.saga_id)
        self.assertEqual(cancel.returncode, EXIT_OK, cancel.stderr)
        observed_states.append(self.read_state()["status"])

        self.assertEqual(observed_states, EXPECTED_STATE_SEQUENCE)
        self.assert_outcome(Status.CANCELED, EXPECTED_COMPLETED_STEPS,
                            EXPECTED_STEPS_TO_COMPENSATE)
        self.assertEqual(self.read_effects(), EXPECTED_EFFECTS)


class CancelAfterFirstStepTest(SagaCliTestCase):
    def test_cancel_after_A_before_B_compensates_only_A(self):
        EXPECTED_COMPLETED_STEPS = ["A"]
        EXPECTED_STEPS_TO_COMPENSATE = ["A"]
        EXPECTED_EFFECTS = [["A", "commit"], ["A", "compensate"]]

        self.new_saga()
        # Crash right after A's commit event is persisted: A committed,
        # B never started.
        run = self.cli("run", "--id", self.saga_id,
                       crash_after="event:step_committed:A")
        self.assertEqual(run.returncode, EXIT_CRASH, run.stderr)
        self.assert_outcome(Status.RUNNING, ["A"], [])

        cancel = self.cli("cancel", "--id", self.saga_id)
        self.assertEqual(cancel.returncode, EXIT_OK, cancel.stderr)

        state = self.assert_outcome(Status.CANCELED, EXPECTED_COMPLETED_STEPS,
                                    EXPECTED_STEPS_TO_COMPENSATE)
        self.assertEqual(self.read_effects(), EXPECTED_EFFECTS)
        self.assertEqual(state["pending_compensations"], [])


class CancelAfterCompletedTest(SagaCliTestCase):
    def test_cancel_after_completion_conflicts_with_exit_9(self):
        EXPECTED_COMPLETED_STEPS = ["A", "B", "C"]
        EXPECTED_STEPS_TO_COMPENSATE = []

        self.new_saga()
        run = self.cli("run", "--id", self.saga_id)
        self.assertEqual(run.returncode, EXIT_OK, run.stderr)
        self.assert_outcome(Status.COMPLETED, EXPECTED_COMPLETED_STEPS,
                            EXPECTED_STEPS_TO_COMPENSATE)

        cancel = self.cli("cancel", "--id", self.saga_id)
        self.assertEqual(cancel.returncode, EXIT_CONFLICT, cancel.stderr)

        # State is unchanged by the rejected cancel.
        state = self.assert_outcome(Status.COMPLETED, EXPECTED_COMPLETED_STEPS,
                                    EXPECTED_STEPS_TO_COMPENSATE)
        self.assertFalse(state["cancel_requested"])
        self.assertEqual(self.read_effects(),
                         [["A", "commit"], ["B", "commit"], ["C", "commit"]])


class CrashRecoveryCancelTest(SagaCliTestCase):
    def test_cancel_survives_crash_and_recovery_completes_it(self):
        EXPECTED_COMPLETED_STEPS = ["A"]
        EXPECTED_STEPS_TO_COMPENSATE = ["A"]
        EXPECTED_EFFECTS = [["A", "commit"], ["A", "compensate"]]

        self.new_saga()
        run = self.cli("run", "--id", self.saga_id,
                       crash_after="event:step_committed:A")
        self.assertEqual(run.returncode, EXIT_CRASH, run.stderr)

        # Cancel persists its flag, then crashes right after the
        # compensation event for A is persisted.
        cancel = self.cli("cancel", "--id", self.saga_id,
                          crash_after="event:compensated:A")
        self.assertEqual(cancel.returncode, EXIT_CRASH, cancel.stderr)

        mid = self.read_state()
        self.assertEqual(mid["status"], Status.CANCELING)
        self.assertTrue(mid["cancel_requested"])  # flag not lost
        self.assertEqual(mid["pending_compensations"], [])

        recover = self.cli("recover", "--id", self.saga_id)
        self.assertEqual(recover.returncode, EXIT_OK, recover.stderr)

        self.assert_outcome(Status.CANCELED, EXPECTED_COMPLETED_STEPS,
                            EXPECTED_STEPS_TO_COMPENSATE)
        # A's compensate action executed exactly once despite the crash.
        self.assertEqual(self.read_effects(), EXPECTED_EFFECTS)


class RepeatedCancelTest(SagaCliTestCase):
    def test_repeated_cancel_is_idempotent(self):
        EXPECTED_COMPLETED_STEPS = ["A"]
        EXPECTED_STEPS_TO_COMPENSATE = ["A"]
        EXPECTED_EFFECTS = [["A", "commit"], ["A", "compensate"]]

        self.new_saga()
        run = self.cli("run", "--id", self.saga_id,
                       crash_after="event:step_committed:A")
        self.assertEqual(run.returncode, EXIT_CRASH, run.stderr)

        first = self.cli("cancel", "--id", self.saga_id)
        second = self.cli("cancel", "--id", self.saga_id)
        self.assertEqual(first.returncode, EXIT_OK, first.stderr)
        self.assertEqual(second.returncode, EXIT_OK, second.stderr)

        self.assert_outcome(Status.CANCELED, EXPECTED_COMPLETED_STEPS,
                            EXPECTED_STEPS_TO_COMPENSATE)
        # Compensation ran exactly once.
        self.assertEqual(self.read_effects(), EXPECTED_EFFECTS)


class RunAndRecoverTest(SagaCliTestCase):
    def test_full_run_completes_all_steps_in_order(self):
        EXPECTED_COMPLETED_STEPS = ["A", "B", "C"]
        EXPECTED_STEPS_TO_COMPENSATE = []
        EXPECTED_EFFECTS = [["A", "commit"], ["B", "commit"], ["C", "commit"]]

        self.new_saga()
        run = self.cli("run", "--id", self.saga_id)
        self.assertEqual(run.returncode, EXIT_OK, run.stderr)

        self.assert_outcome(Status.COMPLETED, EXPECTED_COMPLETED_STEPS,
                            EXPECTED_STEPS_TO_COMPENSATE)
        self.assertEqual(self.read_effects(), EXPECTED_EFFECTS)

    def test_recover_after_crash_resumes_without_reexecuting_actions(self):
        EXPECTED_COMPLETED_STEPS = ["A", "B", "C"]
        EXPECTED_STEPS_TO_COMPENSATE = []
        EXPECTED_EFFECTS = [["A", "commit"], ["B", "commit"], ["C", "commit"]]

        self.new_saga()
        crashed = self.cli("run", "--id", self.saga_id,
                           crash_after="event:step_committed:B")
        self.assertEqual(crashed.returncode, EXIT_CRASH, crashed.stderr)
        self.assert_outcome(Status.RUNNING, ["A", "B"], [])

        recover = self.cli("recover", "--id", self.saga_id)
        self.assertEqual(recover.returncode, EXIT_OK, recover.stderr)

        self.assert_outcome(Status.COMPLETED, EXPECTED_COMPLETED_STEPS,
                            EXPECTED_STEPS_TO_COMPENSATE)
        # B's commit appears exactly once: actions are idempotent by
        # request key + step name.
        self.assertEqual(self.read_effects(), EXPECTED_EFFECTS)


class FailedActionTest(SagaCliTestCase):
    def test_failing_commit_marks_saga_failed(self):
        EXPECTED_COMPLETED_STEPS = ["A"]
        EXPECTED_STEPS_TO_COMPENSATE = []

        self.write_definition([
            {"name": "A", "commit": {"op": "log"}, "compensate": {"op": "log"}},
            {"name": "B", "commit": {"op": "fail"}, "compensate": {"op": "log"}},
        ])
        self.new_saga()
        run = self.cli("run", "--id", self.saga_id)
        self.assertEqual(run.returncode, 2, run.stderr)

        self.assert_outcome(Status.FAILED, EXPECTED_COMPLETED_STEPS,
                            EXPECTED_STEPS_TO_COMPENSATE)
        self.assertEqual(self.read_effects(), [["A", "commit"]])


if __name__ == "__main__":
    unittest.main()
