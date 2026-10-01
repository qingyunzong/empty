"""Acceptance B: 3-node partition + recovery matches a hand-computed reference.

Topology: n1,n2,n3. Link latencies: n1->n2 = 5, n2->n1 = 5, n1->n3 = 7.
Partition between n1 and n2 during [10, 20): it blocks traffic in BOTH
directions on that edge only, buffering messages until t=20.

Workload (no randomness involved):
  t=0  n1->n2 m1  -> delivered at 5 (before partition)
  t=12 n1->n2 m2  -> buffered, released at 20, delivered at 25
  t=15 n2->n1 m3  -> buffered (reverse direction), delivered at 25
  t=12 n1->n3 m4  -> different edge, delivered at 19

Expected recv order: (5,m1), (19,m4), (25,m2), (25,m3); at t=25 m2 was
created before m3 so its seq is smaller and it delivers first.
"""

import unittest

from netsim.config import Faults
from netsim.sim import Simulator

from helpers import make_config


class TestPartitionRecovery(unittest.TestCase):
    def setUp(self):
        self.config = make_config(
            nodes=["n1", "n2", "n3"],
            links=[("n1", "n2", 5, 0), ("n2", "n1", 5, 0), ("n1", "n3", 7, 0)],
            workload=[
                (0, "n1", "n2", "m1", ""),
                (12, "n1", "n2", "m2", ""),
                (15, "n2", "n1", "m3", ""),
                (12, "n1", "n3", "m4", ""),
            ],
        )
        self.faults = Faults(partitions=[{"a": "n1", "b": "n2", "start": 10.0, "end": 20.0}])

    def test_hand_reference(self):
        sim = Simulator(self.config, self.faults, seed=1, max_steps=1000)
        summary = sim.run()
        recv = [(e["time"], e["app_id"]) for e in sim.events if e["type"] == "recv"]
        self.assertEqual(recv, [(5.0, "m1"), (19.0, "m4"), (25.0, "m2"), (25.0, "m3")])
        self.assertEqual(summary["delivered"], 4)
        self.assertEqual(summary["buffered"], 2)
        self.assertEqual(summary["dropped"], 0)

    def test_partition_blocks_both_directions_only_on_matching_edge(self):
        sim = Simulator(self.config, self.faults, seed=1, max_steps=1000)
        sim.run()
        buffered = [(e["app_id"], e["until"]) for e in sim.events if e["type"] == "buffered"]
        # m2 (n1->n2) and m3 (n2->n1) buffered; m4 (n1->n3) untouched.
        self.assertEqual(buffered, [("m2", 20.0), ("m3", 20.0)])

    def test_no_partition_baseline(self):
        sim = Simulator(self.config, Faults(), seed=1, max_steps=1000)
        sim.run()
        recv = [(e["time"], e["app_id"]) for e in sim.events if e["type"] == "recv"]
        self.assertEqual(recv, [(5.0, "m1"), (17.0, "m2"), (19.0, "m4"), (20.0, "m3")])


if __name__ == "__main__":
    unittest.main()
