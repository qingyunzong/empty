import json
import unittest

from symdfa import Machine, check, verify_proof


def chain_pair(length):
    """Two equivalent chains; each product pair yields 3 product edges."""
    def chain(prefix):
        states = [f"{prefix}{i}" for i in range(length + 1)]
        transitions = {states[i]: [[i, i, states[i + 1]]] for i in range(length)}
        return Machine.create(states, states[0], [states[-1]], transitions)
    return chain("a"), chain("b")


class TestBudget(unittest.TestCase):
    def test_budget_exhaustion_and_per_edge_resume(self):
        a, b = chain_pair(6)
        full = check(a, b)
        self.assertEqual(full.status, "equivalent")
        total_edges = full.stats["new_edges"]
        self.assertGreater(total_edges, 3)

        # Resume one edge at a time; every unknown run consumes exactly 1.
        frontier = None
        consumed = 0
        for _ in range(total_edges):
            res = check(a, b, budget=1, frontier=frontier)
            if res.status == "unknown":
                consumed += 1
                self.assertEqual(res.stats["new_edges"], consumed)
                # Frontier survives a JSON round trip.
                frontier = json.loads(json.dumps(res.frontier))
            else:
                break
        self.assertEqual(res.status, "equivalent")
        self.assertEqual(res.stats["new_edges"], total_edges)
        self.assertEqual(verify_proof(a, b, res.proof), [])

    def test_budgeted_result_matches_unlimited(self):
        a, b = chain_pair(5)
        b = b.replace_transition("b3", 3, 3, 3, 3, "b0")
        unlimited = check(a, b)
        self.assertEqual(unlimited.status, "different")
        frontier = None
        while True:
            res = check(a, b, budget=4, frontier=frontier)
            if res.status != "unknown":
                break
            frontier = res.frontier
        self.assertEqual(res.status, "different")
        self.assertEqual(res.counterexample["word"],
                         unlimited.counterexample["word"])

    def test_zero_budget_still_finds_empty_word_difference(self):
        a = Machine.create(["q0"], "q0", ["q0"], {})
        b = Machine.create(["r0"], "r0", [], {})
        res = check(a, b, budget=0)
        self.assertEqual(res.status, "different")
        self.assertEqual(res.counterexample["word"], [])

    def test_zero_budget_unknown_with_frontier(self):
        a, b = chain_pair(3)
        res = check(a, b, budget=0)
        self.assertEqual(res.status, "unknown")
        self.assertIsNotNone(res.frontier)
        resumed = check(a, b, frontier=res.frontier)
        self.assertEqual(resumed.status, "equivalent")

    def test_frontier_bound_to_machine_versions(self):
        a, b = chain_pair(3)
        res = check(a, b, budget=1)
        a2 = a.add_transition("a0", 100, 200, "a0")
        with self.assertRaises(ValueError):
            check(a2, b, frontier=res.frontier)


if __name__ == "__main__":
    unittest.main()
