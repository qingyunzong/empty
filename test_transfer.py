"""Acceptance tests for transfer_cli.py.

Drives the real CLI via subprocess and asserts every cell of an inline
reference state-transition table: (scenario, crash point, failure flags)
-> (expected final status, balances, exit codes).
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

CLI = os.path.join(os.path.dirname(os.path.abspath(__file__)), "transfer_cli.py")

ALICE_START, BOB_START, AMOUNT = 1000, 500, 200

# Inline reference state-transition table, asserted cell by cell.
# Columns: scenario, crash_at, fail_credit, fail_comp,
#          expected final status, expected alice, expected bob, expected exit code
TRANSITIONS = [
    ("ok",                None,                   False, False, "COMPLETED",    800, 700, 0),
    ("crash_debit_event", "after_debit_event",    False, False, "COMPLETED",    800, 700, 0),
    ("crash_debit_act",   "after_debit_action",   False, False, "COMPLETED",    800, 700, 0),
    ("crash_credit_act",  "after_credit_action",  False, False, "COMPLETED",    800, 700, 0),
    ("compensate",        None,                   True,  False, "COMPENSATED", 1000, 500, 0),
    ("failed",            None,                   True,  True,  "FAILED",       800, 500, 10),
]

# Expected intermediate state right after each crash point (status, alice, bob).
CRASH_INTERMEDIATE = {
    "after_debit_event":  ("PREPARED", 1000, 500),
    "after_debit_action": ("PREPARED",  800, 500),
    "after_credit_action": ("PREPARED", 800, 700),
}

OBSERVED = []  # (scenario, command, exit_code, stdout) recorded for the report


def base_config(fail_credit=False, fail_comp=False):
    return {
        "accounts": {"alice": ALICE_START, "bob": BOB_START},
        "transfer": {
            "idemkey": "tx-1",
            "from": "alice",
            "to": "bob",
            "amount": AMOUNT,
            "fail_credit": fail_credit,
            "fail_compensation": fail_comp,
        },
    }


class TransferCliTest(unittest.TestCase):
    def setUp(self):
        self.workdir = tempfile.mkdtemp(prefix="transfer-test-")
        self.addCleanup(shutil.rmtree, self.workdir, True)
        self.data_dir = os.path.join(self.workdir, "data")

    # --- helpers -----------------------------------------------------------
    def cli(self, *argv):
        proc = subprocess.run(
            [sys.executable, CLI, "--dir", self.data_dir, *argv],
            capture_output=True, text=True)
        return proc

    def record(self, scenario, argv, proc):
        OBSERVED.append((scenario, " ".join(argv), proc.returncode, proc.stdout.strip()))

    def new_workspace(self, config):
        config_path = os.path.join(self.workdir, "config.json")
        with open(config_path, "w", encoding="utf-8") as fh:
            json.dump(config, fh)
        return self.cli("new", config_path)

    def state(self):
        proc = self.cli("state")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout)

    def ledger(self):
        with open(os.path.join(self.data_dir, "ledger.json"), encoding="utf-8") as fh:
            return json.load(fh)

    def assert_state(self, expected_status, expected_alice, expected_bob):
        actual = self.state()
        self.assertEqual(actual["status"], expected_status)
        self.assertEqual(actual["balances"], {"alice": expected_alice, "bob": expected_bob})

    # --- reference-table driven scenarios ----------------------------------
    def test_transition_table(self):
        for (name, crash_at, fail_credit, fail_comp,
             exp_status, exp_alice, exp_bob, exp_exit) in TRANSITIONS:
            with self.subTest(scenario=name):
                self.data_dir = os.path.join(self.workdir, "data-" + name)
                proc = self.new_workspace(base_config(fail_credit, fail_comp))
                self.record(name, ("new",), proc)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assert_state("PENDING", ALICE_START, BOB_START)

                if crash_at is None:
                    proc = self.cli("run")
                    self.record(name, ("run",), proc)
                else:
                    crash = self.cli("crash", "--at", crash_at)
                    self.record(name, ("crash", "--at", crash_at), crash)
                    self.assertEqual(crash.returncode, 2, crash.stderr)
                    mid_status, mid_alice, mid_bob = CRASH_INTERMEDIATE[crash_at]
                    self.assert_state(mid_status, mid_alice, mid_bob)
                    proc = self.cli("recover")
                    self.record(name, ("recover",), proc)

                self.assertEqual(proc.returncode, exp_exit,
                                 "scenario %s: %s" % (name, proc.stderr))
                self.assert_state(exp_status, exp_alice, exp_bob)

    def test_each_cell_of_reference_table(self):
        # Assert the table itself cell by cell so expectations stay explicit.
        for row in TRANSITIONS:
            name, crash_at, fail_credit, fail_comp, status, alice, bob, code = row
            with self.subTest(scenario=name, cell="shape"):
                self.assertEqual(len(row), 8)
                self.assertIn(status, ("PENDING", "PREPARED", "COMPLETED",
                                       "COMPENSATING", "COMPENSATED", "FAILED"))
                self.assertIn(code, (0, 2, 4, 10))
                if status == "COMPLETED":
                    self.assertEqual((alice, bob), (ALICE_START - AMOUNT, BOB_START + AMOUNT))
                if status == "COMPENSATED":
                    self.assertEqual((alice, bob), (ALICE_START, BOB_START))
                if status == "FAILED":
                    self.assertTrue(fail_credit and fail_comp)

    # --- duplicate request / idempotent replay ------------------------------
    def test_duplicate_request_same_idemkey(self):
        self.assertEqual(self.new_workspace(base_config()).returncode, 0)
        first = self.cli("run")
        self.assertEqual(first.returncode, 0, first.stderr)
        ledger_after_first = self.ledger()

        second = self.cli("run")
        self.record("duplicate", ("run", "again"), second)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(json.loads(second.stdout)["status"], "COMPLETED")
        # Ledger mutated exactly once: identical balances and applied keys.
        self.assertEqual(self.ledger(), ledger_after_first)
        self.assertEqual(sorted(ledger_after_first["applied"]),
                         ["tx-1:credit", "tx-1:debit"])
        self.assert_state("COMPLETED", 800, 700)

    def test_replay_after_compensation(self):
        self.assertEqual(self.new_workspace(base_config(fail_credit=True)).returncode, 0)
        self.assertEqual(self.cli("run").returncode, 0)
        ledger_after_first = self.ledger()
        replay = self.cli("run")
        self.assertEqual(replay.returncode, 0, replay.stderr)
        self.assertEqual(json.loads(replay.stdout)["status"], "COMPENSATED")
        self.assertEqual(self.ledger(), ledger_after_first)
        self.assertEqual(sorted(ledger_after_first["applied"]),
                         ["tx-1:debit", "tx-1:refund"])

    def test_replay_after_failure(self):
        config = base_config(fail_credit=True, fail_comp=True)
        self.assertEqual(self.new_workspace(config).returncode, 0)
        self.assertEqual(self.cli("run").returncode, 10)
        replay = self.cli("run")
        self.assertEqual(replay.returncode, 10)
        self.assertEqual(json.loads(replay.stdout)["status"], "FAILED")

    def test_crash_recovers_then_run_is_noop(self):
        self.assertEqual(self.new_workspace(base_config()).returncode, 0)
        self.assertEqual(self.cli("crash", "--at", "after_credit_action").returncode, 2)
        self.assertEqual(self.cli("recover").returncode, 0)
        ledger_after_recover = self.ledger()
        again = self.cli("run")
        self.assertEqual(again.returncode, 0)
        self.assertEqual(self.ledger(), ledger_after_recover)

    # --- event log guarantees ------------------------------------------------
    def test_event_log_is_append_only_jsonl(self):
        self.assertEqual(self.new_workspace(base_config()).returncode, 0)
        self.assertEqual(self.cli("run").returncode, 0)
        path = os.path.join(self.data_dir, "events.jsonl")
        with open(path, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
        self.assertTrue(lines)
        types = []
        for line in lines:
            types.append(json.loads(line)["type"])  # every line is valid JSON
        self.assertEqual(types[0], "created")
        self.assertIn("debit_done", types)
        self.assertIn("credit_done", types)
        self.assertEqual(types[-1], "status")
        statuses = [json.loads(l)["status"] for l in lines
                    if json.loads(l)["type"] == "status"]
        self.assertEqual(statuses, ["PENDING", "PREPARED", "COMPLETED"])

    # --- argument / JSON errors ----------------------------------------------
    def test_invalid_json_config(self):
        bad = os.path.join(self.workdir, "bad.json")
        with open(bad, "w", encoding="utf-8") as fh:
            fh.write("{not valid json")
        proc = self.cli("new", bad)
        self.record("invalid-json", ("new", bad), proc)
        self.assertEqual(proc.returncode, 4)

    def test_invalid_config_shape(self):
        bad = os.path.join(self.workdir, "bad2.json")
        with open(bad, "w", encoding="utf-8") as fh:
            json.dump({"accounts": {"alice": 100}}, fh)  # only one account, no transfer
        proc = self.cli("new", bad)
        self.assertEqual(proc.returncode, 4)

    def test_missing_config_file(self):
        proc = self.cli("new", os.path.join(self.workdir, "nope.json"))
        self.assertEqual(proc.returncode, 4)

    def test_unknown_command_and_bad_crash_point(self):
        proc = subprocess.run([sys.executable, CLI, "--dir", self.data_dir, "bogus"],
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 4)
        self.assertEqual(self.new_workspace(base_config()).returncode, 0)
        proc = self.cli("crash", "--at", "somewhere_else")
        self.assertEqual(proc.returncode, 4)

    def test_state_before_new(self):
        proc = self.cli("state")
        self.assertEqual(proc.returncode, 4)


def tearDownModule():
    print("\n=== observed exit codes / outputs ===")
    for scenario, cmd, code, out in OBSERVED:
        print("%-18s $ %-22s -> exit %d | %s" % (scenario, cmd, code, out))


if __name__ == "__main__":
    unittest.main()
