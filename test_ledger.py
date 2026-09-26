"""分摊舍入可逆账本的 unittest 测试（全部使用合成数据）。"""

import io
import json
import unittest

from ledger import Ledger, LedgerError, allocate_discount, main, run_commands


class TestAllocation(unittest.TestCase):
    def test_acceptance_boundary_two_one_cent_lines(self):
        # 验收边界：两行各 1 分，总折扣 1 分，ID 字典序优先 -> a 得折扣
        shares = allocate_discount({"a": 1, "b": 1}, 1)
        self.assertEqual(shares, {"a": 1, "b": 0})

    def test_floor_then_largest_remainder(self):
        # 100/200/300 分摊 100：地板 16/33/50，余数 400>200>0，尾差给 a
        shares = allocate_discount({"a": 100, "b": 200, "c": 300}, 100)
        self.assertEqual(shares, {"a": 17, "b": 33, "c": 50})
        self.assertEqual(sum(shares.values()), 100)

    def test_remainder_tie_broken_by_line_id(self):
        # 三等分余数相同，字典序小者先得
        shares = allocate_discount({"b": 1, "c": 1, "a": 1}, 2)
        self.assertEqual(shares, {"a": 1, "b": 1, "c": 0})

    def test_conservation_for_sweep(self):
        for amounts in ({"a": 1, "b": 1}, {"x": 7, "y": 13, "z": 29}, {"only": 5}):
            total = sum(amounts.values())
            for d in range(total + 1):
                shares = allocate_discount(amounts, d)
                self.assertEqual(sum(shares.values()), d)
                for lid, amt in amounts.items():
                    floor = amt * d // total
                    self.assertIn(shares[lid], (floor, floor + 1))

    def test_reject_over_discount(self):
        with self.assertRaises(LedgerError):
            allocate_discount({"a": 1}, 2)


class TestRefundSemantics(unittest.TestCase):
    def setUp(self):
        self.ledger = Ledger()
        # 验收场景：a、b 各 1 分，折扣 1 分 -> a 实付 0，b 实付 1
        self.ledger.create_order(
            "o1",
            [
                {"line_id": "a", "unit_price": 1, "quantity": 1},
                {"line_id": "b", "unit_price": 1, "quantity": 1},
            ],
            1,
        )

    def test_allocation_boundary(self):
        order = self.ledger.orders["o1"]
        self.assertEqual(order.lines["a"].discount, 1)
        self.assertEqual(order.lines["b"].discount, 0)
        self.assertEqual(order.lines["a"].paid, 0)
        self.assertEqual(order.lines["b"].paid, 1)

    def test_total_refund_never_exceeds_paid_any_order(self):
        for first, second in (("a", "b"), ("b", "a")):
            ledger = Ledger()
            ledger.create_order(
                "o",
                [
                    {"line_id": "a", "unit_price": 1, "quantity": 1},
                    {"line_id": "b", "unit_price": 1, "quantity": 1},
                ],
                1,
            )
            r1 = ledger.refund(f"r-{first}", "o", first, 1)
            r2 = ledger.refund(f"r-{second}", "o", second, 1)
            self.assertEqual(r1["status"], "ok")
            self.assertEqual(r2["status"], "ok")
            total = r1["amount"] + r2["amount"]
            self.assertLessEqual(total, 1, "总退款不得超过实付 1 分")
            ev = ledger.orders["o"].evidence()
            self.assertTrue(all(ev["checks"].values()))

    def test_duplicate_refund_id_is_idempotent(self):
        r1 = self.ledger.refund("r1", "o1", "b", 1)
        before = self.ledger.orders["o1"].total_refunded
        r2 = self.ledger.refund("r1", "o1", "b", 1)
        after = self.ledger.orders["o1"].total_refunded
        self.assertEqual(before, after, "第二次相同退款ID不得变更余额")
        self.assertTrue(r2["idempotent_replay"])
        self.assertEqual(r1["amount"], r2["amount"])
        self.assertEqual(after, 1)

    def test_over_quantity_rejected_atomically(self):
        before = self.ledger.orders["o1"].evidence()
        r = self.ledger.refund("r-over", "o1", "b", 2)
        self.assertEqual(r["status"], "rejected")
        self.assertEqual(r["reason"], "over_quantity")
        after = self.ledger.orders["o1"].evidence()
        self.assertEqual(before, after, "超量退款必须原子拒绝、无状态变更")
        # 拒绝结果同样幂等
        r2 = self.ledger.refund("r-over", "o1", "b", 2)
        self.assertEqual(r2["status"], "rejected")
        self.assertTrue(r2["idempotent_replay"])

    def test_partial_quantity_refund_uses_unit_ordinals(self):
        ledger = Ledger()
        # 单行 3 件、单价 10、折扣 2 -> 单位折扣 [1,1,0]，实付 [9,9,10]
        ledger.create_order("o2", [{"line_id": "L", "unit_price": 10, "quantity": 3}], 2)
        r1 = ledger.refund("u1", "o2", "L", 1)
        self.assertEqual(r1["units"], [{"ordinal": 0, "net": 9}])
        r2 = ledger.refund("u2", "o2", "L", 2)
        self.assertEqual(
            r2["units"], [{"ordinal": 1, "net": 9}, {"ordinal": 2, "net": 10}]
        )
        self.assertEqual(r1["amount"] + r2["amount"], 28)  # 实付总额 30-2
        r3 = ledger.refund("u3", "o2", "L", 1)
        self.assertEqual(r3["status"], "rejected")

    def test_no_reallocation_across_lines(self):
        ledger = Ledger()
        ledger.create_order(
            "o3",
            [
                {"line_id": "a", "unit_price": 100, "quantity": 1},
                {"line_id": "b", "unit_price": 200, "quantity": 1},
                {"line_id": "c", "unit_price": 300, "quantity": 1},
            ],
            100,
        )
        before = {lid: ln.discount for lid, ln in ledger.orders["o3"].lines.items()}
        ledger.refund("r1", "o3", "c", 1)  # 退掉整行 c
        after = {lid: ln.discount for lid, ln in ledger.orders["o3"].lines.items()}
        self.assertEqual(before, after, "分批退货禁止对剩余行重新分摊")
        # 行 c 已退金额 = 其实付 250，其余行余额不变
        ev = ledger.orders["o3"].evidence()
        self.assertEqual(ev["lines"]["c"]["refunded"], 250)
        self.assertEqual(ev["lines"]["a"]["remaining"], 83)
        self.assertEqual(ev["lines"]["b"]["remaining"], 167)


class TestCli(unittest.TestCase):
    def test_cli_end_to_end_stdin(self):
        commands = {
            "commands": [
                {
                    "op": "create_order",
                    "order_id": "o1",
                    "lines": [
                        {"line_id": "a", "unit_price": 1, "quantity": 1},
                        {"line_id": "b", "unit_price": 1, "quantity": 1},
                    ],
                    "discount": 1,
                },
                {"op": "refund", "refund_id": "r1", "order_id": "o1",
                 "line_id": "b", "quantity": 1},
                {"op": "refund", "refund_id": "r1", "order_id": "o1",
                 "line_id": "b", "quantity": 1},
                {"op": "snapshot", "order_id": "o1"},
            ]
        }
        import sys
        from unittest.mock import patch

        stdin = io.StringIO(json.dumps(commands))
        stdout = io.StringIO()
        with patch.object(sys, "stdin", stdin), patch.object(sys, "stdout", stdout):
            rc = main([])
        self.assertEqual(rc, 0)
        out = json.loads(stdout.getvalue())
        results = out["results"]
        self.assertEqual(results[0]["allocation"], {"a": 1, "b": 0})
        self.assertEqual(results[1]["amount"], 1)
        self.assertTrue(results[2]["idempotent_replay"])
        checks = results[3]["evidence"]["checks"]
        self.assertTrue(all(checks.values()))
        self.assertEqual(results[3]["evidence"]["total_refunded"], 1)

    def test_error_op_reported_not_raised(self):
        results = run_commands(Ledger(), [{"op": "bogus"}])
        self.assertEqual(results[0]["status"], "error")


if __name__ == "__main__":
    unittest.main()
