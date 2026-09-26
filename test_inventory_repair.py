"""inventory_repair 的 unittest 测试（全部使用合成数据）。"""
from __future__ import annotations

import itertools
import json
import random
import subprocess
import sys
import unittest
from pathlib import Path

import inventory_repair as ir


MODULE = Path(__file__).resolve().parent / "inventory_repair.py"


def plan_for(deltas: list[int]) -> ir.Plan:
    return ir.minimal_plan(deltas)


class AcceptanceExampleTest(unittest.TestCase):
    """验收边界: 事件 -3, +2, -4 需要总补货 5。"""

    def setUp(self) -> None:
        self.deltas = [-3, 2, -4]

    def test_total_replenishment_is_five(self) -> None:
        plan = plan_for(self.deltas)
        self.assertEqual(plan.total, 5)
        self.assertEqual(plan.lower_bound, 5)
        self.assertEqual(plan.count, 1)
        (op,) = plan.operations
        self.assertEqual(op.amount, 5)
        self.assertEqual(op.position, 0)  # 第一个事件前

    def test_five_before_first_event_is_feasible(self) -> None:
        # 一次在第一个事件前补 5 可行：重放前缀 2, 4, 0，全程非负。
        self.assertIsNone(
            ir.earliest_negative_position(self.deltas, [(0, 5)]))

    def test_plan_itself_is_feasible(self) -> None:
        plan = plan_for(self.deltas)
        ops = [(op.position, op.amount) for op in plan.operations]
        self.assertIsNone(ir.earliest_negative_position(self.deltas, ops))

    def test_zero_replenishment_is_infeasible(self) -> None:
        # 0 补货不可行：第一个事件后库存即 -3。
        self.assertEqual(
            ir.earliest_negative_position(self.deltas, []), 0)
        self.assertEqual(
            ir.earliest_negative_position(self.deltas), 0)

    def test_four_total_is_infeasible(self) -> None:
        # 下界严格：总量 4 无论放在哪个单一位置都不可行。
        for position in range(3):
            self.assertIsNotNone(
                ir.earliest_negative_position(self.deltas, [(position, 4)]),
                f"总量 4 放在位置 {position} 不应可行")

    def test_earliest_negative_position_after_rebuild(self) -> None:
        # 仅前两个事件时最早负位置仍是 0；去掉 -3 后不再有负库存。
        self.assertEqual(ir.earliest_negative_position([2, -4]), 1)
        self.assertIsNone(ir.earliest_negative_position([2, 4]))

    def test_cli_end_to_end(self) -> None:
        payload = {
            "events": [
                {"id": "a", "seq": 1, "delta": -3},
                {"id": "b", "seq": 2, "delta": 2},
                {"id": "c", "seq": 3, "delta": -4},
            ]
        }
        proc = subprocess.run(
            [sys.executable, str(MODULE)],
            input=json.dumps(payload), text=True,
            capture_output=True, check=True)
        report = json.loads(proc.stdout)
        self.assertEqual(report["status"], "ok")
        self.assertEqual(report["earliest_negative_position"], 0)
        self.assertEqual(report["plan"]["total"], 5)
        self.assertEqual(report["plan"]["count"], 1)
        self.assertEqual(report["plan"]["operations"],
                         [{"position": 0, "before_event_id": "a",
                           "before_event_seq": 1, "amount": 5}])


class EarliestNegativeAndRebuildTest(unittest.TestCase):
    def test_prefix_rebuild_ordering(self) -> None:
        deltas = [5, -2, -4, 3, -10]  # 前缀: 5, 3, -1, 2, -8
        self.assertEqual(ir.earliest_negative_position(deltas), 2)

    def test_all_non_negative(self) -> None:
        self.assertIsNone(ir.earliest_negative_position([1, 2, 3]))

    def test_empty_event_list(self) -> None:
        self.assertIsNone(ir.earliest_negative_position([]))
        plan = plan_for([])
        self.assertEqual((plan.total, plan.count, plan.lower_bound),
                         (0, 0, 0))

    def test_zero_delta_then_negative(self) -> None:
        self.assertEqual(ir.earliest_negative_position([0, -1]), 1)


class LateEventInsertionTest(unittest.TestCase):
    def test_late_event_inserted_by_business_seq(self) -> None:
        base = [
            {"id": "e1", "seq": 10, "delta": 2},
            {"id": "e3", "seq": 30, "delta": -5},
        ]
        # 迟到事件 seq=20，插入中间：前缀 2, -2, -7，最早负位置变为 1。
        late = [{"id": "e2", "seq": 20, "delta": -4}]
        report = ir.build_report(base, late)
        self.assertEqual([row["id"] for row in report["event_order"]],
                         ["e1", "e2", "e3"])
        self.assertEqual(report["earliest_negative_position"], 1)
        plan = report["plan"]
        # 前缀 2, -2, -7 -> 下界 7，最晚可行位置 = 首个负前缀 = 1
        self.assertEqual(plan["total"], 7)
        self.assertEqual(plan["operations"][0]["position"], 1)
        self.assertEqual(plan["operations"][0]["before_event_id"], "e2")
        self.assertIsNone(
            ir.earliest_negative_position([2, -4, -5], [(1, 7)]))

    def test_without_late_event_different_result(self) -> None:
        report = ir.build_report(
            [{"id": "e1", "seq": 10, "delta": 2},
             {"id": "e3", "seq": 30, "delta": -5}], [])
        self.assertEqual(report["earliest_negative_position"], 1)
        self.assertEqual(report["plan"]["total"], 3)

    def test_seed_order_does_not_change_rebuild(self) -> None:
        # 到达顺序无关：迟到批次与常规批次乱序，重建结果一致。
        a = ir.merge_events(
            [{"id": "x", "seq": 3, "delta": -1},
             {"id": "y", "seq": 1, "delta": 1}],
            [{"id": "z", "seq": 2, "delta": 1}])
        b = ir.merge_events(
            [{"id": "z", "seq": 2, "delta": 1},
             {"id": "x", "seq": 3, "delta": -1}],
            [{"id": "y", "seq": 1, "delta": 1}])
        self.assertEqual(a, b)
        self.assertEqual([e.event_id for e in a], ["y", "z", "x"])


class DuplicateIdTest(unittest.TestCase):
    def test_identical_duplicate_is_idempotent(self) -> None:
        records = [
            {"id": "e1", "seq": 1, "delta": -3},
            {"id": "e1", "seq": 1, "delta": -3},  # 内容一致
        ]
        events = ir.merge_events(records, [])
        self.assertEqual(len(events), 1)

    def test_changed_delta_is_rejected(self) -> None:
        with self.assertRaises(ir.DuplicateEventError):
            ir.merge_events(
                [{"id": "e1", "seq": 1, "delta": -3}],
                [{"id": "e1", "seq": 1, "delta": -4}])

    def test_changed_seq_is_rejected(self) -> None:
        with self.assertRaises(ir.DuplicateEventError):
            ir.merge_events(
                [{"id": "e1", "seq": 1, "delta": -3}],
                [{"id": "e1", "seq": 2, "delta": -3}])

    def test_cli_rejects_changed_duplicate(self) -> None:
        payload = {
            "events": [{"id": "a", "seq": 1, "delta": -3}],
            "late_events": [{"id": "a", "seq": 1, "delta": 9}],
        }
        proc = subprocess.run(
            [sys.executable, str(MODULE)],
            input=json.dumps(payload), text=True, capture_output=True)
        self.assertNotEqual(proc.returncode, 0)
        report = json.loads(proc.stdout)
        self.assertEqual(report["status"], "error")
        self.assertEqual(report["error"], "duplicate_event_id")


class PlanOptimalityPropertiesTest(unittest.TestCase):
    def test_lower_bound_matches_independent_prefixes(self) -> None:
        for deltas in ([], [3], [-3, 2, -4], [5, -9, 2, 2, -8, 20]):
            prefixes, running = [], 0
            for delta in deltas:
                running += delta
                prefixes.append(running)
            expected_lb = max([0] + [-p for p in prefixes])
            plan = plan_for(deltas)
            self.assertEqual(plan.lower_bound, expected_lb)
            self.assertEqual(plan.total, plan.lower_bound)
            if plan.witness_position is not None:
                self.assertEqual(prefixes[plan.witness_position],
                                 min(0, min(prefixes)))

    def test_plan_feasible_across_cases(self) -> None:
        cases = [[-1], [-1, -1, 5], [3, -5, 2, -2, 1],
                 [10, -20, 5, -1, -1], [0, 0, -2, 3, -3]]
        for deltas in cases:
            plan = plan_for(deltas)
            ops = [(op.position, op.amount) for op in plan.operations]
            self.assertIsNone(
                ir.earliest_negative_position(deltas, ops),
                f"方案对 {deltas} 必须可行")

    def test_zero_ops_infeasible_when_total_positive(self) -> None:
        deltas = [3, -5, 2, -2, 1]
        plan = plan_for(deltas)
        self.assertGreater(plan.total, 0)
        self.assertEqual(plan.count, 1)
        self.assertIsNotNone(ir.earliest_negative_position(deltas, []))

    def test_latest_position_is_tight(self) -> None:
        # 位置 = 首个负前缀下标；再晚一个位置（首个负前缀不被覆盖）必失败。
        cases = [[-3, 2, -4], [5, -9, 2], [2, 1, -4, 1, -6]]
        for deltas in cases:
            plan = plan_for(deltas)
            (op,) = plan.operations
            self.assertEqual(
                op.position, ir.earliest_negative_position(deltas))
            later = op.position + 1
            if later < len(deltas):
                self.assertIsNotNone(
                    ir.earliest_negative_position(
                        deltas, [(later, plan.total)]),
                    f"{deltas}: 更晚位置不应可行")

    def test_smaller_total_always_infeasible(self) -> None:
        # 任意更小总量（允许任意拆分与位置）都不可行：直接利用前缀约束。
        deltas = [4, -7, 2, -5, 1]
        plan = plan_for(deltas)
        running, prefixes = 0, []
        for delta in deltas:
            running += delta
            prefixes.append(running)
        for smaller in range(plan.total):
            self.assertLess(smaller, max(-min(prefixes), 0))


def compositions(total: int, parts: int):
    """把 total 拆成 parts 个正整数的所有有序拆分。"""
    if parts == 1:
        yield (total,)
        return
    for first in range(1, total - parts + 2):
        for rest in compositions(total - first, parts - 1):
            yield (first,) + rest


def brute_force_best(deltas: list[int]):
    """按 (总量, 次数, 位置序列词典序最晚) 穷举最优方案。

    总量从 0 向上枚举，次数从 0 向上枚举，位置可重复（同位置多次补货
    等价于合并，不影响结论）。返回 (total, count, positions_tuple)。
    """
    n = len(deltas)
    if n == 0:
        return (0, 0, ())
    for total in range(0, 25):
        max_count = min(total, n) if total else 0
        for count in range(0, max_count + 1):
            if count == 0:
                if ir.earliest_negative_position(deltas, []) is None:
                    return (0, 0, ())
                continue
            latest = None
            for positions in itertools.combinations_with_replacement(
                    range(n), count):
                for amounts in compositions(total, count):
                    ops = list(zip(positions, amounts))
                    if ir.earliest_negative_position(deltas, ops) is None:
                        if latest is None or positions > latest:
                            latest = positions
            if latest is not None:
                return (total, count, latest)
    raise AssertionError("穷举范围内未找到可行方案")  # pragma: no cover


class BruteForceComparisonTest(unittest.TestCase):
    def test_random_cases_match_exhaustive_search(self) -> None:
        rng = random.Random(20260927)
        checked = 0
        for _ in range(60):
            n = rng.randint(1, 4)
            deltas = [rng.randint(-4, 4) for _ in range(n)]
            plan = plan_for(deltas)
            bf_total, bf_count, bf_positions = brute_force_best(deltas)
            plan_positions = tuple(op.position for op in plan.operations)
            self.assertEqual(plan.total, bf_total, deltas)
            self.assertEqual(plan.count, bf_count, deltas)
            self.assertEqual(plan_positions, bf_positions, deltas)
            checked += 1
        self.assertGreaterEqual(checked, 60)

    def test_acceptance_case_matches_brute_force(self) -> None:
        self.assertEqual(brute_force_best([-3, 2, -4]),
                         (5, 1, (0,)))


if __name__ == "__main__":
    unittest.main(verbosity=2)
