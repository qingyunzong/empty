import json
import unittest

from exactcount import Problem, Solver
from exactcount.reference import brute_force_count

EQ3 = [[0, 0], [1, 1], [2, 2]]
SHIFT3 = [[0, 1], [1, 2], [2, 0]]


class CacheKeyTest(unittest.TestCase):
    """Canonical cache keys must distinguish any two subproblems that differ
    in domains, tuples, scope or constraint version (no key collisions)."""

    def setUp(self):
        self.problem = Problem({v: [0, 1, 2] for v in "xyz"})
        self.c1 = self.problem.add_constraint(["x", "y"], EQ3)
        self.solver = Solver(self.problem)

    def _key(self, cids, domains):
        node = {"context": sorted(domains), "cids": sorted(cids), "domains": domains}
        return self.solver._cache_key(node)

    def test_identical_subproblems_share_key(self):
        domains = {"x": [0, 1, 2], "y": [0, 1, 2]}
        self.assertEqual(self._key([self.c1], domains), self._key([self.c1], domains))

    def test_domain_difference_changes_key(self):
        base = {"x": [0, 1, 2], "y": [0, 1, 2]}
        shrunk = {"x": [0, 1], "y": [0, 1, 2]}
        self.assertNotEqual(self._key([self.c1], base), self._key([self.c1], shrunk))

    def test_tuple_difference_changes_key(self):
        c2 = self.problem.add_constraint(["x", "y"], SHIFT3)
        domains = {"x": [0, 1, 2], "y": [0, 1, 2]}
        self.assertNotEqual(self._key([self.c1], domains), self._key([c2], domains))

    def test_version_difference_changes_key(self):
        domains = {"x": [0, 1, 2], "y": [0, 1, 2]}
        before = self._key([self.c1], domains)
        # Re-inserting the identical constraint yields a new id/version pair.
        self.problem.remove_constraint(self.c1)
        c_new = self.problem.add_constraint(["x", "y"], EQ3)
        after = self._key([c_new], domains)
        self.assertNotEqual(before, after)

    def test_key_carries_domains_and_constraint_versions(self):
        key = json.loads(self._key([self.c1], {"x": [0, 1], "y": [0, 1, 2]}))
        self.assertIn(["x", [0, 1]], key["domains"])
        self.assertIn(["y", [0, 1, 2]], key["domains"])
        versions = {c["id"]: c["version"] for c in key["constraints"]}
        self.assertEqual(versions, {self.c1: 1})


class CacheReuseTest(unittest.TestCase):
    def test_reuse_after_unrelated_change_only(self):
        # Two independent components: {a,b} and {c,d}.
        problem = Problem({v: [0, 1, 2] for v in "abcd"})
        problem.add_constraint(["a", "b"], EQ3)
        problem.add_constraint(["c", "d"], EQ3)
        solver = Solver(problem)
        first = solver.solve()
        self.assertEqual(first["exact"], 9)

        # Tighten only the {a,b} component; the {c,d} entry still has a
        # valid proof basis and must be reused.
        problem.add_constraint(["a", "b"], [[0, 0], [1, 1]])
        second = solver.solve()
        self.assertEqual(second["exact"], 2 * 3)
        self.assertGreaterEqual(solver.stats["cache_hits"], 1)

    def test_no_stale_reuse_after_related_change(self):
        problem = Problem({"x": [0, 1, 2], "y": [0, 1, 2]})
        cid = problem.add_constraint(["x", "y"], EQ3)
        solver = Solver(problem)
        self.assertEqual(solver.solve()["exact"], 3)

        problem.remove_constraint(cid)
        problem.add_constraint(["x", "y"], [[0, 0]])
        result = solver.solve()
        self.assertEqual(result["exact"], 1)  # not the stale 3

    def test_cache_entries_store_domains_and_versions(self):
        problem = Problem({"x": [0, 1, 2], "y": [0, 1, 2]})
        problem.add_constraint(["x", "y"], EQ3)
        solver = Solver(problem)
        solver.solve()
        self.assertTrue(solver.cache)
        for key in solver.cache:
            entry = json.loads(key)
            self.assertIn("domains", entry)
            self.assertTrue(all("version" in c for c in entry["constraints"]))

    def test_cache_hit_matches_brute_force(self):
        pdict = {
            "variables": {v: [0, 1, 2] for v in "abcd"},
            "constraints": [
                {"scope": ["a", "b"], "tuples": EQ3},
                {"scope": ["c", "d"], "tuples": SHIFT3},
            ],
        }
        problem = Problem.from_dict(pdict)
        solver = Solver(problem)
        solver.solve()
        # Force a full re-search (touch the problem) without changing content:
        # identical keys must hit and reproduce the exact count.
        cid = problem.add_constraint(["a", "b"], EQ3)
        problem.remove_constraint(cid)
        result = solver.solve()
        self.assertEqual(result["exact"], brute_force_count(pdict))
        self.assertGreaterEqual(solver.stats["cache_hits"], 1)


if __name__ == "__main__":
    unittest.main()
