"""Acceptance tests for the approval workflow CLI.

Reference state table (transitions):
    RUNNING            -- decide approve (partial)  --> RUNNING
    RUNNING            -- decide approve (all req.) --> APPROVED
    RUNNING            -- decide reject             --> REJECTING
    REJECTING          -- compensation complete     --> REJECTED
    RUNNING            -- tick reaches deadline     --> TIMEOUT_CANCELING
    TIMEOUT_CANCELING  -- compensation complete     --> CANCELED
    *                  -- decide on non-RUNNING     --> refused (exit 1)
    RUNNING            -- same approver, opposite   --> refused (exit 9)
    RUNNING            -- crash after decision event, recover --> effects
                         applied exactly once (no duplicate compensation)
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

CLI = os.path.join(os.path.dirname(os.path.abspath(__file__)), "approval_cli.py")

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_CONFLICT = 9
EXIT_CRASH = 70

# Reference state table: (from_state, event, to_state)
STATE_TABLE = [
    ("RUNNING", "decide approve (partial)", "RUNNING"),
    ("RUNNING", "decide approve (all required)", "APPROVED"),
    ("RUNNING", "decide reject", "REJECTING"),
    ("REJECTING", "compensation complete", "REJECTED"),
    ("RUNNING", "tick >= timeout", "TIMEOUT_CANCELING"),
    ("TIMEOUT_CANCELING", "compensation complete", "CANCELED"),
]


class CliCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = os.path.join(self.tmp.name, "store.json")

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, *argv, expect=EXIT_OK):
        cmd = [sys.executable, CLI, "--store", self.store] + list(argv)
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if expect is not None:
            self.assertEqual(proc.returncode, expect,
                             "cmd=%s\nstdout=%s\nstderr=%s"
                             % (cmd, proc.stdout, proc.stderr))
        return proc

    def load(self):
        with open(self.store, encoding="utf-8") as fh:
            return json.load(fh)

    def state_of(self):
        return self.load()["request"]["state"]

    def journal_types(self):
        return [(e["type"], e.get("item") or e.get("state") or e.get("approver"))
                for e in self.load()["journal"]]

    def test_reference_state_table_is_wellformed(self):
        states = {"RUNNING", "APPROVED", "REJECTING", "REJECTED",
                  "TIMEOUT_CANCELING", "CANCELED", "FAILED"}
        for src, _event, dst in STATE_TABLE:
            self.assertIn(src, states)
            self.assertIn(dst, states)

    def test_high_amount_two_level_approval_completes(self):
        self.run_cli("new", "--amount", "1500", "--timeout", "10",
                     "--items", "seat,inventory")
        proc = self.run_cli("decide", "manager", "approve")
        self.assertIn("state=RUNNING", proc.stdout)  # partial: still RUNNING
        self.assertEqual(self.state_of(), "RUNNING")
        proc = self.run_cli("decide", "finance", "approve")
        self.assertIn("state=APPROVED", proc.stdout)
        self.assertEqual(self.state_of(), "APPROVED")
        # No compensation on the happy path.
        self.assertNotIn(("compensate", "seat"), self.journal_types())
        self.assertEqual(self.load()["request"]["compensated"], [])

    def test_low_amount_needs_manager_only(self):
        self.run_cli("new", "--amount", "500", "--timeout", "5", "--items", "seat")
        proc = self.run_cli("decide", "manager", "approve")
        self.assertIn("state=APPROVED", proc.stdout)
        # finance is not a required approver for low amounts.
        self.run_cli("decide", "finance", "approve", expect=EXIT_ERROR)

    def test_manager_rejects_finance_refused_reverse_compensation(self):
        self.run_cli("new", "--amount", "2000", "--timeout", "10",
                     "--items", "a,b,c")
        proc = self.run_cli("decide", "manager", "reject")
        self.assertIn("state=REJECTED", proc.stdout)
        self.assertEqual(self.state_of(), "REJECTED")
        # Finance decision after rejection is refused.
        self.run_cli("decide", "finance", "approve", expect=EXIT_ERROR)
        self.run_cli("decide", "finance", "reject", expect=EXIT_ERROR)
        # Reserved items compensated in reverse order: c, b, a.
        self.assertEqual(self.load()["request"]["compensated"], ["c", "b", "a"])
        comp = [e["item"] for e in self.load()["journal"] if e["type"] == "compensate"]
        self.assertEqual(comp, ["c", "b", "a"])
        # REJECTING was traversed before REJECTED.
        states = [e["state"] for e in self.load()["journal"] if e["type"] == "state"]
        self.assertEqual(states, ["RUNNING", "REJECTING", "REJECTED"])

    def test_timeout_auto_cancels_with_per_tick_events(self):
        self.run_cli("new", "--amount", "100", "--timeout", "3", "--items", "x,y")
        # Expected per-tick event sequence.
        expected = {
            1: "no-events",
            2: "no-events",
            3: "state=TIMEOUT_CANCELING compensate:y compensate:x state=CANCELED",
        }
        for tick in (1, 2, 3):
            proc = self.run_cli("tick")
            self.assertIn("tick=%d %s" % (tick, expected[tick]), proc.stdout)
        self.assertEqual(self.state_of(), "CANCELED")
        self.assertEqual(self.load()["request"]["compensated"], ["y", "x"])
        # Decisions after cancellation are refused.
        self.run_cli("decide", "manager", "approve", expect=EXIT_ERROR)
        # Further ticks on a terminal request produce no events.
        proc = self.run_cli("tick")
        self.assertIn("tick=4 no-events", proc.stdout)

    def test_approve_before_deadline_prevents_timeout(self):
        self.run_cli("new", "--amount", "100", "--timeout", "2", "--items", "x")
        self.run_cli("tick")
        self.run_cli("decide", "manager", "approve")
        proc = self.run_cli("tick")  # reaches deadline but already APPROVED
        self.assertIn("tick=2 no-events", proc.stdout)
        self.assertEqual(self.state_of(), "APPROVED")

    def test_duplicate_approve_idempotent_and_conflict_exit_9(self):
        self.run_cli("new", "--amount", "1500", "--timeout", "10", "--items", "s")
        self.run_cli("decide", "manager", "approve")
        proc = self.run_cli("decide", "manager", "approve")  # idempotent
        self.assertIn("idempotent", proc.stdout)
        self.assertEqual(self.state_of(), "RUNNING")
        # Opposite decision by the same approver -> exit code 9.
        proc = self.run_cli("decide", "manager", "reject", expect=EXIT_CONFLICT)
        self.assertEqual(proc.returncode, 9)
        self.assertEqual(self.state_of(), "RUNNING")
        # Journal holds exactly one manager decision.
        decisions = [e for e in self.load()["journal"] if e["type"] == "decision"]
        self.assertEqual(len(decisions), 1)
        # Duplicate reject is also idempotent.
        self.run_cli("decide", "finance", "reject")
        proc = self.run_cli("decide", "finance", "reject")
        self.assertIn("idempotent", proc.stdout)
        self.run_cli("decide", "finance", "approve", expect=EXIT_CONFLICT)

    def test_crash_after_decision_event_recovers_without_duplicate_compensation(self):
        self.run_cli("new", "--amount", "3000", "--timeout", "10",
                     "--items", "a,b,c")
        self.run_cli("crash", "--at", "after-decision")
        proc = self.run_cli("decide", "manager", "reject", expect=EXIT_CRASH)
        self.assertIn("CRASH", proc.stdout)
        # Decision event persisted, actions not yet applied.
        data = self.load()
        self.assertEqual(data["request"]["decisions"], {"manager": "reject"})
        self.assertEqual(data["request"]["state"], "RUNNING")
        self.assertEqual(data["request"]["compensated"], [])
        # Recover applies effects exactly once.
        proc = self.run_cli("recover")
        self.assertIn("state=REJECTED", proc.stdout)
        self.assertEqual(self.state_of(), "REJECTED")
        comp = [e["item"] for e in self.load()["journal"] if e["type"] == "compensate"]
        self.assertEqual(comp, ["c", "b", "a"])  # reverse order, no duplicates
        # A second recover is a no-op.
        proc = self.run_cli("recover")
        self.assertIn("nothing pending", proc.stdout)
        comp = [e["item"] for e in self.load()["journal"] if e["type"] == "compensate"]
        self.assertEqual(comp, ["c", "b", "a"])

    def test_crash_mid_compensation_recovers_remaining_only(self):
        self.run_cli("new", "--amount", "100", "--timeout", "10",
                     "--items", "a,b,c")
        self.run_cli("crash", "--at", "mid-compensation")
        self.run_cli("decide", "manager", "reject", expect=EXIT_CRASH)
        # Only the first (reverse-order) item compensated before the crash.
        self.assertEqual(self.load()["request"]["compensated"], ["c"])
        self.run_cli("recover")
        comp = [e["item"] for e in self.load()["journal"] if e["type"] == "compensate"]
        self.assertEqual(comp, ["c", "b", "a"])  # c not duplicated
        self.assertEqual(self.state_of(), "REJECTED")


if __name__ == "__main__":
    unittest.main()
