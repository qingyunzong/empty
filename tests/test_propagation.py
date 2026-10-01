import unittest

from fdsolver import Solver, SolverError, build_solver


class TestAllDifferentRegin(unittest.TestCase):
    def test_hall_set_forces_third_variable(self):
        # {a,b} both over {1,2} form a Hall set: c loses 1 and 2.
        solver = build_solver({
            "variables": {"a": [1, 2], "b": [1, 2], "c": [1, 2, 3]},
            "constraints": [{"type": "allDifferent", "vars": ["a", "b", "c"]}],
        })
        self.assertIsNone(solver.conflict)
        self.assertEqual(solver.domains["a"], {1, 2})
        self.assertEqual(solver.domains["b"], {1, 2})
        self.assertEqual(solver.domains["c"], {3})

    def test_removes_edges_beyond_assigned_variables(self):
        # No variable is assigned, yet x3 cannot take 1 or 2 in any
        # perfect matching: matching + alternating paths must remove them.
        solver = build_solver({
            "variables": {"x1": [1, 2], "x2": [1, 2], "x3": [1, 2, 3, 4]},
            "constraints": [{"type": "allDifferent", "vars": ["x1", "x2", "x3"]}],
        })
        self.assertEqual(solver.domains["x3"], {3, 4})
        self.assertEqual(solver.domains["x1"], {1, 2})
        self.assertEqual(solver.domains["x2"], {1, 2})

    def test_alternating_path_keeps_edge_to_free_value(self):
        # x1 can reach the free value 3, so (x1, 3) must survive.
        solver = build_solver({
            "variables": {"x1": [1, 2, 3], "x2": [1, 2]},
            "constraints": [{"type": "allDifferent", "vars": ["x1", "x2"]}],
        })
        self.assertEqual(solver.domains["x1"], {1, 2, 3})
        self.assertEqual(solver.domains["x2"], {1, 2})

    def test_hall_violation_is_conflict(self):
        solver = build_solver({
            "variables": {"a": [1, 2], "b": [1, 2], "c": [1, 2]},
            "constraints": [{"type": "allDifferent", "vars": ["a", "b", "c"]}],
        })
        self.assertIsNotNone(solver.conflict)


class TestTableConstraint(unittest.TestCase):
    def test_arc_consistent_but_globally_unsat(self):
        # Pairwise inequality over {1,2} for 3 variables: arc consistent
        # (propagation removes nothing, no conflict) yet no solution.
        spec = {
            "variables": {"x": [1, 2], "y": [1, 2], "z": [1, 2]},
            "constraints": [
                {"type": "table", "vars": ["x", "y"], "tuples": [[1, 2], [2, 1]]},
                {"type": "table", "vars": ["x", "z"], "tuples": [[1, 2], [2, 1]]},
                {"type": "table", "vars": ["y", "z"], "tuples": [[1, 2], [2, 1]]},
            ],
        }
        solver = build_solver(spec)
        self.assertIsNone(solver.conflict)  # propagation alone cannot refute
        for v in ("x", "y", "z"):
            self.assertEqual(solver.domains[v], {1, 2})

    def test_table_supports_prune_domains(self):
        solver = build_solver({
            "variables": {"a": [1, 2, 3], "b": [1, 2, 3]},
            "constraints": [
                {"type": "table", "vars": ["a", "b"],
                 "tuples": [[1, 2], [2, 3]]},
            ],
        })
        self.assertEqual(solver.domains["a"], {1, 2})
        self.assertEqual(solver.domains["b"], {2, 3})

    def test_common_fixpoint_across_constraints(self):
        # alldiff forces c=3; then the table on (a,c) forces a=1;
        # then alldiff again forces b=2.  One propagation pass must
        # iterate to the common fixpoint.
        solver = build_solver({
            "variables": {"a": [1, 2], "b": [1, 2], "c": [1, 2, 3]},
            "constraints": [
                {"type": "allDifferent", "vars": ["a", "b", "c"]},
                {"type": "table", "vars": ["a", "c"], "tuples": [[1, 3]]},
            ],
        })
        self.assertEqual(solver.domains["a"], {1})
        self.assertEqual(solver.domains["b"], {2})
        self.assertEqual(solver.domains["c"], {3})


class TestAtomicRejection(unittest.TestCase):
    def setUp(self):
        self.solver = Solver()
        self.solver.add_variable("a", [1, 2])
        self.solver.add_variable("b", [1, 2])

    def test_duplicate_variable_rejected(self):
        with self.assertRaises(SolverError):
            self.solver.add_variable("a", [5])
        self.assertEqual(self.solver.domains["a"], {1, 2})

    def test_unknown_variable_reference_rejected(self):
        before = dict(self.solver.constraints)
        with self.assertRaises(SolverError):
            self.solver.add_constraint("allDifferent", ["a", "nope"])
        self.assertEqual(self.solver.constraints, before)
        self.assertEqual(self.solver.domains["a"], {1, 2})

    def test_duplicate_variable_in_scope_rejected(self):
        with self.assertRaises(SolverError):
            self.solver.add_constraint("allDifferent", ["a", "a"])
        with self.assertRaises(SolverError):
            self.solver.add_constraint("table", ["b", "b"], tuples=[[1, 1]])
        self.assertEqual(len(self.solver.constraints), 0)

    def test_bad_tuple_arity_rejected(self):
        with self.assertRaises(SolverError):
            self.solver.add_constraint("table", ["a", "b"], tuples=[[1, 2, 3]])
        self.assertEqual(len(self.solver.constraints), 0)

    def test_duplicate_constraint_id_rejected(self):
        self.solver.add_constraint("allDifferent", ["a", "b"], cid="k")
        with self.assertRaises(SolverError):
            self.solver.add_constraint("allDifferent", ["a", "b"], cid="k")

    def test_remove_unknown_constraint_rejected(self):
        with self.assertRaises(SolverError):
            self.solver.remove_constraint("ghost")


if __name__ == "__main__":
    unittest.main()
