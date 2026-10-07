"""Acceptance D: cross-check the tick scheduler against an independent
event-loop reference implementation on randomized small instances
(<= 8 tickets, 2 workers)."""

import random
import tests._bootstrap  # noqa: F401  (sys.path setup)
import unittest

from ticketpool.reference import serve_reference
from ticketpool.scheduler import serve


def random_case(rng):
    group_names = ["a", "b", "c"][: rng.randint(1, 3)]
    cfg = {
        "workers": 2,
        "aging_step": rng.randint(1, 4),
        "boost": rng.randint(0, 3),
        "base_quota": {g: rng.randint(1, 2) for g in group_names},
    }
    count = rng.randint(0, 8)
    arrivals = sorted(rng.randint(0, 12) for _ in range(count))
    tickets = [
        {
            "id": i,
            "arrival": arrivals[i],
            "cost": rng.randint(1, 6),
            "group": rng.choice(group_names),
            "priority": rng.randint(0, 4),
        }
        for i in range(count)
    ]
    return cfg, tickets


class TestReferenceCrossCheck(unittest.TestCase):
    def test_matches_event_loop_reference(self):
        for seed in range(400):
            rng = random.Random(seed)
            cfg, tickets = random_case(rng)
            with self.subTest(seed=seed):
                self.assertEqual(serve(cfg, tickets), serve_reference(cfg, tickets))

    def test_all_results_completed_and_consistent(self):
        for seed in range(400, 450):
            rng = random.Random(seed)
            cfg, tickets = random_case(rng)
            results = serve(cfg, tickets)
            self.assertEqual(len(results), len(tickets))
            for result, source in zip(results, tickets):
                self.assertIsNotNone(result["start"])
                self.assertIsNotNone(result["end"])
                # non-preemptive: service span equals cost
                self.assertEqual(
                    result["end"] - result["start"] + 1, source["cost"]
                )
                # never served before arrival; single wait interval
                self.assertGreaterEqual(result["start"], source["arrival"])
                self.assertEqual(
                    result["waits"], [[source["arrival"], result["start"]]]
                )


if __name__ == "__main__":
    unittest.main()
