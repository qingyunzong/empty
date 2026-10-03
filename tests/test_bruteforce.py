# Acceptance D: random 20-node graphs checked against exhaustive
# 0-1 enumeration of every dirty-node subset.

import random
import unittest
from array import array

from recalc.core import RecalcGraph, _is_better


def brute_force_best(graph, budget):
    # Enumerate all 2^n subsets of dirty nodes and pick the optimum.
    dirty = sorted(graph.dirty_ids())
    count = len(dirty)
    nodes = graph._nodes
    costs = [nodes[nid].cost for nid in dirty]
    values = [nodes[nid].value for nid in dirty]
    index = {nid: i for i, nid in enumerate(dirty)}

    # Transitive dirty ancestors of each dirty node, as bitmasks.
    anc = [0] * count
    for i, nid in enumerate(dirty):
        mask = 0
        seen = set()
        stack = [nid]
        while stack:
            cur = stack.pop()
            for dep in nodes[cur].deps:
                j = index.get(dep)
                if j is not None and dep not in seen:
                    seen.add(dep)
                    mask |= 1 << j
                    stack.append(dep)
        anc[i] = mask

    total = 1 << count
    cost_of = array("q", [0])
    value_of = array("q", [0])
    need = [0]  # union of ancestor masks required by the subset
    best = (0, 0, 0)  # empty set
    for mask in range(1, total):
        lsb = mask & -mask
        i = lsb.bit_length() - 1
        prev = mask ^ lsb
        required = need[prev] | anc[i]
        need.append(required)
        cost = cost_of[prev] + costs[i]
        value = value_of[prev] + values[i]
        cost_of.append(cost)
        value_of.append(value)
        # Feasible iff every member's dirty ancestors are inside the set.
        ok = not (required & ~mask)
        if ok and cost <= budget and _is_better((value, mask, cost), best):
            best = (value, mask, cost)
    ids = tuple(dirty[r] for r in range(count) if best[1] >> r & 1)
    return ids, best[0], best[2]


def random_graph(rng, count):
    graph = RecalcGraph()
    ids = [f"n{i:02d}" for i in range(count)]
    rng.shuffle(ids)
    defined = []
    for nid in ids:
        deps = [d for d in defined if rng.random() < 0.25]
        graph.set_node(nid, rng.randint(0, 8), rng.randint(-3, 10), deps)
        defined.append(nid)
    # Randomly clean some nodes, then dirty a random subset via updates.
    if rng.random() < 0.5:
        graph.run(rng.randint(0, 30))
    for nid in rng.sample(ids, rng.randint(0, count)):
        graph.update_cost(nid, rng.randint(0, 8))
    return graph


class BruteForceComparisonTest(unittest.TestCase):
    def check(self, seed, count, trials):
        for trial in range(trials):
            rng = random.Random(f"{seed}:{count}:{trial}")
            graph = random_graph(rng, count)
            budget = rng.randint(0, 40)
            plan = graph.best(budget)
            ids, value, cost = brute_force_best(graph, budget)
            with self.subTest(seed=seed, count=count, trial=trial,
                              budget=budget):
                self.assertEqual(plan.ids, ids)
                self.assertEqual(plan.value, value)
                self.assertEqual(plan.cost, cost)

    def test_random_20_nodes_matches_brute_force(self):
        self.check(seed=20241001, count=20, trials=2)

    def test_random_14_nodes_matches_brute_force(self):
        self.check(seed=777, count=14, trials=6)

    def test_random_8_nodes_matches_brute_force(self):
        self.check(seed=42, count=8, trials=10)


if __name__ == "__main__":
    unittest.main()
