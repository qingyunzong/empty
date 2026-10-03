"""Canonical subproblem cache: reuse, validity, collisions, versioning."""

import unittest

from schcount import Cache, Constraint, Problem, Solver

from helpers import brute_force


def ab_cd_problem():
    p = Problem()
    for v in ("a", "b", "c", "d"):
        p.add_variable(v, [0, 1, 2])
    p.add_constraint(Constraint("c_ab", ("a", "b"), [(0, 1), (1, 2), (2, 0)]))
    p.add_constraint(Constraint("c_cd", ("c", "d"), [(0, 0), (1, 1)]))
    return p


class TestCacheReuse(unittest.TestCase):
    def test_second_solver_hits_cache(self):
        p = ab_cd_problem()
        cache = Cache()
        first = Solver(p, cache).solve()
        self.assertTrue(first["complete"])
        hits_before = cache.hits
        second = Solver(p, cache)
        result = second.solve()
        self.assertEqual(result["exact"], first["exact"])
        self.assertGreater(cache.hits, hits_before)

    def test_unaffected_entries_survive_constraint_change(self):
        p = ab_cd_problem()
        cache = Cache()
        Solver(p, cache).solve()
        p.add_constraint(Constraint("c_ab2", ("a", "b"), [(0, 1), (1, 2)]))
        solver = Solver(p, cache)
        result = solver.solve()
        self.assertEqual(result["exact"], brute_force(p))
        self.assertGreaterEqual(cache.hits, 1)
        self.assertGreaterEqual(cache.stale + cache.misses, 1)

    def test_revoked_constraint_invalidates_dependent_entries(self):
        p = ab_cd_problem()
        cache = Cache()
        Solver(p, cache).solve()
        p.remove_constraint("c_ab")
        solver = Solver(p, cache)
        result = solver.solve()
        self.assertEqual(result["exact"], brute_force(p))
        self.assertGreaterEqual(cache.hits, 1)

    def test_entry_carries_domains_and_version(self):
        p = ab_cd_problem()
        cache = Cache()
        Solver(p, cache).solve()
        self.assertTrue(cache.entries)
        for entry in cache.entries.values():
            self.assertIn("domains", entry)
            self.assertIn("constraint_version", entry)
            self.assertIn("constraints", entry)
            self.assertEqual(entry["constraint_version"], p.constraint_version)
            for vals in entry["domains"].values():
                self.assertTrue(all(isinstance(v, int) for v in vals))

    def test_stale_entry_rejected_after_content_change(self):
        p = Problem()
        p.add_variable("x", [0, 1])
        p.add_variable("y", [0, 1])
        p.add_constraint(Constraint("c", ("x", "y"), [(0, 0), (1, 1)]))
        cache = Cache()
        self.assertEqual(Solver(p, cache).solve()["exact"], 2)
        p.remove_constraint("c")
        p.add_constraint(Constraint("c2", ("x", "y"), [(0, 0), (1, 1)]))
        stale_before = cache.stale
        result = Solver(p, cache).solve()
        self.assertEqual(result["exact"], 2)
        self.assertGreater(cache.stale, stale_before)


class TestCacheKeyCollision(unittest.TestCase):
    def test_similar_subproblems_do_not_collide(self):
        # Same variable names and same domain sizes, but different domains
        # and tables: keys must stay distinct and counts must not leak
        # across entries.
        p1 = Problem()
        p1.add_variable("x", [0, 1, 2])
        p1.add_variable("y", [0, 1, 2])
        p1.add_constraint(Constraint("c", ("x", "y"), [(0, 0), (1, 1)]))

        p2 = Problem()
        p2.add_variable("x", [1, 2, 3])
        p2.add_variable("y", [1, 2, 3])
        p2.add_constraint(Constraint("c", ("x", "y"), [(1, 1), (2, 2), (3, 3)]))

        cache = Cache()
        cons1 = list(p1.constraints.values())
        cons2 = list(p2.constraints.values())
        d1 = {"x": [0, 1, 2], "y": [0, 1, 2]}
        d2 = {"x": [1, 2, 3], "y": [1, 2, 3]}
        cache.insert(p1, ["x", "y"], d1, cons1, 2)
        self.assertIsNone(cache.lookup(p2, ["x", "y"], d2, cons2))
        cache.insert(p2, ["x", "y"], d2, cons2, 3)
        self.assertEqual(cache.lookup(p1, ["x", "y"], d1, cons1), 2)
        self.assertEqual(cache.lookup(p2, ["x", "y"], d2, cons2), 3)
        self.assertEqual(len(cache.entries), 2)
        # End to end: a shared cache still yields correct counts.
        self.assertEqual(Solver(p1, cache).solve()["exact"], 2)
        self.assertEqual(Solver(p2, cache).solve()["exact"], 3)

    def test_same_vars_same_domains_different_table(self):
        p1 = Problem()
        p1.add_variable("x", [0, 1])
        p1.add_variable("y", [0, 1])
        p1.add_constraint(Constraint("c", ("x", "y"), [(0, 0), (1, 1)]))
        p2 = Problem()
        p2.add_variable("x", [0, 1])
        p2.add_variable("y", [0, 1])
        p2.add_constraint(Constraint("c", ("x", "y"), [(0, 1), (1, 0)]))
        cache = Cache()
        self.assertEqual(Solver(p1, cache).solve()["exact"], 2)
        self.assertEqual(Solver(p2, cache).solve()["exact"], 2)
        keys = {e["key"] for e in cache.entries.values()}
        self.assertEqual(len(keys), len(cache.entries))

    def test_cache_survives_checkpoint_roundtrip(self):
        p = ab_cd_problem()
        solver = Solver(p)
        solver.solve(budget=5)
        restored = Solver.from_checkpoint(solver.to_checkpoint())
        result = restored.solve()
        self.assertEqual(result["exact"], brute_force(p))


if __name__ == "__main__":
    unittest.main()
