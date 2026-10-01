import unittest

from fdsolver import Solver, SolverError


def make_solver():
    s = Solver()
    s.add_variable("a", [1, 2])
    s.add_variable("b", [1, 2])
    s.add_variable("c", [1, 2, 3])
    return s


class TestPushPop(unittest.TestCase):
    def test_two_level_rollback_restores_domains(self):
        s = make_solver()
        s.push()
        s.add_constraint("allDifferent", ["a", "b", "c"], cid="ad")
        self.assertEqual(s.domains["c"], {3})
        s.push()
        s.add_constraint("table", ["a", "c"], tuples=[[1, 3]], cid="t")
        self.assertEqual(s.domains["a"], {1})
        self.assertEqual(s.domains["b"], {2})
        # inner pop: table constraint and its removals are gone
        s.pop()
        self.assertEqual(s.domains["a"], {1, 2})
        self.assertEqual(s.domains["b"], {1, 2})
        self.assertEqual(s.domains["c"], {3})
        self.assertNotIn("t", s.constraints)
        # outer pop: allDifferent removals are gone too
        s.pop()
        self.assertEqual(s.domains["c"], {1, 2, 3})
        self.assertEqual(len(s.constraints), 0)

    def test_pop_restores_support_info(self):
        s = make_solver()
        s.add_constraint("table", ["a", "c"],
                         tuples=[[1, 1], [1, 3], [2, 3]], cid="t")
        full_support = list(s.constraints["t"].valid_tuples)
        s.push()
        s.add_constraint("allDifferent", ["a", "b", "c"], cid="ad")
        # c is now {3}: tuple (1,1) lost its support
        self.assertLess(len(s.constraints["t"].valid_tuples),
                        len(full_support))
        s.pop()
        self.assertEqual(s.constraints["t"].valid_tuples, full_support)
        # the table alone supports only c in {1, 3}
        self.assertEqual(s.domains["c"], {1, 3})

    def test_pop_on_empty_stack_rejected(self):
        s = make_solver()
        with self.assertRaises(SolverError):
            s.pop()

    def test_remove_constraint_restores_values(self):
        s = make_solver()
        cid = s.add_constraint("allDifferent", ["a", "b", "c"])
        self.assertEqual(s.domains["c"], {3})
        s.remove_constraint(cid)
        self.assertEqual(s.domains["c"], {1, 2, 3})
        self.assertEqual(s.domains["a"], {1, 2})

    def test_remove_constraint_keeps_other_derived_removals(self):
        s = make_solver()
        cid_ad = s.add_constraint("allDifferent", ["a", "b", "c"])
        s.add_constraint("table", ["a", "c"], tuples=[[1, 3]], cid="t")
        self.assertEqual(s.domains["a"], {1})
        s.remove_constraint(cid_ad)
        # The table constraint still holds: (a,c) must be (1,3).
        self.assertEqual(s.domains["a"], {1})
        self.assertEqual(s.domains["c"], {3})
        self.assertEqual(s.domains["b"], {1, 2})

    def test_nested_push_pop_with_decisions(self):
        s = make_solver()
        s.add_constraint("allDifferent", ["a", "b", "c"], cid="ad")
        s.push()
        s.assign("a", 1)
        self.assertEqual(s.domains["b"], {2})
        s.pop()
        self.assertEqual(s.domains["a"], {1, 2})
        self.assertEqual(s.domains["b"], {1, 2})


if __name__ == "__main__":
    unittest.main()
