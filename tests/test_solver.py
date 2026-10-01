import unittest

from csp_trail.core import (
    CspError,
    DomainValueError,
    InvalidLevelError,
    Problem,
    Solver,
    UnknownVariableError,
)
from tests.reference import ReferenceSolver


def less_than_pairs(left, right):
    return frozenset((a, b) for a in left for b in right if a < b)


def chain_problem(names, values):
    domains = {name: list(values) for name in names}
    constraints = []
    for first, second in zip(names, names[1:]):
        constraints.append((first, second, less_than_pairs(values, values)))
    return Problem(domains, constraints)


def assert_same_domains(testcase, solver, reference):
    testcase.assertEqual(
        {var: sorted(dom) for var, dom in solver.domains.items()},
        {var: sorted(dom) for var, dom in reference.domains.items()},
    )
    testcase.assertEqual(solver.level, reference.level)
    testcase.assertEqual(solver.status, reference.status)


class InitialPropagationTest(unittest.TestCase):
    def test_level_zero_propagation(self):
        solver = Solver(chain_problem(["a", "b", "c"], [1, 2, 3, 4]))
        self.assertEqual(solver.level, 0)
        self.assertEqual(solver.status, "ok")
        self.assertEqual(solver.domains["a"], {1, 2})
        self.assertEqual(solver.domains["b"], {2, 3})
        self.assertEqual(solver.domains["c"], {3, 4})
        # Every level-0 entry stays on the trail permanently.
        self.assertTrue(all(level == 0 for _, _, level in solver.trail))
        self.assertEqual(len(solver.trail), 6)

    def test_unsat_only_from_level_zero(self):
        problem = Problem(
            {"a": [1, 2], "b": [1]},
            [("a", "b", less_than_pairs([1, 2], [1]))],
        )
        solver = Solver(problem)
        self.assertEqual(solver.status, "unsat")
        self.assertEqual(solver.level, 0)
        with self.assertRaises(CspError):
            solver.assign("a", 1)


class ChainConflictReferenceTest(unittest.TestCase):
    """Acceptance 1: 3-variable chain, every level matches the deep-copy reference."""

    def setUp(self):
        self.problem = chain_problem(["a", "b", "c"], [1, 2, 3, 4])

    def test_assign_conflict_and_backtracks_match_reference(self):
        solver = Solver(self.problem)
        reference = ReferenceSolver(self.problem)
        assert_same_domains(self, solver, reference)

        self.assertTrue(solver.assign("a", 1))
        self.assertTrue(reference.assign("a", 1))
        assert_same_domains(self, solver, reference)

        self.assertTrue(solver.assign("b", 3))
        self.assertTrue(reference.assign("b", 3))
        assert_same_domains(self, solver, reference)
        self.assertEqual(solver.domains["c"], {4})

        # Level 3: c=3 empties the domain -> conflict, auto-undo to level 2.
        self.assertFalse(solver.assign("c", 3))
        self.assertFalse(reference.assign("c", 3))
        assert_same_domains(self, solver, reference)
        self.assertEqual(solver.level, 2)
        self.assertEqual(solver.status, "conflict")
        self.assertEqual(solver.domains["c"], {4})

        solver.backtrack(1)
        reference.backtrack(1)
        assert_same_domains(self, solver, reference)
        self.assertEqual(solver.domains["b"], {2, 3})
        self.assertEqual(solver.domains["c"], {3, 4})

        solver.backtrack(0)
        reference.backtrack(0)
        assert_same_domains(self, solver, reference)
        self.assertEqual(solver.domains["a"], {1, 2})

        # Trail entries are appended in non-decreasing level order.
        levels = [level for _, _, level in solver.trail]
        self.assertEqual(levels, sorted(levels))


class MultiLevelBacktrackTest(unittest.TestCase):
    """Acceptance 2: conflict across 3 levels, backtrack to level 1 keeps level 0."""

    def setUp(self):
        self.problem = chain_problem(["a", "b", "c", "d"], [1, 2, 3, 4, 5, 6])

    def test_backtrack_from_level_3_to_level_1(self):
        solver = Solver(self.problem)
        reference = ReferenceSolver(self.problem)
        level_zero_trail = list(solver.trail)
        self.assertTrue(level_zero_trail)

        self.assertTrue(solver.assign("a", 1))
        self.assertTrue(reference.assign("a", 1))
        self.assertTrue(solver.assign("b", 3))
        self.assertTrue(reference.assign("b", 3))
        self.assertTrue(solver.assign("c", 4))
        self.assertTrue(reference.assign("c", 4))
        self.assertEqual(solver.level, 3)
        assert_same_domains(self, solver, reference)

        # Conflict on level 4 undoes itself, then backtrack across 3 levels.
        self.assertFalse(solver.assign("d", 4))
        self.assertFalse(reference.assign("d", 4))
        self.assertEqual(solver.level, 3)

        solver.backtrack(1)
        reference.backtrack(1)
        assert_same_domains(self, solver, reference)
        self.assertEqual(solver.level, 1)
        # Levels 2 and 3 fully undone.
        self.assertEqual(solver.domains["b"], {2, 3, 4})
        self.assertEqual(solver.domains["c"], {3, 4, 5})
        self.assertEqual(solver.domains["d"], {4, 5, 6})
        self.assertEqual(solver.domains["a"], {1})
        # Level-0 removals are permanent.
        self.assertFalse({4, 5, 6} & solver.domains["a"])
        self.assertFalse({1, 2, 3} & solver.domains["d"])
        remaining = [(v, val) for v, val, lvl in solver.trail if lvl == 0]
        self.assertEqual(remaining, [(v, val) for v, val, _ in level_zero_trail])
        self.assertTrue(all(lvl <= 1 for _, _, lvl in solver.trail))


class ErrorConventionTest(unittest.TestCase):
    """Acceptance 3: invalid variable / value / level raise the agreed errors."""

    def setUp(self):
        self.solver = Solver(chain_problem(["a", "b"], [1, 2, 3]))

    def test_assign_unknown_variable(self):
        with self.assertRaises(UnknownVariableError):
            self.solver.assign("nope", 1)

    def test_assign_value_outside_domain(self):
        with self.assertRaises(DomainValueError):
            self.solver.assign("a", 99)

    def test_backtrack_negative_level(self):
        with self.assertRaises(InvalidLevelError):
            self.solver.backtrack(-1)

    def test_backtrack_above_current_level(self):
        self.solver.assign("a", 1)
        with self.assertRaises(InvalidLevelError):
            self.solver.backtrack(2)


class TrailCountTest(unittest.TestCase):
    """Acceptance 4: without conflicts, trail size equals actual removal count."""

    def test_trail_entries_equal_removals(self):
        problem = chain_problem(["a", "b", "c", "d"], [1, 2, 3, 4, 5, 6])
        solver = Solver(problem)
        reference = ReferenceSolver(problem)
        for var, value in [("a", 1), ("b", 3), ("c", 4), ("d", 6)]:
            self.assertTrue(solver.assign(var, value))
            self.assertTrue(reference.assign(var, value))
        assert_same_domains(self, solver, reference)
        actual_removals = sum(
            len(problem.domains[var]) - len(solver.domains[var])
            for var in problem.domains
        )
        self.assertEqual(len(solver.trail), actual_removals)
        self.assertEqual(len(solver.trail), reference.removed_total)
        # No duplicate removal records for the same (variable, value).
        keys = [(var, value) for var, value, _ in solver.trail]
        self.assertEqual(len(keys), len(set(keys)))


if __name__ == "__main__":
    unittest.main()
