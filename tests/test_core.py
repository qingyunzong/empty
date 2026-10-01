import unittest

from csp_trail import (
    InvalidLevelError,
    TrailCSP,
    UnknownVariableError,
    ValueNotInDomainError,
)
from tests.reference import ReferenceCSP


def chain_problem():
    """3-variable chain: x==y, y==z, x!=z over {1,2}.

    Arc-consistent at level 0, but assigning x forces y and z to equal
    values that violate x!=z after propagation -> conflict.
    """
    variables = {"x": [1, 2], "y": [1, 2], "z": [1, 2]}
    eq = [(1, 1), (2, 2)]
    ne = [(1, 2), (2, 1)]
    constraints = [("x", "y", eq), ("y", "z", eq), ("x", "z", ne)]
    return variables, constraints


def layered_problem():
    """Problem with level-0 pruning and three clean assignment levels.

    Level 0: a in {1,2}, b in {2,3}, a==b prunes a->{2}, b->{2}.
    c, d, e are chained by inequality so each assignment prunes more.
    """
    variables = {
        "a": [1, 2],
        "b": [2, 3],
        "c": [1, 2, 3],
        "d": [1, 2, 3],
        "e": [1, 2, 3],
    }
    eq = [(1, 1), (2, 2), (3, 3)]
    ne = [(i, j) for i in (1, 2, 3) for j in (1, 2, 3) if i != j]
    constraints = [
        ("a", "b", eq),
        ("c", "d", ne),
        ("d", "e", ne),
    ]
    return variables, constraints


class TestInitialPropagation(unittest.TestCase):
    def test_level_zero_propagation(self):
        variables, constraints = layered_problem()
        csp = TrailCSP(variables, constraints)
        self.assertEqual(csp.current_level, 0)
        self.assertEqual(csp.status, TrailCSP.STATUS_OK)
        self.assertEqual(csp.domains["a"], {2})
        self.assertEqual(csp.domains["b"], {2})
        # level-0 removals recorded on the trail at level 0
        self.assertEqual(
            sorted(csp.trail),
            sorted([("a", 1, 0), ("b", 3, 0)]),
        )

    def test_level_zero_unsat(self):
        variables = {"p": [1], "q": [2]}
        constraints = [("p", "q", [(1, 1)])]  # p=1 has no support in q
        csp = TrailCSP(variables, constraints)
        self.assertEqual(csp.status, TrailCSP.STATUS_UNSAT)
        self.assertEqual(csp.current_level, 0)


class TestChainConflictAgainstReference(unittest.TestCase):
    """Acceptance 1: 3-variable chain conflict; trail state must match a
    full deep-copy reference implementation level by level."""

    def test_chain_conflict_matches_deepcopy_reference(self):
        variables, constraints = chain_problem()
        csp = TrailCSP(variables, constraints)
        ref = ReferenceCSP(variables, constraints)

        self.assertEqual(csp.snapshot(), ref.snapshot())
        self.assertEqual(csp.current_level, ref.current_level)

        # Level 1: assign x=1 -> propagates y={1}, z={2}, then y==z fails.
        self.assertEqual(csp.assign("x", 1), TrailCSP.STATUS_CONFLICT)
        self.assertEqual(ref.assign("x", 1), "conflict")
        # Conflict must auto-undo: back to level 0, domains restored.
        self.assertEqual(csp.current_level, 0)
        self.assertEqual(csp.snapshot(), ref.snapshot())
        self.assertEqual(csp.current_level, ref.current_level)

        # Level 1 again with the other value: symmetric conflict.
        self.assertEqual(csp.assign("x", 2), TrailCSP.STATUS_CONFLICT)
        self.assertEqual(ref.assign("x", 2), "conflict")
        self.assertEqual(csp.snapshot(), ref.snapshot())
        self.assertEqual(csp.current_level, 0)


class TestMultiLevelBacktrack(unittest.TestCase):
    """Acceptance 2: conflict-free assignments across 3 levels, then
    backtrack to level 1; levels 2 and 3 are undone, level 0 kept."""

    def test_backtrack_across_three_levels(self):
        variables, constraints = layered_problem()
        csp = TrailCSP(variables, constraints)
        ref = ReferenceCSP(variables, constraints)
        level0_domains = csp.snapshot()

        self.assertEqual(csp.assign("c", 1), TrailCSP.STATUS_OK)   # level 1
        self.assertEqual(ref.assign("c", 1), "ok")
        self.assertEqual(csp.assign("d", 2), TrailCSP.STATUS_OK)   # level 2
        self.assertEqual(ref.assign("d", 2), "ok")
        self.assertEqual(csp.assign("e", 1), TrailCSP.STATUS_OK)   # level 3
        self.assertEqual(ref.assign("e", 1), "ok")
        self.assertEqual(csp.current_level, 3)
        self.assertEqual(csp.snapshot(), ref.snapshot())

        csp.backtrack(1)
        ref.backtrack(1)
        self.assertEqual(csp.current_level, 1)
        self.assertEqual(csp.snapshot(), ref.snapshot())
        # levels 2 and 3 fully undone
        self.assertEqual(csp.domains["d"], {2, 3})
        self.assertEqual(csp.domains["e"], {1, 2, 3})
        # level-0 propagation permanently retained
        self.assertEqual(csp.domains["a"], {2})
        self.assertEqual(csp.domains["b"], {2})
        # trail now holds only level-0 and level-1 entries
        self.assertTrue(all(entry[2] <= 1 for entry in csp.trail))
        self.assertTrue(any(entry[2] == 0 for entry in csp.trail))

    def test_backtrack_to_zero_keeps_level_zero_changes(self):
        variables, constraints = layered_problem()
        csp = TrailCSP(variables, constraints)
        level0_domains = csp.snapshot()
        csp.assign("c", 3)
        csp.assign("d", 1)
        csp.backtrack(0)
        self.assertEqual(csp.current_level, 0)
        self.assertEqual(csp.snapshot(), level0_domains)
        self.assertEqual(csp.domains["a"], {2})
        self.assertEqual(csp.domains["b"], {2})

    def test_backtrack_is_noop_at_current_level(self):
        variables, constraints = layered_problem()
        csp = TrailCSP(variables, constraints)
        csp.assign("c", 1)
        before = csp.snapshot()
        csp.backtrack(1)
        self.assertEqual(csp.snapshot(), before)
        self.assertEqual(csp.current_level, 1)


class TestErrors(unittest.TestCase):
    """Acceptance 3: error conventions for bad assignments/levels."""

    def setUp(self):
        variables, constraints = layered_problem()
        self.csp = TrailCSP(variables, constraints)

    def test_assign_unknown_variable(self):
        with self.assertRaises(UnknownVariableError):
            self.csp.assign("nope", 1)

    def test_assign_value_not_in_domain(self):
        with self.assertRaises(ValueNotInDomainError):
            self.csp.assign("c", 99)

    def test_assign_value_pruned_at_level_zero(self):
        # a was pruned to {2} at level 0; 1 is no longer in the domain.
        with self.assertRaises(ValueNotInDomainError):
            self.csp.assign("a", 1)

    def test_backtrack_negative_level(self):
        with self.assertRaises(InvalidLevelError):
            self.csp.backtrack(-1)

    def test_backtrack_beyond_current_level(self):
        self.csp.assign("c", 1)
        with self.assertRaises(InvalidLevelError):
            self.csp.backtrack(2)
        with self.assertRaises(InvalidLevelError):
            self.csp.backtrack(10)


class TestTrailAccounting(unittest.TestCase):
    """Acceptance 4: without conflicts, trail length equals the exact
    number of domain value removals performed."""

    def test_trail_entries_equal_removal_count(self):
        variables, constraints = layered_problem()
        csp = TrailCSP(variables, constraints)
        ref = ReferenceCSP(variables, constraints)
        self.assertEqual(csp.assign("c", 1), TrailCSP.STATUS_OK)
        self.assertEqual(ref.assign("c", 1), "ok")
        self.assertEqual(csp.assign("d", 3), TrailCSP.STATUS_OK)
        self.assertEqual(ref.assign("d", 3), "ok")
        self.assertEqual(csp.assign("e", 1), TrailCSP.STATUS_OK)
        self.assertEqual(ref.assign("e", 1), "ok")
        self.assertEqual(csp.snapshot(), ref.snapshot())
        self.assertEqual(len(csp.trail), ref.removal_count)
        # independent cross-check: initial sizes minus current sizes
        initial_total = sum(len(v) for v in variables.values())
        current_total = sum(len(d) for d in csp.domains.values())
        self.assertEqual(len(csp.trail), initial_total - current_total)

    def test_no_deepcopy_state_kept(self):
        # The solver must only keep the trail, not per-level domain copies.
        variables, constraints = layered_problem()
        csp = TrailCSP(variables, constraints)
        csp.assign("c", 1)
        csp.assign("d", 2)
        self.assertFalse(hasattr(csp, "snapshots"))
        self.assertTrue(all(len(entry) == 3 for entry in csp.trail))


if __name__ == "__main__":
    unittest.main()
