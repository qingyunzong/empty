import io
import itertools
import json
import unittest
from contextlib import redirect_stderr, redirect_stdout

from inventory_repair.cli import main as cli_main
from inventory_repair.planner import (
    DuplicateEventConflict,
    InvalidEventError,
    InventoryPlanner,
    analyze_events,
)


def brute_force_optimal(deltas):
    """穷举所有可行补货方案，返回 (total, count, slots_tuple)。

    slots_tuple 为补货位置（1-based）的升序元组，用于表达“最晚位置序列”。
    比较顺序与题目一致：总量最小 -> 次数最少 -> 位置序列字典序最大。
    仅用于合成小样本（n<=4, |delta|<=2）下独立校验算法。
    """
    n = len(deltas)
    prefixes = list(itertools.accumulate(deltas))
    L = max(0, -min(prefixes, default=0))

    best = None  # (total, count, slots_tuple)

    def feasible(total, counts):
        running_add = 0
        for i in range(n):
            running_add += counts[i + 1]
            if prefixes[i] + running_add < 0:
                return False
        return True

    def rec(slot, remaining, counts):
        nonlocal best
        if slot > n:
            if remaining == 0 and feasible(L, counts):  # 总量必须恰为 L
                count = sum(1 for x in range(1, n + 1) if counts[x] > 0)
                cand_slots = tuple(x for x in range(1, n + 1) if counts[x] > 0)
                if best is None:
                    best = (L, count, cand_slots)
                elif count < best[1] or (count == best[1] and cand_slots > best[2]):
                    # 总量固定为 L：次数越少越优；次数相同则位置序列越晚（字典序越大）越优
                    best = (L, count, cand_slots)
            return
        # 该槽位补 0..remaining
        for amount in range(remaining + 1):
            counts[slot] = amount
            rec(slot + 1, remaining - amount, counts)
        counts[slot] = 0

    if L == 0:
        return (0, 0, ())
    rec(1, L, {})
    assert best is not None
    return best


class PlannerAcceptanceTest(unittest.TestCase):
    def test_acceptance_negative3_plus2_negative4(self):
        result = analyze_events([
            {"id": "a", "seq": 1, "delta": -3},
            {"id": "b", "seq": 2, "delta": 2},
            {"id": "c", "seq": 3, "delta": -4},
        ])
        # 前缀和：-3, -1, -5
        self.assertEqual(result["lower_bound"], 5)
        self.assertEqual(result["replenishment"]["total"], 5)
        self.assertEqual(result["replenishment"]["count"], 1)
        self.assertEqual(result["replenishment"]["insertions"][0]["slot"], 1)
        self.assertEqual(result["earliest_negative"]["slot"], 1)
        self.assertEqual(result["earliest_negative"]["balance"], -3)
        # 修复后全程非负
        self.assertTrue(all(row["repaired_balance"] >= 0 for row in result["order"]))
        self.assertFalse(result["feasible_without_replenishment"])

    def test_zero_replenishment_infeasible_here(self):
        result = analyze_events([
            {"id": "a", "seq": 1, "delta": -3},
        ])
        self.assertGreater(result["lower_bound"], 0)
        self.assertFalse(result["feasible_without_replenishment"])

    def test_zero_replenishment_when_all_nonnegative(self):
        result = analyze_events([
            {"id": "a", "seq": 1, "delta": 3},
            {"id": "b", "seq": 2, "delta": -2},
        ])
        self.assertEqual(result["lower_bound"], 0)
        self.assertEqual(result["replenishment"]["total"], 0)
        self.assertEqual(result["replenishment"]["count"], 0)
        self.assertIsNone(result["earliest_negative"])
        self.assertTrue(result["feasible_without_replenishment"])


class LateEventTest(unittest.TestCase):
    def test_late_event_insertion_changes_rebuild(self):
        # 基线：+5（先到），-4（后到的迟到事件插在中间），最后 -2
        base = [
            {"id": "in1", "seq": 1, "delta": 5},
            {"id": "out2", "seq": 3, "delta": -2},
        ]
        result = analyze_events(base)
        self.assertEqual(result["lower_bound"], 0)

        result = analyze_events(base, late_events=[
            {"id": "late1", "seq": 2, "delta": -4},
        ])
        # 重排后：5 -> 1 -> -1，最早负库存在槽位 3
        self.assertEqual(result["earliest_negative"]["slot"], 3)
        self.assertEqual(result["earliest_negative"]["balance"], -1)
        self.assertEqual(result["lower_bound"], 1)
        # 最晚单次补货位置是槽位 3（最早负库存），而不是第一个出库事件槽位 2
        insertion = result["replenishment"]["insertions"][0]
        self.assertEqual(insertion["slot"], 3)
        self.assertEqual(insertion["amount"], 1)
        self.assertTrue(all(row["repaired_balance"] >= 0 for row in result["order"]))

    def test_duplicate_identical_is_idempotent(self):
        planner = InventoryPlanner()
        self.assertTrue(planner.add_event({"id": "x", "seq": 1, "delta": 2}))
        self.assertFalse(planner.add_event({"id": "x", "seq": 1, "delta": 2}))
        self.assertEqual(planner.analyze()["event_count"], 1)

    def test_duplicate_id_changed_delta_rejected(self):
        planner = InventoryPlanner([{"id": "x", "seq": 1, "delta": 2}])
        with self.assertRaises(DuplicateEventConflict):
            planner.add_event({"id": "x", "seq": 1, "delta": 3})

    def test_duplicate_id_changed_seq_rejected(self):
        planner = InventoryPlanner([{"id": "x", "seq": 1, "delta": 2}])
        with self.assertRaises(DuplicateEventConflict):
            planner.add_event({"id": "x", "seq": 2, "delta": 2})

    def test_late_duplicate_conflict_in_helper(self):
        with self.assertRaises(DuplicateEventConflict):
            analyze_events(
                [{"id": "x", "seq": 1, "delta": 2}],
                late_events=[{"id": "x", "seq": 1, "delta": -9}],
            )


class ValidationTest(unittest.TestCase):
    def test_bad_types_rejected(self):
        with self.assertRaises(InvalidEventError):
            InventoryPlanner([{"id": "x", "seq": 1, "delta": True}])
        with self.assertRaises(InvalidEventError):
            InventoryPlanner([{"id": "x", "seq": "1", "delta": 1}])
        with self.assertRaises(InvalidEventError):
            InventoryPlanner([{"seq": 1, "delta": 1}])
        with self.assertRaises(InvalidEventError):
            InventoryPlanner([{"id": "", "seq": 1, "delta": 1}])


class BruteForceOptimalityTest(unittest.TestCase):
    """对合成小样本做穷举，独立确认总量/次数/最晚位置均最优。"""

    CASES = [
        [-3, 2, -4],
        [5, -4, -2],
        [1, -3],
        [-1, -1, 3],
        [2, -5, 2],
        [0, 2, -3],
        [-2, 2],
        [1, 1, -3, 1],
        [-1, 3, -4, 2],
    ]

    def test_matches_brute_force(self):
        for deltas in self.CASES:
            with self.subTest(deltas=deltas):
                events = [
                    {"id": f"e{i}", "seq": i, "delta": value}
                    for i, value in enumerate(deltas)
                ]
                result = InventoryPlanner(events).analyze()

                bf_total, bf_count, bf_slots = brute_force_optimal(deltas)

                self.assertEqual(result["replenishment"]["total"], bf_total)
                self.assertEqual(result["replenishment"]["count"], bf_count)
                got_slots = tuple(
                    item["slot"] for item in result["replenishment"]["insertions"]
                )
                self.assertEqual(got_slots, bf_slots)
                self.assertEqual(result["lower_bound"], bf_total)
                self.assertTrue(
                    all(row["repaired_balance"] >= 0 for row in result["order"])
                )

    def test_exhaustive_small_deltas(self):
        # 枚举所有长度 1..3、delta in {-2,-1,0,1,2} 的序列（合成数据）。
        for n in range(1, 4):
            for deltas in itertools.product(range(-2, 3), repeat=n):
                events = [
                    {"id": f"e{i}", "seq": i, "delta": value}
                    for i, value in enumerate(deltas)
                ]
                result = InventoryPlanner(events).analyze()
                bf_total, bf_count, bf_slots = brute_force_optimal(list(deltas))
                self.assertEqual(result["replenishment"]["total"], bf_total, deltas)
                self.assertEqual(result["replenishment"]["count"], bf_count, deltas)
                got_slots = tuple(
                    item["slot"]
                    for item in result["replenishment"]["insertions"]
                )
                self.assertEqual(got_slots, bf_slots, deltas)


class CliTest(unittest.TestCase):
    def test_cli_acceptance(self):
        payload = json.dumps({
            "events": [
                {"id": "c", "seq": 3, "delta": -4},
                {"id": "a", "seq": 1, "delta": -3},
            ],
            "late_events": [
                {"id": "b", "seq": 2, "delta": 2},
            ],
        })
        out = io.StringIO()
        with redirect_stdout(out):
            code = cli_main(["--json", payload])
        self.assertEqual(code, 0)
        data = json.loads(out.getvalue())
        self.assertEqual(data["replenishment"]["total"], 5)

    def test_cli_duplicate_exit_code(self):
        payload = json.dumps({
            "events": [{"id": "x", "seq": 1, "delta": 2}],
            "late_events": [{"id": "x", "seq": 1, "delta": 9}],
        })
        err = io.StringIO()
        with redirect_stderr(err):
            code = cli_main(["--json", payload])
        self.assertEqual(code, 3)
        self.assertIn("duplicate_event_conflict", err.getvalue())

    def test_cli_invalid_json_exit_code(self):
        err = io.StringIO()
        with redirect_stderr(err):
            code = cli_main(["--json", "{not json"])
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
