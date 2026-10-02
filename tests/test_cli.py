"""End-to-end JSON CLI: ops, state file, crash between write and response."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone

T0 = int(datetime(2023, 10, 1, 12, 0, tzinfo=timezone.utc).timestamp())
FAR = T0 + 10_000
CLI = [sys.executable, "-m", "budget_gate.cli"]


def run_cli(state, op, env_extra=None):
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    proc = subprocess.run(
        CLI + ["--state", state, json.dumps(op)],
        capture_output=True, text=True, env=env,
    )
    return proc


def run_ok(state, op):
    proc = run_cli(state, op)
    assert proc.returncode == 0, proc.stderr + proc.stdout
    return json.loads(proc.stdout)


class CliTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = os.path.join(self.tmp.name, "state.json")

    def tearDown(self):
        self.tmp.cleanup()

    def bootstrap(self, cap=5):
        run_ok(self.state, {"op": "add_subject", "subject": "s"})
        run_ok(self.state, {
            "op": "set_quota", "subject": "s", "rule_id": "r",
            "windows": [{"type": "rolling", "seconds": 3600, "capacity": cap}],
        })

    def reserve_op(self, id="q", amount=3):
        return {"op": "reserve", "id": id, "subject": "s", "amount": amount,
                "execute_at": T0, "confirm_by": FAR, "now": T0}


class TestCliFlow(CliTestBase):
    def test_full_flow(self):
        self.bootstrap()
        out = run_ok(self.state, self.reserve_op())
        self.assertEqual(out["result"], {"status": "reserved", "id": "q", "version": 1})
        out = run_ok(self.state, {"op": "confirm", "id": "q", "version": 1, "now": T0 + 1})
        self.assertEqual(out["result"]["status"], "confirmed")
        out = run_ok(self.state, {"op": "status"})
        self.assertEqual(out["result"]["reservations"]["q"]["status"], "confirmed")
        out = run_ok(self.state, {"op": "occupancy", "subject": "s", "execute_at": T0})
        self.assertEqual(out["result"]["windows"][0]["occupied"], 3)

    def test_rejection_carries_evidence(self):
        self.bootstrap(cap=2)
        out = run_ok(self.state, self.reserve_op(amount=3))
        self.assertEqual(out["result"]["status"], "rejected")
        failure = out["result"]["failures"][0]
        self.assertEqual(failure["window_id"], "rolling[3600s]")
        self.assertEqual(failure["capacity"], 2)

    def test_protocol_error_exit_code(self):
        self.bootstrap()
        proc = run_cli(self.state, {"op": "confirm", "id": "ghost", "version": 1,
                                    "now": T0})
        self.assertEqual(proc.returncode, 2)
        out = json.loads(proc.stdout)
        self.assertFalse(out["ok"])
        self.assertEqual(out["error"]["code"], "unknown_id")

    def test_stdin_input(self):
        run_ok(self.state, {"op": "add_subject", "subject": "s"})
        proc = subprocess.run(CLI + ["--state", self.state],
                              input=json.dumps({"op": "status"}),
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0)
        self.assertIn("s", json.loads(proc.stdout)["result"]["subjects"])


class TestCrashRecovery(CliTestBase):
    def test_crash_between_confirm_write_and_response(self):
        self.bootstrap()
        run_ok(self.state, self.reserve_op())
        # Crash after the state write, before the response is delivered.
        proc = run_cli(self.state,
                       {"op": "confirm", "id": "q", "version": 1, "now": T0 + 1},
                       env_extra={"BUDGET_GATE_CRASH_AFTER_WRITE": "1"})
        self.assertEqual(proc.returncode, 75)
        self.assertEqual(proc.stdout, "")
        # The write did land: the state shows the confirmation.
        out = run_ok(self.state, {"op": "status"})
        self.assertEqual(out["result"]["reservations"]["q"]["status"], "confirmed")
        # The client retries; the replay is idempotent and reports success.
        out = run_ok(self.state, {"op": "confirm", "id": "q", "version": 1, "now": T0 + 2})
        self.assertEqual(out["result"]["status"], "confirmed")
        self.assertTrue(out["result"]["replayed"])

    def test_crash_between_reserve_write_and_response_charges_once(self):
        self.bootstrap()
        proc = run_cli(self.state, self.reserve_op(),
                       env_extra={"BUDGET_GATE_CRASH_AFTER_WRITE": "1"})
        self.assertEqual(proc.returncode, 75)
        # Retry the identical request: recorded result, no double charge.
        out = run_ok(self.state, self.reserve_op())
        self.assertEqual(out["result"]["status"], "reserved")
        self.assertTrue(out["result"]["replayed"])
        out = run_ok(self.state, {"op": "occupancy", "subject": "s", "execute_at": T0})
        self.assertEqual(out["result"]["windows"][0]["occupied"], 3)

    def test_crash_during_rejected_reserve_replays_rejection(self):
        self.bootstrap(cap=2)
        proc = run_cli(self.state, self.reserve_op(amount=3),
                       env_extra={"BUDGET_GATE_CRASH_AFTER_WRITE": "1"})
        self.assertEqual(proc.returncode, 75)
        out = run_ok(self.state, self.reserve_op(amount=3))
        self.assertEqual(out["result"]["status"], "rejected")
        self.assertTrue(out["result"]["replayed"])


if __name__ == "__main__":
    unittest.main()
