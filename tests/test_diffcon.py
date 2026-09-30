import unittest

from schedsolve import (
    DifferenceConstraints,
    InconsistentStateError,
    InputError,
)
from schedsolve.diffcon import RelaxBudgetExhausted


class TestPropagation(unittest.TestCase):
    def test_basic_tightening(self):
        dc = DifferenceConstraints(3)
        self.assertIsNone(dc.add_edge(0, 1, 5, "a"))
        self.assertIsNone(dc.add_edge(1, 2, 3, "b"))
        self.assertEqual(dc.pi, [0, 0, 0])
        self.assertIsNone(dc.add_edge(2, 0, -4, "c"))  # x0 - x2 <= -4
        self.assertEqual(dc.pi, [-4, 0, 0])
        for e in dc.edges:  # potentials satisfy every edge
            self.assertLessEqual(dc.pi[e.v], dc.pi[e.u] + e.c)

    def test_negative_cycle_certificate(self):
        dc = DifferenceConstraints(3)
        dc.add_edge(0, 1, 2, "a")
        dc.add_edge(1, 2, -5, "b")
        cert = dc.add_edge(2, 0, 2, "c")
        self.assertIsNotNone(cert)
        self.assertIs(dc.conflict, cert)
        edges = cert["edges"]
        self.assertEqual([e["uid"] for e in edges], ["a", "b", "c"])
        for k in range(len(edges)):  # edges form a closed cycle
            self.assertEqual(edges[k]["v"], edges[(k + 1) % len(edges)]["u"])
        self.assertEqual(cert["weight"], sum(e["c"] for e in edges))
        self.assertLess(cert["weight"], 0)

    def test_relax_budget_exhaustion_rolls_back(self):
        dc = DifferenceConstraints(3)
        dc.add_edge(0, 1, 2, "a")
        dc.add_edge(1, 2, -5, "b")
        dc.set_budget([1])
        with self.assertRaises(RelaxBudgetExhausted):
            dc.add_edge(2, 0, 2, "c")
        # fully rolled back: no edge, potentials intact, still consistent
        self.assertEqual(len(dc.edges), 2)
        self.assertEqual(dc.pi, [0, 0, -5])
        self.assertIsNone(dc.conflict)
        dc.set_budget(None)
        self.assertIsNotNone(dc.add_edge(2, 0, 2, "c"))


class TestUndo(unittest.TestCase):
    def test_nested_push_pop_restores_tightening(self):
        dc = DifferenceConstraints(3)
        dc.add_edge(0, 1, 5, "a")
        dc.add_edge(1, 2, 3, "b")
        dc.push()
        dc.add_edge(2, 0, -4, "c")
        self.assertEqual(dc.pi, [-4, 0, 0])
        dc.push()
        dc.add_edge(2, 1, -2, "d")  # x1 - x2 <= -2: tightens pi[1], no cycle
        self.assertEqual(dc.pi, [-4, -2, 0])
        dc.pop()
        self.assertEqual(dc.pi, [-4, 0, 0])  # tightening from "d" undone
        self.assertEqual(len(dc.edges), 3)
        dc.pop()
        self.assertEqual(dc.pi, [0, 0, 0])
        self.assertEqual(len(dc.edges), 2)

    def test_pop_restores_conflict_dependency(self):
        dc = DifferenceConstraints(2)
        dc.add_edge(0, 1, 1, "a")
        dc.push()
        dc.add_edge(1, 0, -3, "b")  # closes a cycle of weight -2
        self.assertIsNotNone(dc.conflict)
        with self.assertRaises(InconsistentStateError):
            dc.add_edge(0, 1, 0, "c")
        dc.pop()  # retraction removes the edge, its tightenings AND the conflict
        self.assertIsNone(dc.conflict)
        self.assertEqual(dc.pi, [0, 0])
        self.assertEqual(len(dc.edges), 1)
        self.assertIsNone(dc.add_edge(1, 0, -1, "d"))  # level usable again

    def test_pop_without_push_raises(self):
        dc = DifferenceConstraints(1)
        with self.assertRaises(InputError):
            dc.pop()


class TestInputRollback(unittest.TestCase):
    def test_invalid_input_leaves_state_untouched(self):
        dc = DifferenceConstraints(2)
        dc.add_edge(0, 1, 4, "a")
        snapshot = (list(dc.pi), len(dc.edges))
        bad_calls = [
            lambda: dc.add_edge(0, 5, 1, "x"),     # index out of range
            lambda: dc.add_edge(-1, 1, 1, "x"),    # negative index
            lambda: dc.add_edge(0, 1, 1.5, "x"),   # non-integer bound
            lambda: dc.add_edge(0, 1, True, "x"),  # bool is not an int here
            lambda: dc.add_edge(0, 1, 1, ""),      # empty uid
            lambda: dc.add_edge(0, 1, 1, None),    # missing uid
        ]
        for call in bad_calls:
            with self.assertRaises(InputError):
                call()
        self.assertEqual((list(dc.pi), len(dc.edges)), snapshot)
        self.assertIsNone(dc.conflict)
        self.assertIsNone(dc.add_edge(1, 0, 0, "b"))  # still fully usable


if __name__ == "__main__":
    unittest.main()
