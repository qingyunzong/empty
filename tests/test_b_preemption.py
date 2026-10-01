"""Acceptance B: a higher-priority arrival evicts a lower-priority job;
the evicted job keeps its remaining work and pays a 1-tick restart."""

import unittest

from helpers import run, by_id


class TestPreemptionRestart(unittest.TestCase):
    def test_eviction_and_one_tick_restart(self):
        instance = {
            "gpus": [{"id": "g0", "mem": 10, "sm": 10}],
            "requests": [
                # Runs first; lower priority because it arrives earlier.
                {"id": "A", "mem": 4, "sm": 4, "shareable": True,
                 "preemptible": True, "arrival": 0, "duration": 10},
                # Arrives at t=2 -> strictly higher priority; needs the
                # whole GPU, so it must evict A.
                {"id": "B", "mem": 10, "sm": 10, "shareable": False,
                 "preemptible": False, "arrival": 2, "duration": 2},
            ],
        }
        result = run(instance)
        self.assertEqual(result["status"], "OK")
        jobs = by_id(result)
        # B takes over the GPU as soon as it arrives.
        self.assertEqual(jobs["B"]["start"], 2)
        self.assertEqual(jobs["B"]["end"], 4)
        self.assertEqual(jobs["B"]["preemptions"], 0)
        # A is evicted once at t=2 with 8 ticks of work remaining.
        self.assertEqual(jobs["A"]["preemptions"], 1)
        self.assertEqual(jobs["A"]["start"], 0)
        self.assertEqual(jobs["A"]["gpu"], "g0")
        # A restarts at t=4 (GPU busy until then) and pays 1 restart tick:
        # end = 4 + 8 remaining + 1 restart = 13.
        self.assertEqual(jobs["A"]["end"], 13)
        self.assertEqual(result["objective"], 4 + 13)

    def test_preemption_is_optimal_here(self):
        # Not evicting would give objective 10 + 12 = 22 > 17.
        instance = {
            "gpus": [{"id": "g0", "mem": 10, "sm": 10}],
            "requests": [
                {"id": "A", "mem": 4, "sm": 4, "shareable": True,
                 "preemptible": True, "arrival": 0, "duration": 10},
                {"id": "B", "mem": 10, "sm": 10, "shareable": False,
                 "preemptible": False, "arrival": 2, "duration": 2},
            ],
        }
        result = run(instance)
        self.assertLess(result["objective"], 22)


if __name__ == "__main__":
    unittest.main()
