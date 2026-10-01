import random
import unittest

from symdfa import check_equivalence, UNKNOWN
from tests._reference import random_dfa, reference_witness


def run_with_edge_budget(dfa1, dfa2, step=1):
    """Feed the budget one edge at a time, resuming from the frontier.

    A single product state can cost more than ``step`` edges to expand;
    when no progress is possible the allowance is raised just enough to
    expand that one state.
    """
    state = None
    calls = 0
    allowance = step
    prev_used = 0
    while True:
        res = check_equivalence(dfa1, dfa2, budget=allowance, resume=state)
        calls += 1
        if res.status != UNKNOWN:
            return res, calls
        state = res.state
        if res.edges_used > prev_used:
            allowance = step  # progress was made, keep trickling
        else:
            allowance += 1    # stalled: one state costs more, grow slowly
        prev_used = res.edges_used


class TestBudget(unittest.TestCase):
    def test_unknown_carries_resumable_frontier(self):
        rng = random.Random(11)
        dfa1 = random_dfa(rng, 4)
        dfa2 = random_dfa(rng, 4)
        res = check_equivalence(dfa1, dfa2, budget=0)
        full = check_equivalence(dfa1, dfa2)
        if full.edges_used > 0:
            self.assertEqual(res.status, UNKNOWN)
            self.assertIsNotNone(res.state)
            self.assertTrue(len(res.state.frontier) >= 1)

    def test_per_edge_resume_matches_unlimited(self):
        rng = random.Random(99)
        for trial in range(60):
            dfa1 = random_dfa(rng, rng.randint(1, 4))
            dfa2 = random_dfa(rng, rng.randint(1, 4))
            limited, calls = run_with_edge_budget(dfa1, dfa2, step=1)
            full = check_equivalence(dfa1, dfa2)
            self.assertEqual(limited.status, full.status, f"trial {trial}")
            self.assertEqual(limited.witness, full.witness, f"trial {trial}")
            self.assertEqual(limited.edges_used, full.edges_used,
                             f"trial {trial}")

    def test_budget_counts_new_product_edges(self):
        rng = random.Random(5)
        dfa1 = random_dfa(rng, 3)
        dfa2 = random_dfa(rng, 3)
        full = check_equivalence(dfa1, dfa2)
        # replay with exactly the required budget: must succeed
        res = check_equivalence(dfa1, dfa2, budget=full.edges_used)
        self.assertEqual(res.status, full.status)
        # one edge short (if any edges are needed) must report unknown
        if full.edges_used > 0:
            short = check_equivalence(dfa1, dfa2, budget=full.edges_used - 1)
            self.assertEqual(short.status, UNKNOWN)

    def test_resume_continues_edge_accounting(self):
        rng = random.Random(3)
        for _ in range(20):
            dfa1 = random_dfa(rng, 4)
            dfa2 = random_dfa(rng, 4)
            full = check_equivalence(dfa1, dfa2)
            resumed, _ = run_with_edge_budget(dfa1, dfa2, step=2)
            self.assertEqual(resumed.status, full.status)
            self.assertEqual(resumed.edges_used, full.edges_used)


if __name__ == "__main__":
    unittest.main()
