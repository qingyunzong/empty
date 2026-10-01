import json
import unittest

from lpsynth import HistoryError, load_history, solve


def make_ops(ops):
    return load_history(json.dumps({"operations": ops}))


def history_a():
    # Two pushes and one pop; hand-computed reference intervals:
    # valid orders: (p1,p2,p3) and (p2,p3,p1).
    #   order p1,p2,p3: earliest (0,1,2), latest (1,2,8)
    #   order p2,p3,p1: earliest (1,2,8), latest (2,8,10)
    # union => p1 [0,10], p2 [1,2], p3 [2,8]
    return make_ops([
        {"id": "p1", "op": "push", "arg": 1, "call": 0, "return": 10},
        {"id": "p2", "op": "push", "arg": 2, "call": 1, "return": 9},
        {"id": "p3", "op": "pop", "call": 2, "return": 8, "result": 2},
    ])


class TestAcceptanceA(unittest.TestCase):
    def test_intervals_match_hand_computed_reference(self):
        result = solve(history_a(), 5000)
        self.assertEqual(result.status, "OK")
        self.assertEqual(
            result.intervals,
            {"p1": [0, 10], "p2": [1, 2], "p3": [2, 8]},
        )
        self.assertIsNone(result.conflict)


class TestAcceptanceB(unittest.TestCase):
    def test_wrong_pop_order_is_infeasible(self):
        # Sequential history: push 1, push 2, then pop returns 1,
        # but LIFO forces the pop to return 2.
        ops = make_ops([
            {"id": "p1", "op": "push", "arg": 1, "call": 0, "return": 1},
            {"id": "p2", "op": "push", "arg": 2, "call": 2, "return": 3},
            {"id": "p3", "op": "pop", "call": 4, "return": 8, "result": 1},
        ])
        result = solve(ops, 5000)
        self.assertEqual(result.status, "INFEASIBLE")
        self.assertIsNone(result.intervals)
        # Minimal infeasible core: the pop alone cannot return 1.
        self.assertEqual(result.conflict, ["p3"])

    def test_conflict_ops_come_from_history(self):
        ops = make_ops([
            {"id": "a", "op": "push", "arg": "x", "call": 0, "return": 1},
            {"id": "b", "op": "push", "arg": "y", "call": 2, "return": 3},
            {"id": "c", "op": "pop", "call": 4, "return": 5, "result": "x"},
            {"id": "d", "op": "pop", "call": 6, "return": 7, "result": "y"},
        ])
        result = solve(ops, 5000)
        self.assertEqual(result.status, "INFEASIBLE")
        self.assertTrue(result.conflict)
        self.assertTrue(set(result.conflict) <= {"a", "b", "c", "d"})


class TestAcceptanceC(unittest.TestCase):
    def test_pending_push_makes_status_unknown_not_infeasible(self):
        # The pop returns 5 but no completed push of 5 exists; a pending
        # push of 5 could explain it, so the verdict must be UNKNOWN.
        ops = make_ops([
            {"id": "p1", "op": "push", "arg": 5, "call": 0},
            {"id": "p2", "op": "pop", "call": 1, "return": 4, "result": 5},
        ])
        result = solve(ops, 5000)
        self.assertEqual(result.status, "UNKNOWN")
        self.assertIsNone(result.conflict)

    def test_pending_does_not_break_feasible_completed_history(self):
        ops = make_ops([
            {"id": "p1", "op": "push", "arg": 1, "call": 0, "return": 5},
            {"id": "p2", "op": "pop", "call": 6, "return": 7, "result": 1},
            {"id": "p3", "op": "push", "arg": 2, "call": 3},
        ])
        result = solve(ops, 5000)
        self.assertEqual(result.status, "OK")
        self.assertEqual(result.intervals["p1"], [0, 5])
        self.assertEqual(result.intervals["p2"], [6, 7])

    def test_unexplainable_pending_still_infeasible(self):
        # Pop returns 9; the only pending op pushes 5, so nothing can
        # explain the result: genuinely INFEASIBLE.
        ops = make_ops([
            {"id": "p1", "op": "push", "arg": 5, "call": 0},
            {"id": "p2", "op": "pop", "call": 1, "return": 4, "result": 9},
        ])
        result = solve(ops, 5000)
        self.assertEqual(result.status, "INFEASIBLE")
        self.assertEqual(result.conflict, ["p2"])


class TestAcceptanceD(unittest.TestCase):
    def test_zero_timeout_returns_timeout_with_tightened_intervals(self):
        result = solve(history_a(), 0)
        self.assertEqual(result.status, "TIMEOUT")
        # Intervals tightened by propagation only (domain bounds here).
        self.assertEqual(
            result.intervals,
            {"p1": [0, 10], "p2": [1, 9], "p3": [2, 8]},
        )
        self.assertIsNone(result.conflict)


class TestStackSemantics(unittest.TestCase):
    def test_empty_pop_returns_empty(self):
        ops = make_ops([
            {"id": "p1", "op": "pop", "call": 0, "return": 1, "result": "EMPTY"},
        ])
        result = solve(ops, 5000)
        self.assertEqual(result.status, "OK")
        self.assertEqual(result.intervals, {"p1": [0, 1]})

    def test_empty_pop_with_value_is_infeasible(self):
        ops = make_ops([
            {"id": "p1", "op": "pop", "call": 0, "return": 1, "result": 7},
        ])
        result = solve(ops, 5000)
        self.assertEqual(result.status, "INFEASIBLE")
        self.assertEqual(result.conflict, ["p1"])

    def test_lifo_matching(self):
        ops = make_ops([
            {"id": "p1", "op": "push", "arg": 1, "call": 0, "return": 1},
            {"id": "p2", "op": "push", "arg": 2, "call": 2, "return": 3},
            {"id": "p3", "op": "pop", "call": 4, "return": 5, "result": 2},
            {"id": "p4", "op": "pop", "call": 6, "return": 7, "result": 1},
        ])
        result = solve(ops, 5000)
        self.assertEqual(result.status, "OK")

    def test_empty_history(self):
        result = solve(make_ops([]), 5000)
        self.assertEqual(result.status, "OK")
        self.assertEqual(result.intervals, {})


class TestValidation(unittest.TestCase):
    def assert_invalid(self, payload):
        with self.assertRaises(HistoryError):
            load_history(payload if isinstance(payload, str) else json.dumps(payload))

    def test_not_json(self):
        self.assert_invalid("{not json")

    def test_not_object(self):
        self.assert_invalid("[1, 2]")

    def test_missing_operations(self):
        self.assert_invalid({})

    def test_bad_op_kind(self):
        self.assert_invalid({"operations": [{"id": "x", "op": "peek", "call": 0}]})

    def test_duplicate_ids(self):
        self.assert_invalid({"operations": [
            {"id": "x", "op": "push", "arg": 1, "call": 0},
            {"id": "x", "op": "push", "arg": 2, "call": 1},
        ]})

    def test_return_before_call(self):
        self.assert_invalid({"operations": [
            {"id": "x", "op": "push", "arg": 1, "call": 5, "return": 2},
        ]})

    def test_push_requires_arg(self):
        self.assert_invalid({"operations": [
            {"id": "x", "op": "push", "call": 0, "return": 1},
        ]})

    def test_completed_pop_requires_result(self):
        self.assert_invalid({"operations": [
            {"id": "x", "op": "pop", "call": 0, "return": 1},
        ]})

    def test_type_mismatch(self):
        with self.assertRaises(HistoryError):
            load_history(json.dumps({"type": "queue", "operations": []}))

    def test_bool_call_rejected(self):
        self.assert_invalid({"operations": [
            {"id": "x", "op": "push", "arg": 1, "call": True},
        ]})


if __name__ == "__main__":
    unittest.main()
