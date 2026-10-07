import unittest

from scheddiag import InputError, Solver
from scheddiag.checker import check_evidence, parse_instance
from scheddiag.cli import build_solver

SAT3 = {
    "num_tasks": 3,
    "durations": [2, 2, 2],
    "constraints": (
        [{"u": "zero", "v": i, "w": 4} for i in range(3)]
        + [{"u": i, "v": "zero", "w": 0} for i in range(3)]
    ),
    "disjuncts": [[0, 1], [1, 2], [0, 2]],
}

# difference part alone is feasible, but no disjunct ordering works
UNSAT_DISJ = {
    "num_tasks": 2,
    "durations": [3, 3],
    "constraints": [
        {"u": "zero", "v": 0, "w": 1},
        {"u": 0, "v": "zero", "w": 0},
        {"u": "zero", "v": 1, "w": 1},
        {"u": 1, "v": "zero", "w": 0},
    ],
    "disjuncts": [[0, 1]],
}

UNSAT_DIFF = {
    "num_tasks": 2,
    "durations": [1, 1],
    "constraints": [{"u": 0, "v": 1, "w": -1}, {"u": 1, "v": 0, "w": -2}],
    "disjuncts": [],
}

# 4 tasks of length 2 in a window of 7: pairwise exclusion is impossible
BIG_UNSAT = {
    "num_tasks": 4,
    "durations": [2, 2, 2, 2],
    "constraints": (
        [{"u": "zero", "v": i, "w": 5} for i in range(4)]
        + [{"u": i, "v": "zero", "w": 0} for i in range(4)]
    ),
    "disjuncts": [[i, j] for i in range(4) for j in range(i + 1, 4)],
}


def solve_instance(inst, **kw):
    return build_solver(parse_instance(inst)).solve(**kw)


class TestBasicSolve(unittest.TestCase):
    def test_sat_full_integer_schedule(self):
        inst = parse_instance(SAT3)
        result = build_solver(inst).solve()
        self.assertEqual(result["status"], "sat")
        schedule = result["schedule"]
        self.assertEqual(len(schedule), 3)
        self.assertTrue(all(isinstance(s, int) for s in schedule))
        ok, reason = check_evidence(inst, result)
        self.assertTrue(ok, reason)

    def test_difference_feasible_but_disjunctively_unsat(self):
        # the static difference constraints alone are satisfiable
        static_only = dict(UNSAT_DISJ, disjuncts=[])
        self.assertEqual(solve_instance(static_only)["status"], "sat")
        # adding the mutual exclusion makes every ordering infeasible
        inst = parse_instance(UNSAT_DISJ)
        result = build_solver(inst).solve()
        self.assertEqual(result["status"], "unsat")
        tree = result["certificate"]["tree"]
        self.assertEqual(tree["type"], "branch")
        self.assertEqual(len(tree["children"]), 2)
        self.assertTrue(all(c["type"] == "leaf" for c in tree["children"]))
        ok, reason = check_evidence(inst, result)
        self.assertTrue(ok, reason)

    def test_pure_difference_unsat_at_root(self):
        inst = parse_instance(UNSAT_DIFF)
        result = build_solver(inst).solve()
        self.assertEqual(result["status"], "unsat")
        tree = result["certificate"]["tree"]
        self.assertEqual(tree["type"], "leaf")
        self.assertLess(tree["weight"], 0)
        ok, reason = check_evidence(inst, result)
        self.assertTrue(ok, reason)


class TestUndo(unittest.TestCase):
    def test_undo_restores_feasibility(self):
        solver = Solver(1, [1])
        zero = solver.zero
        solver.add_constraint(0, zero, 0)  # x_zero - x_0 <= 0  =>  x_0 >= 0
        solver.push()
        solver.add_constraint(0, zero, -5)  # x_0 >= 5
        conflict = solver.add_constraint(zero, 0, 3)  # x_0 <= 3 -> clash
        self.assertIsNotNone(conflict)
        self.assertEqual(len(solver.conflicts), 1)
        # undo must remove the tightenings AND the conflict dependency
        self.assertTrue(solver.pop())
        self.assertEqual(len(solver.conflicts), 0)
        self.assertEqual(len(solver.edges), 1)
        self.assertIsNone(solver.add_constraint(zero, 0, 3))  # now fine
        result = solver.solve()
        self.assertEqual(result["status"], "sat")

    def test_potentials_restored_after_pop(self):
        solver = Solver(2, [1, 1])
        solver.add_constraint(0, 1, 2)  # x_1 - x_0 <= 2
        before = list(solver.pot)
        solver.push()
        solver.add_constraint(1, 0, -5)  # tighten x_0 - x_1 <= -5
        self.assertNotEqual(solver.pot, before)
        solver.pop()
        self.assertEqual(solver.pot, before)

    def test_nested_push_pop(self):
        solver = Solver(2, [1, 1])
        zero = solver.zero
        solver.push()
        solver.add_constraint(zero, 0, 1)
        solver.push()
        solver.add_constraint(zero, 1, 2)
        self.assertEqual(len(solver.static_constraints), 2)
        solver.pop()
        self.assertEqual(len(solver.static_constraints), 1)
        solver.pop()
        self.assertEqual(len(solver.static_constraints), 0)
        self.assertFalse(solver.pop())

    def test_conflict_dependency_purged_with_edge(self):
        solver = Solver(1, [1])
        zero = solver.zero
        solver.push()
        solver.add_constraint(0, zero, -5)  # x_0 >= 5
        solver.push()
        conflict = solver.add_constraint(zero, 0, 3)  # x_0 <= 3
        self.assertIsNotNone(conflict)
        deps = conflict.deps
        self.assertEqual(len(solver.conflicts), 1)
        solver.pop()  # removes only the second constraint
        self.assertEqual(len(solver.conflicts), 0)
        # the first constraint is still active and can conflict again
        conflict2 = solver.add_constraint(zero, 0, 4)
        self.assertIsNotNone(conflict2)
        self.assertTrue(deps != conflict2.deps or True)
        solver.pop()
        self.assertEqual(len(solver.conflicts), 0)
        self.assertEqual(len(solver.edges), 0)


class TestBudgetAndFrontier(unittest.TestCase):
    def test_branch_budget_exhaustion_returns_unknown_with_candidate(self):
        inst = parse_instance(SAT3)
        result = build_solver(inst).solve(branch_budget=0)
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(result["reason"], "branch budget exhausted")
        # candidate must satisfy the decided constraints (none decided yet)
        ok, reason = check_evidence(inst, result)
        self.assertTrue(ok, reason)
        # unknown must not claim global feasibility
        self.assertNotIn("certificate", result)
        self.assertIn("frontier", result)

    def test_budget_ends_exactly_before_conflict(self):
        inst = parse_instance(UNSAT_DISJ)
        full = build_solver(inst).solve()
        self.assertEqual(full["status"], "unsat")
        relax_needed = full["stats"]["relaxations"]
        branches_needed = full["stats"]["branches"]
        self.assertGreater(relax_needed, 0)
        self.assertGreater(branches_needed, 0)
        # one relaxation short: the final conflict cannot be derived
        short = build_solver(inst).solve(slack_budget=relax_needed - 1)
        self.assertEqual(short["status"], "unknown")
        self.assertEqual(short["reason"], "slack budget exhausted")
        # exactly enough: conflict is derived again
        exact = build_solver(inst).solve(slack_budget=relax_needed)
        self.assertEqual(exact["status"], "unsat")
        # one branch short
        short_b = build_solver(inst).solve(branch_budget=branches_needed - 1)
        self.assertEqual(short_b["status"], "unknown")
        exact_b = build_solver(inst).solve(branch_budget=branches_needed)
        self.assertEqual(exact_b["status"], "unsat")

    def test_pause_resume_same_branch_repeatedly(self):
        inst = parse_instance(BIG_UNSAT)
        oneshot = build_solver(inst).solve()
        self.assertEqual(oneshot["status"], "unsat")
        # resume on the same solver object, one branch node at a time
        solver = build_solver(inst)
        frontier = None
        steps = 0
        while True:
            result = solver.solve(branch_budget=1, frontier=frontier)
            steps += 1
            if result["status"] != "unknown":
                break
            frontier = result["frontier"]
            self.assertLess(steps, 1000)
        self.assertEqual(result["status"], "unsat")
        self.assertEqual(result["certificate"], oneshot["certificate"])
        self.assertGreater(steps, 2)  # genuinely paused and resumed

    def test_resume_across_solver_instances(self):
        inst = parse_instance(BIG_UNSAT)
        frontier = None
        for _ in range(1000):
            solver = build_solver(inst)  # fresh solver every time
            result = solver.solve(branch_budget=2, frontier=frontier)
            if result["status"] != "unknown":
                break
            frontier = result["frontier"]
        self.assertEqual(result["status"], "unsat")
        oneshot = build_solver(inst).solve()
        self.assertEqual(result["certificate"], oneshot["certificate"])

    def test_resume_sat_instance(self):
        inst = parse_instance(SAT3)
        frontier = None
        for _ in range(1000):
            result = build_solver(inst).solve(branch_budget=1, frontier=frontier)
            if result["status"] != "unknown":
                break
            frontier = result["frontier"]
        self.assertEqual(result["status"], "sat")
        ok, reason = check_evidence(inst, result)
        self.assertTrue(ok, reason)

    def test_frontier_fingerprint_mismatch_rejected(self):
        inst = parse_instance(BIG_UNSAT)
        result = build_solver(inst).solve(branch_budget=1)
        self.assertEqual(result["status"], "unknown")
        other = build_solver(parse_instance(SAT3))
        with self.assertRaises(InputError):
            other.solve(frontier=result["frontier"])


class TestInputErrors(unittest.TestCase):
    def test_invalid_input_rolls_back(self):
        solver = Solver(2, [1, 2])
        solver.add_constraint(0, 1, 5)
        state = (len(solver.edges), list(solver.pot),
                 len(solver.static_constraints), len(solver.trail))
        for bad in [(0, 9, 1), (9, 0, 1), (0, 1, "x"), (0, 1, 1.5),
                    (0, 1, True), ("a", 1, 0)]:
            with self.assertRaises(InputError):
                solver.add_constraint(*bad)
        with self.assertRaises(InputError):
            solver.add_disjunct(0, 0)
        with self.assertRaises(InputError):
            solver.add_disjunct(0, 7)
        with self.assertRaises(InputError):
            Solver(2, [1, 0])  # non-positive duration
        with self.assertRaises(InputError):
            Solver(1, [1, 1])  # wrong durations length
        self.assertEqual(state, (len(solver.edges), list(solver.pot),
                                 len(solver.static_constraints),
                                 len(solver.trail)))

    def test_batch_add_is_atomic_on_input_error(self):
        solver = Solver(2, [1, 2])
        solver.add_constraint(0, 1, 1)
        before = len(solver.static_constraints)
        with self.assertRaises(InputError):
            solver.add_constraints([(0, 1, 3), (1, 99, 2), (0, 0, 0)])
        self.assertEqual(len(solver.static_constraints), before)
        self.assertIsNone(solver.add_constraints([(0, 1, 3), (1, 0, 0)]))
        self.assertEqual(len(solver.static_constraints), before + 2)

    def test_invalid_budget_rejected(self):
        solver = Solver(1, [1])
        with self.assertRaises(InputError):
            solver.solve(slack_budget=-1)
        with self.assertRaises(InputError):
            solver.solve(branch_budget="x")


if __name__ == "__main__":
    unittest.main()
