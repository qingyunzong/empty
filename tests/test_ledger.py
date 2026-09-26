import json
import subprocess
import sys
import unittest
from pathlib import Path

from point_ledger import Ledger, LedgerError

REPO_ROOT = Path(__file__).resolve().parent.parent


class AcceptanceTest(unittest.TestCase):
    """验收边界：10分到期5，4消费6，6退回6，可用必须为0。"""

    def build(self):
        ledger = Ledger()
        ledger.earn("b1", 10, 5, time=0)
        ledger.consume("c1", 6, time=4)
        result = ledger.refund("c1", 6, time=6, refund_id="r1")
        return ledger, result

    def test_no_new_available_after_expiry(self):
        ledger, result = self.build()
        report = ledger.report(now=6)
        totals = report["totals"]
        self.assertEqual(result, {"valid": 0, "expired": 6})
        self.assertEqual(totals["available"], 0,
                         "到期后退款不得重新生成可用积分")
        self.assertEqual(totals["refunded_expired"], 6)
        self.assertEqual(totals["refunded_valid"], 0)
        self.assertEqual(totals["expired"], 10)
        self.assertTrue(report["conservation"]["ok"])

    def test_fefo_consumption_before_expiry(self):
        ledger = Ledger()
        ledger.earn("b1", 5, 10, time=0)
        ledger.earn("b2", 8, 6, time=0)
        allocations = ledger.consume("c1", 9, time=2)
        self.assertEqual(
            [(a.batch_id, a.amount) for a in allocations],
            [("b2", 8), ("b1", 1)],
        )

    def test_fefo_tie_breaks_by_batch_id(self):
        ledger = Ledger()
        ledger.earn("bz", 5, 6, time=0)
        ledger.earn("ba", 5, 6, time=0)
        allocations = ledger.consume("c1", 5, time=1)
        self.assertEqual(allocations[0].batch_id, "ba")

    def test_refund_before_expiry_restores_original_expiry(self):
        ledger = Ledger()
        ledger.earn("b1", 10, 5, time=0)
        ledger.consume("c1", 6, time=2)
        result = ledger.refund("c1", 6, time=3, refund_id="r1")
        self.assertEqual(result, {"valid": 6, "expired": 0})
        report = ledger.report(now=3)
        self.assertEqual(report["totals"]["available"], 10)
        # 有效期不变：t=5 时退款回到本批次的 6 分同样到期。
        report5 = ledger.report(now=5)
        self.assertEqual(report5["totals"]["available"], 0)
        self.assertEqual(report5["totals"]["expired"], 10)

    def test_partial_refund_split_valid_then_expired(self):
        ledger = Ledger()
        ledger.earn("b1", 10, 5, time=0)
        ledger.consume("c1", 6, time=2)
        first = ledger.refund("c1", 2, time=4, refund_id="r1")
        second = ledger.refund("c1", 4, time=6, refund_id="r2")
        self.assertEqual(first, {"valid": 2, "expired": 0})
        self.assertEqual(second, {"valid": 0, "expired": 4})
        report = ledger.report(now=6)
        totals = report["totals"]
        # 4 分从未消费、到期；2 分退回后到期；4 分到期后退回。
        self.assertEqual(totals["available"], 0)
        self.assertEqual(totals["consumed"], 0)
        self.assertEqual(totals["expired"], 10)
        self.assertEqual(totals["refunded_valid"], 2)
        self.assertEqual(totals["refunded_expired"], 4)

    def test_duplicate_refund_is_idempotent(self):
        ledger, _ = self.build()
        again = ledger.refund("c1", 6, time=6, refund_id="r1")
        once_more = ledger.refund("c1", 6, time=7, refund_id="r1")
        self.assertEqual(again, {"valid": 0, "expired": 0})
        self.assertEqual(once_more, {"valid": 0, "expired": 0})
        report = ledger.report(now=7)
        self.assertEqual(report["totals"]["refunded_expired"], 6)
        self.assertEqual(any("重复" in w for w in report["warnings"]), True)

    def test_default_refund_id_dedup_same_amount(self):
        ledger = Ledger()
        ledger.earn("b1", 10, 10, time=0)
        ledger.consume("c1", 6, time=1)
        first = ledger.refund("c1", 6, time=2)
        second = ledger.refund("c1", 6, time=2)
        self.assertEqual(first, {"valid": 6, "expired": 0})
        self.assertEqual(second, {"valid": 0, "expired": 0})
        report = ledger.report(now=2)
        self.assertEqual(report["totals"]["available"], 10)

    def test_over_refund_rejected(self):
        ledger = Ledger()
        ledger.earn("b1", 10, 10, time=0)
        ledger.consume("c1", 6, time=1)
        ledger.refund("c1", 5, time=2, refund_id="r1")
        with self.assertRaisesRegex(LedgerError, "超退"):
            ledger.refund("c1", 2, time=2, refund_id="r2")

    def test_refund_unknown_consumption_rejected(self):
        ledger = Ledger()
        with self.assertRaisesRegex(LedgerError, "不存在"):
            ledger.refund("nope", 1, time=1, refund_id="r1")

    def test_consume_insufficient_balance_all_or_nothing(self):
        ledger = Ledger()
        ledger.earn("b1", 3, 10, time=0)
        with self.assertRaisesRegex(LedgerError, "余额不足"):
            ledger.consume("c1", 5, time=1)
        report = ledger.report(now=1)
        self.assertEqual(report["totals"]["available"], 3)
        self.assertEqual(report["totals"]["consumed"], 0)

    def test_consume_after_expiry_not_available(self):
        ledger = Ledger()
        ledger.earn("b1", 3, 5, time=0)
        with self.assertRaisesRegex(LedgerError, "余额不足"):
            ledger.consume("c1", 1, time=5)
        report = ledger.report(now=5)
        self.assertEqual(report["totals"]["expired"], 3)

    def test_conservation_in_multi_batch_scenario(self):
        ledger = Ledger()
        ledger.earn("b1", 5, 10, time=0)
        ledger.earn("b2", 8, 6, time=0)
        ledger.earn("b3", 3, 6, time=0)
        ledger.consume("c1", 9, time=2)
        ledger.refund("c1", 4, time=3, refund_id="r1")
        ledger.refund("c1", 4, time=3, refund_id="r1")  # 重复
        ledger.refund("c1", 3, time=8, refund_id="r2")
        report = ledger.report(now=10)
        totals = report["totals"]
        self.assertEqual(totals["earned"], 16)
        self.assertEqual(totals["available"], 0)
        self.assertEqual(totals["consumed"], 2)
        self.assertEqual(totals["expired"], 14)
        self.assertEqual(totals["refunded_valid"], 4)
        self.assertEqual(totals["refunded_expired"], 3)
        self.assertTrue(report["conservation"][
            "available_plus_consumed_plus_expired_equals_earned"])
        for batch in report["batches"]:
            self.assertEqual(
                batch["available"] + batch["consumed"] + batch["expired"],
                batch["amount"],
                batch["batch_id"],
            )

    def test_batch_level_conservation_after_mixed_refunds(self):
        ledger = Ledger()
        ledger.earn("early", 4, 5, time=0)
        ledger.earn("late", 6, 20, time=0)
        ledger.consume("c1", 7, time=1)   # early 4 + late 3
        # t=3 早批次未到期：FEFO 先退 early 2 分，回 early 可用。
        ledger.refund("c1", 2, time=3, refund_id="r1")
        # t=6：early 已到期（其中 2 已退可用、2 仍消费）。
        #   再退 3 分：early 剩 2 分 -> 过期退回；late 1 分 -> 有效退回。
        ledger.refund("c1", 3, time=6, refund_id="r2")
        report = ledger.report(now=6)
        early = next(b for b in report["batches"]
                     if b["batch_id"] == "early")
        late = next(b for b in report["batches"]
                    if b["batch_id"] == "late")
        self.assertEqual(early["available"], 0)
        self.assertEqual(early["consumed"], 0)
        self.assertEqual(early["expired"], 4)
        self.assertEqual(early["refunded_valid"], 2)
        self.assertEqual(early["refunded_expired"], 2)
        self.assertEqual(late["available"], 4)
        self.assertEqual(late["consumed"], 2)
        self.assertEqual(late["refunded_valid"], 1)
        self.assertTrue(report["conservation"]["ok"])


class CliTest(unittest.TestCase):
    def test_demo_command_acceptance(self):
        proc = subprocess.run(
            [sys.executable, "-m", "point_ledger", "demo"],
            cwd=REPO_ROOT, capture_output=True, text=True, check=True,
        )
        report = json.loads(proc.stdout)
        self.assertEqual(report["totals"]["available"], 0)
        self.assertEqual(report["totals"]["refunded_expired"], 6)

    def test_run_jsonl_file(self):
        proc = subprocess.run(
            [sys.executable, "-m", "point_ledger", "run",
             str(REPO_ROOT / "examples" / "acceptance.jsonl")],
            cwd=REPO_ROOT, capture_output=True, text=True, check=True,
        )
        report = json.loads(proc.stdout)
        self.assertEqual(report["totals"]["available"], 0)
        self.assertEqual(report["totals"]["expired"], 10)

    def test_run_stdin_json_array(self):
        events = json.dumps([
            {"op": "earn", "batch_id": "b1", "amount": 10,
             "expiry": 5, "time": 0},
            {"op": "consume", "consumption_id": "c1", "amount": 6,
             "time": 4},
            {"op": "refund", "consumption_id": "c1", "amount": 6,
             "time": 6, "refund_id": "r1"},
        ])
        proc = subprocess.run(
            [sys.executable, "-m", "point_ledger", "run", "-"],
            input=events, cwd=REPO_ROOT, capture_output=True, text=True,
            check=True,
        )
        self.assertEqual(json.loads(proc.stdout)["totals"]["available"], 0)

    def test_over_refund_exit_code_is_one(self):
        bad = json.dumps([
            {"op": "earn", "batch_id": "b1", "amount": 3, "expiry": 9,
             "time": 0},
            {"op": "consume", "consumption_id": "c1", "amount": 3,
             "time": 1},
            {"op": "refund", "consumption_id": "c1", "amount": 4,
             "time": 2, "refund_id": "r1"},
        ])
        proc = subprocess.run(
            [sys.executable, "-m", "point_ledger", "run", "-"],
            input=bad, cwd=REPO_ROOT, capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 1)
        self.assertIn("超退", proc.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
