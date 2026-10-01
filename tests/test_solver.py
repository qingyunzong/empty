import unittest

from lpsynth import INFEASIBLE, OK, TIMEOUT, UNKNOWN, parse_history, solve


def make_ops(spec):
    return parse_history({"type": "stack", "operations": spec})


class TestAcceptanceA(unittest.TestCase):
    """Two pushes and one pop: intervals must match the hand-computed reference.

    p1: push 1 in [0, 2]
    p2: push 2 in [1, 10]
    po: pop -> 2 in [5, 8]

    Real time forces p1 < po (2 <= 5); LIFO (pop observes 2) forces
    p1 < p2 < po, so the unique order is p1 < p2 < po with
    t1 <= t2 <= t3, t1 in [0,2], t2 in [1,10], t3 in [5,8]. Projection:
      t1 in [0, 2]
      t2 in [1, 8]  (t2 <= t3 <= 8 tightens the upper bound)
      t3 in [5, 8]
    """

    def test_intervals_match_reference(self):
        ops = make_ops([
            {"id": "p1", "op": "push", "value": 1, "start": 0, "end": 2},
            {"id": "p2", "op": "push", "value": 2, "start": 1, "end": 10},
            {"id": "po", "op": "pop", "value": 2, "start": 5, "end": 8},
        ])
        result = solve(ops, timeout_ms=2000)
        self.assertEqual(result.status, OK)
        self.assertEqual(result.intervals, {
            "p1": [0, 2],
            "p2": [1, 8],
            "po": [5, 8],
        })
        self.assertEqual(result.conflict, [])


class TestAcceptanceB(unittest.TestCase):
    """A pop observing the wrong LIFO value is INFEASIBLE with a conflict set."""

    def test_wrong_pop_order(self):
        ops = make_ops([
            {"id": "pa", "op": "push", "value": "A", "start": 0, "end": 2},
            {"id": "pb", "op": "push", "value": "B", "start": 3, "end": 4},
            {"id": "po", "op": "pop", "value": "A", "start": 5, "end": 7},
        ])
        result = solve(ops, timeout_ms=2000)
        self.assertEqual(result.status, INFEASIBLE)
        self.assertTrue(result.conflict)
        self.assertIn("po", result.conflict)
        self.assertTrue(set(result.conflict) <= {"pa", "pb", "po"})


class TestAcceptanceC(unittest.TestCase):
    """A missing return (pending push) that could explain the pop -> UNKNOWN."""

    def test_pending_dependency_is_unknown_not_infeasible(self):
        ops = make_ops([
            {"id": "po", "op": "pop", "value": 1, "start": 0, "end": 10},
            {"id": "pp", "op": "push", "value": 1, "start": 0, "end": None},
        ])
        result = solve(ops, timeout_ms=2000)
        self.assertEqual(result.status, UNKNOWN)
        self.assertEqual(result.conflict, [])

    def test_pending_pop_can_only_extend_unknown(self):
        # Completed ops are infeasible (B on top, pop observes A), but a
        # pending pop could have removed B: UNKNOWN, not INFEASIBLE.
        ops = make_ops([
            {"id": "pa", "op": "push", "value": "A", "start": 0, "end": 2},
            {"id": "pb", "op": "push", "value": "B", "start": 3, "end": 4},
            {"id": "po", "op": "pop", "value": "A", "start": 5, "end": 9},
            {"id": "px", "op": "pop", "start": 4, "end": None},
        ])
        result = solve(ops, timeout_ms=2000)
        self.assertEqual(result.status, UNKNOWN)


class TestAcceptanceD(unittest.TestCase):
    """A zero time budget yields TIMEOUT with propagated intervals."""

    def test_zero_timeout(self):
        ops = make_ops([
            {"id": "p1", "op": "push", "value": 1, "start": 0, "end": 2},
            {"id": "p2", "op": "push", "value": 2, "start": 1, "end": 10},
            {"id": "po", "op": "pop", "value": 2, "start": 5, "end": 8},
        ])
        result = solve(ops, timeout_ms=0)
        self.assertEqual(result.status, TIMEOUT)
        # Only real-time propagation ran: intervals equal the input windows.
        self.assertEqual(result.intervals, {
            "p1": [0, 2],
            "p2": [1, 10],
            "po": [5, 8],
        })


class TestSemantics(unittest.TestCase):
    def test_empty_pop_requires_empty_stack(self):
        ops = make_ops([
            {"id": "p", "op": "push", "value": 1, "start": 0, "end": 1},
            {"id": "e", "op": "pop", "value": "EMPTY", "start": 2, "end": 3},
        ])
        # The push strictly precedes the EMPTY pop and is never popped:
        # the stack cannot be empty at the pop, so the history is infeasible.
        self.assertEqual(solve(ops, timeout_ms=2000).status, INFEASIBLE)

    def test_real_time_precedence_tightens_intervals(self):
        ops = make_ops([
            {"id": "a", "op": "push", "value": 1, "start": 0, "end": 4},
            {"id": "b", "op": "pop", "value": 1, "start": 4, "end": 8},
        ])
        result = solve(ops, timeout_ms=2000)
        self.assertEqual(result.status, OK)
        self.assertEqual(result.intervals["a"], [0, 4])
        self.assertEqual(result.intervals["b"], [4, 8])


if __name__ == "__main__":
    unittest.main()
