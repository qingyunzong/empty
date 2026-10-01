"""Acceptance A: two small shareable jobs are bin-packed onto one GPU."""

import unittest

from helpers import run, by_id


class TestShareablePacking(unittest.TestCase):
    def test_two_shareable_jobs_share_one_gpu(self):
        instance = {
            "gpus": [
                {"id": "g0", "mem": 10, "sm": 10},
                # g1 is too small for either job, forcing packing on g0.
                {"id": "g1", "mem": 1, "sm": 1},
            ],
            "requests": [
                {"id": "a", "mem": 2, "sm": 2, "shareable": True,
                 "preemptible": False, "arrival": 0, "duration": 3},
                {"id": "b", "mem": 3, "sm": 3, "shareable": True,
                 "preemptible": False, "arrival": 0, "duration": 2},
            ],
        }
        result = run(instance)
        self.assertEqual(result["status"], "OK")
        jobs = by_id(result)
        # Both jobs land on g0 and overlap in time (2+3 <= 10 mem/sm).
        self.assertEqual(jobs["a"]["gpu"], "g0")
        self.assertEqual(jobs["b"]["gpu"], "g0")
        # One start per GPU per tick: a starts at 0, b at 1.
        self.assertEqual(jobs["a"]["start"], 0)
        self.assertEqual(jobs["a"]["end"], 3)
        self.assertEqual(jobs["b"]["start"], 1)
        self.assertEqual(jobs["b"]["end"], 3)
        self.assertEqual(jobs["a"]["preemptions"], 0)
        self.assertEqual(jobs["b"]["preemptions"], 0)
        self.assertEqual(result["objective"], 6)


if __name__ == "__main__":
    unittest.main()
