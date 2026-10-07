import unittest

from exactcount import Problem, Solver
from exactcount.reference import brute_force_count

EQ3 = [[0, 0], [1, 1], [2, 2]]


def _has_type(node, kind):
    if node["type"] == kind:
        return True
    return any(_has_type(c, kind) for c in node.get("children", []))


class ComponentTest(unittest.TestCase):
    def test_factorization_matches_brute_force(self):
        # Two independent constrained pairs plus one free variable.
        pdict = {
            "variables": {v: [0, 1, 2] for v in "abcde"},
            "constraints": [
                {"scope": ["a", "b"], "tuples": EQ3},
                {"scope": ["c", "d"], "tuples": [[0, 1], [1, 2], [2, 0]]},
            ],
        }
        solver = Solver(Problem.from_dict(pdict))
        result = solver.solve()
        self.assertEqual(result["exact"], brute_force_count(pdict))
        self.assertEqual(result["exact"], 3 * 3 * 3)
        self.assertTrue(_has_type(solver.certificate()["tree"], "decompose"))

    def test_component_merge_and_resplit(self):
        problem = Problem({"x": [0, 1, 2], "y": [0, 1, 2], "z": [0, 1, 2]})
        problem.add_constraint(["x", "y"], EQ3)
        solver = Solver(problem)

        split = solver.solve()
        self.assertEqual(split["exact"], 9)  # 3 (x=y) * 3 (z free)
        self.assertTrue(_has_type(solver.certificate()["tree"], "decompose"))

        # Merge the two components with a bridging constraint.
        bridge = problem.add_constraint(["y", "z"], EQ3)
        merged = solver.solve()
        self.assertEqual(merged["exact"], 3)
        self.assertFalse(_has_type(solver.certificate()["tree"], "decompose"))

        # Revoke the bridge: components split again, count goes back up.
        problem.remove_constraint(bridge)
        resplit = solver.solve()
        self.assertEqual(resplit["exact"], 9)
        self.assertTrue(_has_type(solver.certificate()["tree"], "decompose"))

    def test_constraint_revocation_increases_count(self):
        problem = Problem({"x": [0, 1, 2], "y": [0, 1, 2]})
        cid = problem.add_constraint(["x", "y"], EQ3)
        solver = Solver(problem)
        constrained = solver.solve()
        self.assertEqual(constrained["exact"], 3)

        problem.remove_constraint(cid)
        relaxed = solver.solve()
        self.assertEqual(relaxed["exact"], 9)
        self.assertGreater(relaxed["exact"], constrained["exact"])

    def test_added_constraint_decreases_count(self):
        problem = Problem({"x": [0, 1, 2], "y": [0, 1, 2]})
        solver = Solver(problem)
        before = solver.solve()
        self.assertEqual(before["exact"], 9)
        problem.add_constraint(["x", "y"], [[0, 0]])
        after = solver.solve()
        self.assertEqual(after["exact"], 1)
        self.assertLess(after["exact"], before["exact"])


if __name__ == "__main__":
    unittest.main()
