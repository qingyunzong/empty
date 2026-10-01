"""Hand-crafted acceptance tests:

a) a three-transaction case with a known optimal number of rounds;
b) a cyclic precedence graph must yield NON_SERIALIZABLE plus the cycle;
c) tied minimal-round schedules must be resolved by the deterministic
   lexicographic rule.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from sched import NON_SERIALIZABLE, ScheduleError, schedule_transactions

REPO_ROOT = Path(__file__).resolve().parent.parent


class ThreeTransactionOptimalRoundsTest(unittest.TestCase):
    """Acceptance (a): hand-built 3-transaction case, known optimum."""

    def setUp(self):
        self.transactions = [
            {
                "id": "T1",
                "ops": [
                    {"type": "write", "key": "x", "value": 1},
                    {"type": "read", "key": "y"},
                ],
            },
            {
                "id": "T2",
                "ops": [
                    {"type": "read", "key": "x"},
                    {"type": "write", "key": "y", "value": 2},
                ],
            },
            {
                "id": "T3",
                "ops": [
                    {"type": "write", "key": "z", "value": 3},
                    {"type": "read", "key": "y"},
                ],
            },
        ]
        self.result = schedule_transactions(self.transactions)

    def test_known_optimal_round_count(self):
        # The dependency chain T1.0 -> T1.1 -> T2.1 -> T3.1 (via conflicts
        # on x and y plus intra-transaction order) forces 4 rounds, and a
        # 4-round schedule exists, so 4 is optimal.
        self.assertEqual(self.result["num_rounds"], 4)
        self.assertEqual(len(self.result["rounds"]), 4)

    def test_exact_schedule(self):
        self.assertEqual(
            self.result["rounds"],
            [
                [["T1", 0], ["T3", 0]],
                [["T1", 1], ["T2", 0]],
                [["T2", 1]],
                [["T3", 1]],
            ],
        )

    def test_intra_transaction_order_preserved(self):
        round_of = {}
        for rnd, ops in enumerate(self.result["rounds"]):
            for txn_id, idx in ops:
                round_of[(txn_id, idx)] = rnd
        for txn_id in ("T1", "T2", "T3"):
            self.assertLess(round_of[(txn_id, 0)], round_of[(txn_id, 1)])


class CyclicPrecedenceGraphTest(unittest.TestCase):
    """Acceptance (b): cyclic dependency must be reported with the cycle."""

    def test_two_transaction_cycle(self):
        # T1 writes x then y; T2 writes x then y.  The explicit reference
        # order makes T1 precede T2 on x but follow T2 on y, which is not
        # conflict serializable.
        transactions = [
            {
                "id": "T1",
                "ops": [
                    {"type": "write", "key": "x", "value": 1},
                    {"type": "write", "key": "y", "value": 2},
                ],
            },
            {
                "id": "T2",
                "ops": [
                    {"type": "write", "key": "x", "value": 3},
                    {"type": "write", "key": "y", "value": 4},
                ],
            },
        ]
        order = [["T1", 0], ["T2", 0], ["T2", 1], ["T1", 1]]
        result = schedule_transactions(transactions, order=order)
        self.assertEqual(result["error"], NON_SERIALIZABLE)
        self.assertNotIn("rounds", result)
        cycle = result["cycle"]
        self.assertEqual(sorted(cycle), ["T1", "T2"])
        # The reported cycle must be a genuine loop: consecutive ids
        # (including last -> first) are precedence edges.
        self.assertEqual(len(cycle), 2)
        self.assertIn(cycle[0], ("T1", "T2"))
        self.assertNotEqual(cycle[0], cycle[1])

    def test_three_transaction_cycle(self):
        # T1 -> T2 (key a), T2 -> T3 (key b), T3 -> T1 (key c).
        transactions = [
            {"id": "T1", "ops": [{"type": "write", "key": "a"},
                                  {"type": "read", "key": "c"}]},
            {"id": "T2", "ops": [{"type": "write", "key": "a"},
                                  {"type": "write", "key": "b"}]},
            {"id": "T3", "ops": [{"type": "read", "key": "b"},
                                  {"type": "write", "key": "c"}]},
        ]
        order = [
            ["T1", 0],  # T1.a before T2.a  -> T1 -> T2
            ["T2", 0],
            ["T2", 1],  # T2.b before T3.b  -> T2 -> T3
            ["T3", 0],
            ["T3", 1],  # T3.c before T1.c  -> T3 -> T1
            ["T1", 1],
        ]
        result = schedule_transactions(transactions, order=order)
        self.assertEqual(result["error"], NON_SERIALIZABLE)
        self.assertEqual(sorted(result["cycle"]), ["T1", "T2", "T3"])

    def test_acyclic_reordered_input_is_serializable(self):
        # Same transactions, but a consistent reference order (equivalent
        # to the serial order T2, T1) must schedule fine.
        transactions = [
            {"id": "T1", "ops": [{"type": "write", "key": "x", "value": 1}]},
            {"id": "T2", "ops": [{"type": "write", "key": "x", "value": 2}]},
        ]
        order = [["T2", 0], ["T1", 0]]
        result = schedule_transactions(transactions, order=order)
        self.assertEqual(result["num_rounds"], 2)
        self.assertEqual(result["rounds"], [[["T2", 0]], [["T1", 0]]])

    def test_order_violating_intra_transaction_order_is_rejected(self):
        transactions = [
            {"id": "T1", "ops": [{"type": "write", "key": "x"},
                                  {"type": "write", "key": "y"}]},
        ]
        with self.assertRaises(ScheduleError):
            schedule_transactions(transactions, order=[["T1", 1], ["T1", 0]])


class LexicographicTieBreakTest(unittest.TestCase):
    """Acceptance (c): deterministic lexicographic choice among ties."""

    def test_earliest_round_and_sorted_listing(self):
        # T1.0 and T2.0 conflict on x, T3.0 is independent.  Minimal
        # schedules use 2 rounds; the tie (where to put T3.0) is resolved
        # by placing every operation in the earliest feasible round and
        # listing each round sorted by (txn_id, op_index).
        transactions = [
            {"id": "T1", "ops": [{"type": "write", "key": "x", "value": 1}]},
            {"id": "T2", "ops": [{"type": "write", "key": "x", "value": 2}]},
            {"id": "T3", "ops": [{"type": "read", "key": "y"}]},
        ]
        result = schedule_transactions(transactions)
        self.assertEqual(result["num_rounds"], 2)
        self.assertEqual(
            result["rounds"],
            [[["T1", 0], ["T3", 0]], [["T2", 0]]],
        )

    def test_all_independent_ops_share_one_sorted_round(self):
        transactions = [
            {"id": "T3", "ops": [{"type": "read", "key": "c"}]},
            {"id": "T1", "ops": [{"type": "read", "key": "a"}]},
            {"id": "T2", "ops": [{"type": "read", "key": "b"}]},
        ]
        result = schedule_transactions(transactions)
        # Read/read pairs never conflict, so a single round suffices and
        # the listing is sorted by (txn_id, op_index), not by input order.
        self.assertEqual(
            result["rounds"],
            [[["T1", 0], ["T2", 0], ["T3", 0]]],
        )

    def test_determinism_for_identical_input(self):
        base = [
            {"id": "T1", "ops": [{"type": "write", "key": "x", "value": 1},
                                  {"type": "read", "key": "y"}]},
            {"id": "T2", "ops": [{"type": "read", "key": "x"},
                                  {"type": "write", "key": "y", "value": 2}]},
            {"id": "T3", "ops": [{"type": "read", "key": "z"}]},
        ]
        self.assertEqual(schedule_transactions(base), schedule_transactions(base))

    def test_output_independent_of_transaction_listing_order(self):
        # With an explicit reference order the schedule must not depend on
        # how the transactions happen to be listed in the input.
        base = [
            {"id": "T1", "ops": [{"type": "write", "key": "x", "value": 1},
                                  {"type": "read", "key": "y"}]},
            {"id": "T2", "ops": [{"type": "read", "key": "x"},
                                  {"type": "write", "key": "y", "value": 2}]},
            {"id": "T3", "ops": [{"type": "read", "key": "z"}]},
        ]
        order = [["T1", 0], ["T2", 0], ["T1", 1], ["T2", 1], ["T3", 0]]
        first = schedule_transactions(base, order=order)
        second = schedule_transactions(list(reversed(base)), order=order)
        self.assertEqual(first, second)


class CliTest(unittest.TestCase):
    def run_cli(self, payload, *extra_args):
        with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False, encoding="utf-8"
        ) as fh:
            json.dump(payload, fh)
            path = fh.name
        try:
            return subprocess.run(
                [sys.executable, "-m", "sched", path, *extra_args],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
                timeout=30,
            )
        finally:
            Path(path).unlink(missing_ok=True)

    def test_cli_outputs_schedule_json(self):
        payload = {
            "transactions": [
                {"id": "T1", "ops": [{"type": "write", "key": "x", "value": 1}]},
                {"id": "T2", "ops": [{"type": "read", "key": "x"}]},
            ]
        }
        proc = self.run_cli(payload)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["num_rounds"], 2)
        self.assertEqual(out["rounds"], [[["T1", 0]], [["T2", 0]]])

    def test_cli_reports_cycle(self):
        payload = {
            "transactions": [
                {"id": "T1", "ops": [{"type": "write", "key": "x"},
                                      {"type": "write", "key": "y"}]},
                {"id": "T2", "ops": [{"type": "write", "key": "x"},
                                      {"type": "write", "key": "y"}]},
            ],
            "order": [["T1", 0], ["T2", 0], ["T2", 1], ["T1", 1]],
        }
        proc = self.run_cli(payload)
        self.assertEqual(proc.returncode, 1)
        out = json.loads(proc.stdout)
        self.assertEqual(out["error"], "NON_SERIALIZABLE")
        self.assertEqual(sorted(out["cycle"]), ["T1", "T2"])

    def test_cli_rejects_malformed_input(self):
        proc = self.run_cli({"transactions": [{"ops": []}]})
        self.assertEqual(proc.returncode, 2)
        err = json.loads(proc.stderr)
        self.assertEqual(err["error"], "INVALID_INPUT")


if __name__ == "__main__":
    unittest.main()
