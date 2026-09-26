#!/usr/bin/env python3
"""ledger.py 的 unittest 测试。所有数据均为合成数据。"""
import json
import subprocess
import sys
import unittest

from ledger import Ledger, LedgerError, Line, allocate_discount, run, unit_discounts


def make(lines, discount, order_id="t"):
    return Ledger(order_id, [Line(**l) for l in lines], discount)


class TestAllocation(unittest.TestCase):
    def test_acceptance_two_one_cent_lines(self):
        # 验收边界: 两行各1分, 总折扣1分, ID a 优先得到折扣
        alloc = allocate_discount({"a": 1, "b": 1}, 1)
        self.assertEqual(alloc, {"a": 1, "b": 0})

    def test_floor_then_remainder_desc(self):
        # 金额 1:1:1, 折扣 2 -> 各 floor 0, 余数相等, 字典序前两行各得 1
        alloc = allocate_discount({"a": 1, "b": 1, "c": 1}, 2)
        self.assertEqual(alloc, {"a": 1, "b": 1, "c": 0})

    def test_remainder_desc_beats_lexicographic(self):
        # 金额 3:1, 折扣 1: a 得 floor(3/4)=0 余3, b 得 0 余1 -> 尾差给 a
        alloc = allocate_discount({"a": 3, "b": 1}, 1)
        self.assertEqual(alloc, {"a": 1, "b": 0})
        # 金额 1:3, 折扣 1 -> 尾差给 b (余数更大优先于字典序)
        alloc = allocate_discount({"a": 1, "b": 3}, 1)
        self.assertEqual(alloc, {"a": 0, "b": 1})

    def test_proportional_exact(self):
        alloc = allocate_discount({"a": 60, "b": 40}, 10)
        self.assertEqual(alloc, {"a": 6, "b": 4})

    def test_conservation_sum_equals_discount(self):
        alloc = allocate_discount({"x": 7, "y": 13, "z": 29}, 11)
        self.assertEqual(sum(alloc.values()), 11)

    def test_zero_discount_and_full_discount(self):
        self.assertEqual(allocate_discount({"a": 5}, 0), {"a": 0})
        self.assertEqual(allocate_discount({"a": 5, "b": 5}, 10), {"a": 5, "b": 5})

    def test_discount_exceeds_total_rejected(self):
        with self.assertRaises(LedgerError):
            allocate_discount({"a": 1}, 2)

    def test_unit_discounts_remainder_by_unit_index(self):
        # 行折扣 5 分摊到 2 个单位: [3, 2], 尾差给序号 0
        self.assertEqual(unit_discounts(5, 2), [3, 2])
        self.assertEqual(unit_discounts(0, 3), [0, 0, 0])
        self.assertEqual(sum(unit_discounts(7, 3)), 7)


class TestRefunds(unittest.TestCase):
    def setUp(self):
        # 验收场景: a=1分, b=1分, 折扣1分 -> a 实付0, b 实付1
        self.ledger = make(
            [{"line_id": "a", "qty": 1, "unit_price": 1},
             {"line_id": "b", "qty": 1, "unit_price": 1}], 1)

    def test_acceptance_paid_amounts(self):
        self.assertEqual(self.ledger.line_discount, {"a": 1, "b": 0})

    def test_total_refund_never_exceeds_paid_any_order(self):
        # 顺序 a 后 b
        r1 = self.ledger.refund("r1", "a", 1)
        r2 = self.ledger.refund("r2", "b", 1)
        self.assertEqual(r1["amount"], 0)
        self.assertEqual(r2["amount"], 1)
        ev = self.ledger.evidence()
        self.assertEqual(ev["total_refunded"], 1)
        self.assertLessEqual(ev["total_refunded"], ev["total_paid"])
        self.assertTrue(ev["all_checks_pass"])
        # 顺序 b 后 a, 结果一致
        other = make([{"line_id": "a", "qty": 1, "unit_price": 1},
                      {"line_id": "b", "qty": 1, "unit_price": 1}], 1)
        other.refund("r1", "b", 1)
        other.refund("r2", "a", 1)
        self.assertEqual(other.evidence()["total_refunded"], 1)

    def test_duplicate_refund_idempotent(self):
        first = self.ledger.refund("r1", "b", 1)
        second = self.ledger.refund("r1", "b", 1)
        self.assertEqual(first["status"], "applied")
        self.assertEqual(second["status"], "duplicate")
        self.assertEqual(second["amount"], first["amount"])
        ev = self.ledger.evidence()
        self.assertEqual(ev["total_refunded"], 1)  # 余额未被第二次变更

    def test_over_quantity_atomically_rejected(self):
        before = self.ledger.evidence()
        r = self.ledger.refund("r1", "a", 2)
        self.assertEqual(r["status"], "rejected")
        self.assertEqual(r["reason"], "exceeds_quantity")
        self.assertEqual(self.ledger.evidence(), before)  # 状态完全未变

    def test_cumulative_over_quantity_rejected(self):
        led = make([{"line_id": "a", "qty": 2, "unit_price": 10}], 3)
        self.assertEqual(led.refund("r1", "a", 1)["status"], "applied")
        self.assertEqual(led.refund("r2", "a", 1)["status"], "applied")
        r = led.refund("r3", "a", 1)
        self.assertEqual(r["status"], "rejected")
        self.assertEqual(r["reason"], "exceeds_quantity")

    def test_partial_quantity_per_unit_remainder(self):
        # 行折扣 5 分摊到 2 单位 -> [3,2]; 先退序号0(撤销3), 再退序号1(撤销2)
        led = make([{"line_id": "a", "qty": 2, "unit_price": 10}], 5)
        r1 = led.refund("r1", "a", 1)
        self.assertEqual((r1["amount"], r1["revoked_discount"]), (7, 3))
        r2 = led.refund("r2", "a", 1)
        self.assertEqual((r2["amount"], r2["revoked_discount"]), (8, 2))
        ev = led.evidence()
        self.assertEqual(ev["total_refunded"], 15)  # == 实付 20-5
        self.assertTrue(ev["all_checks_pass"])

    def test_no_reallocation_after_refund(self):
        led = make([{"line_id": "a", "qty": 1, "unit_price": 60},
                    {"line_id": "b", "qty": 1, "unit_price": 40}], 10)
        alloc_before = dict(led.line_discount)
        led.refund("r1", "a", 1)
        self.assertEqual(led.line_discount, alloc_before)  # 剩余行不重新分摊

    def test_unknown_line_and_invalid_qty_rejected(self):
        r = self.ledger.refund("r1", "zzz", 1)
        self.assertEqual((r["status"], r["reason"]), ("rejected", "unknown_line"))
        r = self.ledger.refund("r2", "a", 0)
        self.assertEqual((r["status"], r["reason"]), ("rejected", "invalid_qty"))
        self.assertEqual(self.ledger.evidence()["total_refunded"], 0)

    def test_duplicate_id_wins_even_with_different_payload(self):
        self.ledger.refund("r1", "b", 1)
        r = self.ledger.refund("r1", "a", 1)  # 同ID不同内容 -> 仍幂等返回首次结果
        self.assertEqual(r["status"], "duplicate")
        self.assertEqual(r["line_id"], "b")
        self.assertEqual(self.ledger.evidence()["total_refunded"], 1)


class TestEvidenceAndCli(unittest.TestCase):
    def test_evidence_structure_and_checks(self):
        spec = {
            "order": {"order_id": "o1", "discount": 7, "lines": [
                {"line_id": "a", "qty": 3, "unit_price": 10},
                {"line_id": "b", "qty": 2, "unit_price": 5}]},
            "refunds": [{"refund_id": "r1", "line_id": "a", "qty": 2}],
        }
        out = run(spec)
        ev = out["evidence"]
        self.assertTrue(ev["all_checks_pass"])
        self.assertEqual(ev["total_discount"], 7)
        self.assertEqual(ev["total_paid"], 40 - 7)
        self.assertEqual(ev["total_remaining"],
                         ev["total_paid"] - ev["total_refunded"])

    def test_cli_demo_acceptance(self):
        proc = subprocess.run([sys.executable, "ledger.py", "--demo"],
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        alloc = {l["line_id"]: l["allocated_discount"]
                 for l in out["allocation"]["lines"]}
        self.assertEqual(alloc, {"a": 1, "b": 0})
        statuses = [r["status"] for r in out["refunds"]]
        self.assertEqual(statuses, ["applied", "applied", "duplicate", "rejected"])
        self.assertEqual(out["evidence"]["total_refunded"], 1)
        self.assertTrue(out["evidence"]["all_checks_pass"])

    def test_cli_stdin_roundtrip(self):
        spec = {"order": {"order_id": "o2", "discount": 1, "lines": [
                    {"line_id": "a", "qty": 1, "unit_price": 1},
                    {"line_id": "b", "qty": 1, "unit_price": 1}]},
                "refunds": [{"refund_id": "r1", "line_id": "b", "qty": 1}]}
        proc = subprocess.run([sys.executable, "ledger.py"],
                              input=json.dumps(spec),
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["refunds"][0]["amount"], 1)
        self.assertTrue(out["evidence"]["all_checks_pass"])


if __name__ == "__main__":
    unittest.main()
