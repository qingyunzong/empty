"""Acceptance C: duplicate deliveries are deduplicated by application id."""

import unittest

from netsim.config import Faults
from netsim.sim import Simulator

from helpers import make_config


class TestDedup(unittest.TestCase):
    def test_dup_fault_deduped_by_app_id(self):
        config = make_config(
            nodes=["n1", "n2"],
            links=[("n1", "n2", 2, 0)],
            workload=[(0, "n1", "n2", "m1", "x"), (1, "n1", "n2", "m2", "y")],
        )
        faults = Faults(dup=[{"src": "n1", "dst": "n2", "rate": 1.0, "copies": 2}])
        sim = Simulator(config, faults, seed=0, max_steps=1000)
        summary = sim.run()
        # Each message is duplicated into 3 copies; only the first copy of
        # each app_id is delivered to the application.
        self.assertEqual(summary["sent"], 2)
        self.assertEqual(summary["duplicated"], 4)
        self.assertEqual(summary["delivered"], 2)
        self.assertEqual(summary["dup_ignored"], 4)
        recv_ids = [e["app_id"] for e in sim.events if e["type"] == "recv"]
        self.assertEqual(recv_ids, ["m1", "m2"])
        ignored = [e["app_id"] for e in sim.events if e["type"] == "dup_ignored"]
        self.assertEqual(ignored, ["m1", "m1", "m2", "m2"])

    def test_same_app_id_from_workload_is_also_deduped(self):
        config = make_config(
            nodes=["n1", "n2"],
            links=[("n1", "n2", 1, 0)],
            workload=[(0, "n1", "n2", "m1", "a"), (5, "n1", "n2", "m1", "b")],
        )
        sim = Simulator(config, Faults(), seed=0, max_steps=1000)
        summary = sim.run()
        self.assertEqual(summary["delivered"], 1)
        self.assertEqual(summary["dup_ignored"], 1)


if __name__ == "__main__":
    unittest.main()
