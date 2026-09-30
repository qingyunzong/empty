import itertools
import random
import unittest
from math import inf

from budget_auth import solver
from budget_auth.model import Budget


def make_budgets(spec):
    return {bid: Budget(bid, quota, parent) for bid, quota, parent in spec}


class SharedParentTest(unittest.TestCase):
    def setUp(self):
        self.budgets = make_budgets([
            ("root", 100, None),
            ("a", 60, "root"),
            ("b", 60, "root"),
        ])

    def test_shared_parent_counted_once(self):
        # a and b each have 60, but they share root's 100.  A request of 80
        # must not pass "separately per budget" -- the parent is charged
        # once for the whole request.
        prob = solver.build_problem(self.budgets, {}, {"a": inf, "b": inf})
        alloc = prob.solve(80)
        self.assertEqual(sum(alloc.values()), 80)
        # and 120 must fail even though 60+60 >= 120 per-budget
        with self.assertRaises(solver.AllocationRejected):
            prob.solve(120)

    def test_multi_path_inheritance_single_charge(self):
        # splitting across a and b charges root only by the total
        prob = solver.build_problem(self.budgets, {"root": 40, "a": 20},
                                    {"a": inf, "b": inf})
        alloc = prob.solve(50)
        total_on_root = sum(alloc.values())
        self.assertLessEqual(40 + total_on_root, 100)

    def test_fewest_budgets_preferred(self):
        prob = solver.build_problem(self.budgets, {}, {"a": inf, "b": inf})
        alloc = prob.solve(50)
        self.assertEqual(alloc, {"a": 50})  # one budget, smallest id

    def test_deterministic_id_order_tiebreak(self):
        prob = solver.build_problem(self.budgets, {}, {"b": inf, "a": inf})
        self.assertEqual(prob.solve(50), {"a": 50})
        self.assertEqual(prob.solve(50), prob.solve(50))

    def test_split_when_single_budget_insufficient(self):
        prob = solver.build_problem(self.budgets, {}, {"a": inf, "b": inf})
        alloc = prob.solve(90)
        self.assertEqual(alloc, {"a": 60, "b": 30})


class EnumerationTest(unittest.TestCase):
    """<=6 budgets: solver enumeration must equal brute force."""

    def brute_force(self, budgets, held, caps, amount):
        bids = sorted(caps)
        chains = {}
        for b in bids:
            chain, node = [], b
            while node is not None:
                chain.append(node)
                node = budgets[node].parent
            chains[b] = chain
        out = set()
        for combo in itertools.product(range(amount + 1), repeat=len(bids)):
            if sum(combo) != amount:
                continue
            ok = True
            for b, x in zip(bids, combo):
                if x > caps[b]:
                    ok = False
            if not ok:
                continue
            nodes = set().union(*chains.values())
            for n in nodes:
                load = sum(x for b, x in zip(bids, combo) if n in chains[b])
                if held.get(n, 0) + load > budgets[n].quota:
                    ok = False
            if ok:
                out.add(tuple((b, x) for b, x in zip(bids, combo) if x))
        return out

    def test_enumeration_matches_brute_force(self):
        rng = random.Random(20260930)
        for trial in range(60):
            n = rng.randint(1, 6)
            ids = [f"b{i}" for i in range(n)]
            spec = []
            for i, bid in enumerate(ids):
                parent = rng.choice(ids[:i]) if i else None
                spec.append((bid, rng.randint(0, 8), parent))
            budgets = make_budgets(spec)
            held = {b: rng.randint(0, budgets[b].quota) for b in ids}
            eligible = rng.sample(ids, rng.randint(1, n))
            caps = {b: rng.choice([rng.randint(0, 6), inf]) for b in eligible}
            amount = rng.randint(1, 7)
            prob = solver.build_problem(budgets, held, caps)
            got = {tuple(sorted(a.items()))
                   for a in prob.enumerate_all(amount)}
            want = self.brute_force(budgets, held, caps, amount)
            self.assertEqual(got, want, f"trial {trial}")

    def test_solution_is_always_legal_and_optimal(self):
        rng = random.Random(7)
        for _ in range(80):
            n = rng.randint(1, 6)
            ids = [f"b{i}" for i in range(n)]
            spec = [(bid, rng.randint(0, 9),
                     rng.choice(ids[:i]) if i else None)
                    for i, bid in enumerate(ids)]
            budgets = make_budgets(spec)
            caps = {b: inf for b in rng.sample(ids, rng.randint(1, n))}
            amount = rng.randint(1, 8)
            prob = solver.build_problem(budgets, {}, caps)
            allocs = list(prob.enumerate_all(amount))
            if not allocs:
                with self.assertRaises(solver.AllocationRejected):
                    prob.solve(amount)
                continue
            best = prob.solve(amount)
            self.assertIn(best, allocs)
            min_count = min(len(a) for a in allocs)
            self.assertEqual(len(best), min_count)


class UnsatCoreTest(unittest.TestCase):
    def test_core_identifies_shared_parent(self):
        budgets = make_budgets([
            ("root", 100, None),
            ("a", 80, "root"),
            ("b", 80, "root"),
        ])
        prob = solver.build_problem(budgets, {"root": 60},
                                    {"a": inf, "b": inf})
        with self.assertRaises(solver.AllocationRejected) as ctx:
            prob.solve(50)
        core = ctx.exception.core
        # root (remaining 40) alone explains infeasibility
        self.assertEqual([c.budget for c in core.constraints], ["root"])
        self.assertEqual(core.max_allocatable, 40)
        self.assertTrue(prob.verify_core(50, core))

    def test_core_is_minimal_and_verifiable(self):
        rng = random.Random(99)
        for _ in range(50):
            n = rng.randint(1, 6)
            ids = [f"b{i}" for i in range(n)]
            spec = [(bid, rng.randint(0, 6),
                     rng.choice(ids[:i]) if i else None)
                    for i, bid in enumerate(ids)]
            budgets = make_budgets(spec)
            held = {b: rng.randint(0, budgets[b].quota) for b in ids}
            caps = {b: rng.choice([rng.randint(1, 5), inf])
                    for b in rng.sample(ids, rng.randint(1, n))}
            amount = rng.randint(1, 10)
            prob = solver.build_problem(budgets, held, caps)
            try:
                prob.solve(amount)
            except solver.AllocationRejected as rej:
                self.assertTrue(prob.verify_core(amount, rej.core))
                # numbers in the core must be internally consistent
                for c in rej.core.constraints:
                    if c.kind == "capacity":
                        self.assertEqual(c.quota - c.held, c.remaining)
            else:
                continue


if __name__ == "__main__":
    unittest.main()
