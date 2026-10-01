"""Acceptance C: a non-shareable big job conflicts with a shareable job;
the optimal order runs the short shareable job first."""

import unittest

from helpers import run, by_id


class TestConflictOrdering(unittest.TestCase):
    def test_big_nonshareable_vs_small_shareable(self):
        instance = {
            "gpus": [{"id": "g0", "mem": 10, "sm": 10}],
            "requests": [
                # Higher priority (smaller id at equal arrival) but not
                # preemptible-aware: once it starts it owns the GPU.
                {"id": "big", "mem": 10, "sm": 10, "shareable": False,
                 "preemptible": False, "arrival": 0, "duration": 4},
                {"id": "small", "mem": 2, "sm": 2, "shareable": True,
                 "preemptible": False, "arrival": 0, "duration": 1},
            ],
        }
        result = run(instance)
        self.assertEqual(result["status"], "OK")
        jobs = by_id(result)
        # Optimal order: small first (ends at 1), then big (1..5).
        # The reverse order would give objective 4 + 5 = 9 > 6.
        self.assertEqual(jobs["small"]["start"], 0)
        self.assertEqual(jobs["small"]["end"], 1)
        self.assertEqual(jobs["big"]["start"], 1)
        self.assertEqual(jobs["big"]["end"], 5)
        self.assertEqual(result["objective"], 6)

    def test_preemptible_big_gets_evicted_by_priority(self):
        # Same shape, but now the big job is preemptible and the small
        # job arrives later (hence higher priority) and needs the card.
        instance = {
            "gpus": [{"id": "g0", "mem": 10, "sm": 10}],
            "requests": [
                {"id": "big", "mem": 10, "sm": 10, "shareable": False,
                 "preemptible": True, "arrival": 0, "duration": 4},
                {"id": "small", "mem": 10, "sm": 10, "shareable": False,
                 "preemptible": False, "arrival": 1, "duration": 1},
            ],
        }
        result = run(instance)
        jobs = by_id(result)
        # small evicts big at t=1, runs 1..2; big resumes at 2 with
        # 3 remaining + 1 restart tick -> ends at 6.
        self.assertEqual(jobs["small"]["start"], 1)
        self.assertEqual(jobs["small"]["end"], 2)
        self.assertEqual(jobs["big"]["preemptions"], 1)
        self.assertEqual(jobs["big"]["end"], 6)
        self.assertEqual(result["objective"], 8)


if __name__ == "__main__":
    unittest.main()
