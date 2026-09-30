"""Acceptance tests for transfer.py.

Every scenario is driven through the real CLI in a subprocess so exit codes
and stdout are the genuine ones. The core test asserts each cell of an
inline reference state-transition table:
  cell = (argv, exit_code, status, alice_balance, bob_balance, ledger_len)
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(HERE, "transfer.py")

REQ_OK = {
    "idemkey": "tx-100",
    "accounts": {"alice": 1000, "bob": 500},
    "transfer": {"from": "alice", "to": "bob", "amount": 200},
}
REQ_FAIL_CREDIT = dict(REQ_OK, idemkey="tx-101", failures={"credit": True})
REQ_FAIL_BOTH = dict(REQ_OK, idemkey="tx-102",
                     failures={"credit": True, "refund": True})

# Reference state-transition table. Each row: (scenario, request, cells).
# Each cell: (argv, exit, status, alice, bob, ledger_entries).
TRANSITION_TABLE = [
    ("happy path + idempotent replay", REQ_OK, [
        (["state"],                       2, "PENDING",   1000, 500, 0),
        (["run"],                         0, "COMPLETED",  800, 700, 2),
        (["state"],                       0, "COMPLETED",  800, 700, 2),
        (["run"],                         0, "COMPLETED",  800, 700, 2),
        (["recover"],                     0, "COMPLETED",  800, 700, 2),
    ]),
    ("crash after debit event", REQ_OK, [
        (["crash", "--at", "after-debit-event"], 2, "PREPARED", 1000, 500, 0),
        (["state"],                       2, "PREPARED",  1000, 500, 0),
        (["recover"],                     0, "COMPLETED",  800, 700, 2),
        (["state"],                       0, "COMPLETED",  800, 700, 2),
    ]),
    ("crash after debit action", REQ_OK, [
        (["crash", "--at", "after-debit-action"], 2, "PREPARED", 800, 500, 1),
        (["recover"],                     0, "COMPLETED",  800, 700, 2),
        (["state"],                       0, "COMPLETED",  800, 700, 2),
    ]),
    ("crash after credit action", REQ_OK, [
        (["crash", "--at", "after-credit-action"], 2, "PREPARED", 800, 700, 2),
        (["recover"],                     0, "COMPLETED",  800, 700, 2),
        (["state"],                       0, "COMPLETED",  800, 700, 2),
    ]),
    ("credit fails -> compensation refunds", REQ_FAIL_CREDIT, [
        (["run"],                         0, "COMPENSATED", 1000, 500, 2),
        (["state"],                       0, "COMPENSATED", 1000, 500, 2),
        (["run"],                         0, "COMPENSATED", 1000, 500, 2),
    ]),
    ("credit fails, compensation fails -> FAILED", REQ_FAIL_BOTH, [
        (["run"],                        10, "FAILED",      800, 500, 1),
        (["state"],                      10, "FAILED",      800, 500, 1),
        (["recover"],                    10, "FAILED",      800, 500, 1),
    ]),
    ("crash then recover under failing credit", REQ_FAIL_CREDIT, [
        (["crash", "--at", "after-debit-action"], 2, "PREPARED", 800, 500, 1),
        (["recover"],                     0, "COMPENSATED", 1000, 500, 2),
        (["state"],                       0, "COMPENSATED", 1000, 500, 2),
    ]),
]


def run_cli(*argv):
    proc = subprocess.run(
        [sys.executable, CLI, *argv],
        capture_output=True, text=True,
    )
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def ledger_len(dirpath):
    path = os.path.join(dirpath, "ledger.jsonl")
    if not os.path.exists(path):
        return 0
    with open(path, encoding="utf-8") as fh:
        return sum(1 for line in fh if line.strip())


class TransitionTableTest(unittest.TestCase):
    def test_transition_table_cell_by_cell(self):
        for scenario, request, cells in TRANSITION_TABLE:
            with self.subTest(scenario=scenario), \
                    tempfile.TemporaryDirectory() as tmp:
                dirpath = os.path.join(tmp, "sys")
                req_path = os.path.join(tmp, "req.json")
                with open(req_path, "w", encoding="utf-8") as fh:
                    json.dump(request, fh)

                code, out, _ = run_cli("new", "--request", req_path,
                                       "--dir", dirpath)
                self.assertEqual(code, 0, f"new failed: {out}")
                payload = json.loads(out)
                self.assertEqual(payload["status"], "PENDING")
                self.assertEqual(payload["balances"],
                                 {"alice": 1000, "bob": 500})

                for index, (argv, want_code, want_status,
                            want_alice, want_bob, want_ledger) in enumerate(cells):
                    label = f"{scenario} cell {index}: {' '.join(argv)}"
                    code, out, err = run_cli(*argv, "--dir", dirpath)
                    self.assertEqual(code, want_code,
                                     f"{label}\nstdout={out}\nstderr={err}")
                    payload = json.loads(out)
                    self.assertEqual(payload["status"], want_status, label)
                    self.assertEqual(payload["balances"],
                                     {"alice": want_alice, "bob": want_bob},
                                     label)
                    self.assertEqual(payload["idemkey"], request["idemkey"],
                                     label)
                    self.assertEqual(ledger_len(dirpath), want_ledger, label)


class RepeatedRequestTest(unittest.TestCase):
    def test_same_idemkey_replay_returns_same_final_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            dirpath = os.path.join(tmp, "sys")
            req_path = os.path.join(tmp, "req.json")
            with open(req_path, "w", encoding="utf-8") as fh:
                json.dump(REQ_OK, fh)

            self.assertEqual(run_cli("new", "--request", req_path,
                                     "--dir", dirpath)[0], 0)
            code, first_out, _ = run_cli("run", "--dir", dirpath)
            self.assertEqual(code, 0)
            ledger_before = ledger_len(dirpath)

            # Re-issue the identical request (same idemkey) repeatedly.
            for _ in range(2):
                code, out, _ = run_cli("new", "--request", req_path,
                                       "--dir", dirpath)
                self.assertEqual(code, 0)
                self.assertEqual(json.loads(out), json.loads(first_out))
            code, out, _ = run_cli("run", "--dir", dirpath)
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(out), json.loads(first_out))

            # Ledger moved exactly once despite all the replays.
            self.assertEqual(ledger_len(dirpath), ledger_before)
            self.assertEqual(ledger_len(dirpath), 2)

    def test_conflicting_idemkey_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            dirpath = os.path.join(tmp, "sys")
            req_path = os.path.join(tmp, "req.json")
            with open(req_path, "w", encoding="utf-8") as fh:
                json.dump(REQ_OK, fh)
            self.assertEqual(run_cli("new", "--request", req_path,
                                     "--dir", dirpath)[0], 0)
            other = dict(REQ_OK, idemkey="tx-other")
            with open(req_path, "w", encoding="utf-8") as fh:
                json.dump(other, fh)
            code, _, err = run_cli("new", "--request", req_path,
                                   "--dir", dirpath)
            self.assertEqual(code, 4)
            self.assertIn("idemkey", err)


class InvalidInputTest(unittest.TestCase):
    BAD_REQUESTS = [
        ("malformed json", "{not json"),
        ("not an object", "[1, 2, 3]"),
        ("missing idemkey", '{"accounts": {"a": 1, "b": 2}, "transfer": '
                            '{"from": "a", "to": "b", "amount": 1}}'),
        ("three accounts", '{"idemkey": "k", "accounts": '
                           '{"a": 1, "b": 2, "c": 3}, "transfer": '
                           '{"from": "a", "to": "b", "amount": 1}}'),
        ("negative amount", '{"idemkey": "k", "accounts": {"a": 10, "b": 2},'
                            ' "transfer": {"from": "a", "to": "b",'
                            ' "amount": -5}}'),
        ("unknown account", '{"idemkey": "k", "accounts": {"a": 10, "b": 2},'
                            ' "transfer": {"from": "a", "to": "z",'
                            ' "amount": 1}}'),
        ("overspend", '{"idemkey": "k", "accounts": {"a": 10, "b": 2},'
                      ' "transfer": {"from": "a", "to": "b", "amount": 99}}'),
    ]

    def test_invalid_requests_exit_4(self):
        for name, text in self.BAD_REQUESTS:
            with self.subTest(case=name), tempfile.TemporaryDirectory() as tmp:
                req_path = os.path.join(tmp, "bad.json")
                with open(req_path, "w", encoding="utf-8") as fh:
                    fh.write(text)
                code, _, err = run_cli("new", "--request", req_path,
                                       "--dir", os.path.join(tmp, "sys"))
                self.assertEqual(code, 4, f"{name}: expected exit 4")
                self.assertTrue(err, f"{name}: expected an error message")

    def test_bad_cli_usage_exit_4(self):
        with tempfile.TemporaryDirectory() as tmp:
            req_path = os.path.join(tmp, "req.json")
            with open(req_path, "w", encoding="utf-8") as fh:
                json.dump(REQ_OK, fh)
            dirpath = os.path.join(tmp, "sys")
            self.assertEqual(run_cli("new", "--request", req_path,
                                     "--dir", dirpath)[0], 0)
            cases = [
                ("unknown crash point",
                 ["crash", "--at", "mid-air", "--dir", dirpath]),
                ("missing --at", ["crash", "--dir", dirpath]),
                ("unknown command", ["explode", "--dir", dirpath]),
                ("state before new", ["state", "--dir",
                                      os.path.join(tmp, "nope")]),
                ("missing request file",
                 ["new", "--request", os.path.join(tmp, "absent.json"),
                  "--dir", os.path.join(tmp, "sys2")]),
            ]
            for name, argv in cases:
                with self.subTest(case=name):
                    code, _, _ = run_cli(*argv)
                    self.assertEqual(code, 4, name)


class EventLogTest(unittest.TestCase):
    def test_event_log_is_append_only_jsonl(self):
        with tempfile.TemporaryDirectory() as tmp:
            dirpath = os.path.join(tmp, "sys")
            req_path = os.path.join(tmp, "req.json")
            with open(req_path, "w", encoding="utf-8") as fh:
                json.dump(REQ_OK, fh)
            run_cli("new", "--request", req_path, "--dir", dirpath)
            run_cli("crash", "--at", "after-debit-action", "--dir", dirpath)
            with open(os.path.join(dirpath, "events.jsonl"),
                      encoding="utf-8") as fh:
                before = fh.readlines()
            self.assertEqual([json.loads(l)["event"] for l in before],
                             ["transfer_created", "debit_prepared"])
            run_cli("recover", "--dir", dirpath)
            with open(os.path.join(dirpath, "events.jsonl"),
                      encoding="utf-8") as fh:
                after = fh.readlines()
            # Recovery only ever appends; prior lines are untouched.
            self.assertEqual(after[:len(before)], before)
            self.assertEqual([json.loads(l)["event"] for l in after],
                             ["transfer_created", "debit_prepared",
                              "debit_done", "credit_done"])
            for path in ("events.jsonl", "ledger.jsonl"):
                with open(os.path.join(dirpath, path),
                          encoding="utf-8") as fh:
                    for line in fh:
                        self.assertTrue(json.loads(line))  # valid JSONL


if __name__ == "__main__":
    unittest.main()
