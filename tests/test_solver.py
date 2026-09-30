import json
import unittest

from schedsolve import InconsistentStateError, InputError, Solver
from schedsolve.brute import brute_force
from schedsolve.checker import (
    verify_candidate,
    verify_conflict_tree,
    verify_schedule,
)

# s0 == s1 (difference-feasible) but tasks 0 and 1 may not overlap.
DISJ_UNSAT_INST = {
    "n_tasks": 2,
    "durations": [2, 3],
    "constraints": [{"u": 0, "v": 1, "c": 0}, {"u": 1, "v": 0, "c": 0}],
    "disjuncts": [[0, 1]],
}

CHAIN_INST = {
    "n_tasks": 4,
    "durations": [1, 2, 1, 2],
    "constraints": [{"u": 0, "v": 3, "c": 6}],
    "disjuncts": [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]],
}


def build_solver(inst):
    s = Solver(inst["n_tasks"], inst["durations"])
    for k, con in enumerate(inst.get("constraints", [])):
        s.add_constraint(con["u"], con["v"], con["c"], uid=con.get("uid", f"k{k}"))
    for i, j in inst.get("disjuncts", []):
        s.add_disjunct(i, j)
    return s


class TestDisjunctiveUnsat(unittest.TestCase):
    """Difference part locally feasible, disjunctive combination infeasible."""

    def test_unsat_with_replayable_tree(self):
        solver = build_solver(DISJ_UNSAT_INST)
        result = solver.solve()
        self.assertEqual(result.status, "unsat")
        tree = result.conflict_tree
        self.assertEqual(tree["type"], "node")
        self.assertEqual(set(tree["children"]), {"0", "1"})
        for child in tree["children"].values():
            self.assertEqual(child["type"], "leaf")
            self.assertLess(child["cycle"]["weight"], 0)
        self.assertTrue(verify_conflict_tree(DISJ_UNSAT_INST, tree))

    def test_brute_force_agrees(self):
        status, _ = brute_force(2, [2, 3], [(0, 1, 0), (1, 0, 0)], [(0, 1)], 10)
        self.assertEqual(status, "unsat")


class TestRetractRefesible(unittest.TestCase):
    """After retracting a constraint the instance becomes feasible again."""

    def test_retraction_restores_feasibility(self):
        solver = Solver(2, [1, 1])
        solver.add_constraint(0, 1, 5)  # x1 - x0 <= 5
        solver.push()
        cert = solver.add_constraint(1, 0, -10)  # x0 - x1 <= -10: conflict
        self.assertIsNotNone(cert)
        with self.assertRaises(InconsistentStateError):
            solver.add_constraint(0, 1, 0)
        solver.pop()  # retract: tightenings and conflict must be gone
        self.assertTrue(solver.dc.is_consistent())
        result = solver.solve()
        self.assertEqual(result.status, "sat")
        inst = {"n_tasks": 2, "durations": [1, 1],
                "constraints": [{"u": 0, "v": 1, "c": 5}]}
        self.assertTrue(verify_schedule(inst, result.schedule))


class TestPauseResume(unittest.TestCase):
    """Pause and resume the very same branch many times via saved frontiers."""

    def test_repeated_pause_resume(self):
        one_shot = build_solver(CHAIN_INST).solve()
        self.assertEqual(one_shot.status, "sat")

        solver = build_solver(CHAIN_INST)
        frontier = None
        result = None
        pauses = 0
        for _ in range(500):
            # relax budget 5 >= n+1, so any single ordering add can
            # always complete; progress per resume is then guaranteed
            result = solver.solve(relax_budget=5, branch_budget=1,
                                  frontier=frontier)
            if result.status != "unknown":
                break
            pauses += 1
            # candidate only claims consistency of asserted constraints
            self.assertTrue(verify_candidate(CHAIN_INST, result.candidate,
                                             result.frontier))
            frontier = json.loads(json.dumps(result.frontier))  # JSON round-trip
        else:
            self.fail("search did not terminate within 500 resumes")
        self.assertGreater(pauses, 2)  # genuinely paused several times
        self.assertEqual(result.status, one_shot.status)
        self.assertEqual(result.schedule, one_shot.schedule)
        self.assertTrue(verify_schedule(CHAIN_INST, result.schedule))

    def test_frontier_resume_on_fresh_solver(self):
        solver = build_solver(CHAIN_INST)
        partial = solver.solve(branch_budget=1)
        self.assertEqual(partial.status, "unknown")
        fresh = build_solver(CHAIN_INST)
        final = fresh.solve(frontier=partial.frontier)
        self.assertEqual(final.status, "sat")
        self.assertEqual(final.schedule,
                         build_solver(CHAIN_INST).solve().schedule)


class TestBudgetBoundary(unittest.TestCase):
    """Budget ends exactly before the conflict that decides the instance."""

    def test_relax_budget_boundary(self):
        def run(relax=None, branch=None):
            return build_solver(DISJ_UNSAT_INST).solve(relax_budget=relax,
                                                       branch_budget=branch)

        full = run()
        self.assertEqual(full.status, "unsat")
        need = full.stats["relax_steps"]
        self.assertGreater(need, 0)
        self.assertEqual(run(relax=need - 1).status, "unknown")
        self.assertEqual(run(relax=need).status, "unsat")
        # the first conflict alone needs 2 relaxations; 1 stops just before it
        self.assertEqual(run(relax=1).status, "unknown")
        self.assertEqual(run(relax=2).status, "unknown")  # second branch needs more

    def test_branch_budget_boundary(self):
        def run(branch):
            return build_solver(DISJ_UNSAT_INST).solve(branch_budget=branch)

        self.assertEqual(run(0).status, "unknown")
        self.assertEqual(run(1).status, "unsat")

    def test_unknown_never_claims_feasibility(self):
        result = build_solver(DISJ_UNSAT_INST).solve(relax_budget=1)
        self.assertEqual(result.status, "unknown")
        self.assertIsNotNone(result.candidate)
        self.assertIsNone(result.schedule)
        # candidate satisfies asserted constraints but the instance is unsat:
        # local consistency must not be reported as global feasibility.
        self.assertTrue(verify_candidate(DISJ_UNSAT_INST, result.candidate,
                                         result.frontier))


class TestSolverInputErrors(unittest.TestCase):
    def test_invalid_constraint_rolls_back(self):
        solver = Solver(2, [1, 1])
        solver.add_constraint(0, 1, 3)
        before = (len(solver.constraints), len(solver.dc.edges), list(solver.dc.pi))
        bad_calls = [
            lambda: solver.add_constraint(0, 7, 1),
            lambda: solver.add_constraint(0, 1, "x"),
            lambda: solver.add_constraint(0, 1, 1, uid="k0"),   # duplicate uid
            lambda: solver.add_constraint(0, 1, 1, uid="ord:0:1"),  # reserved
            lambda: solver.add_disjunct(0, 0),
            lambda: solver.add_disjunct(0, 5),
        ]
        for call in bad_calls:
            with self.assertRaises(InputError):
                call()
        self.assertEqual((len(solver.constraints), len(solver.dc.edges),
                          list(solver.dc.pi)), before)
        self.assertEqual(solver.solve().status, "sat")

    def test_nonpositive_duration_rejected(self):
        with self.assertRaises(InputError):
            Solver(2, [1, 0])
        with self.assertRaises(InputError):
            Solver(2, [1, -3])

    def test_base_conflict_gives_leaf_tree(self):
        solver = Solver(2, [1, 1])
        solver.add_constraint(0, 1, -1)
        cert = solver.add_constraint(1, 0, -1)
        self.assertIsNotNone(cert)
        result = solver.solve()
        self.assertEqual(result.status, "unsat")
        self.assertEqual(result.conflict_tree["type"], "leaf")
        inst = {"n_tasks": 2, "durations": [1, 1],
                "constraints": [{"u": 0, "v": 1, "c": -1},
                                {"u": 1, "v": 0, "c": -1}]}
        self.assertTrue(verify_conflict_tree(inst, result.conflict_tree))


if __name__ == "__main__":
    unittest.main()
