import unittest

from netsim import Simulator
from support import mesh_topo


class TestDedupByAppId(unittest.TestCase):
    def test_dup_fault_copies_are_deduped_by_app_id(self):
        topo = mesh_topo(["n1", "n2"], delay=5)
        topo["workload"] = [{"time": 0, "src": "n1", "dst": "n2", "app_id": "m1"}]
        faults = {"rules": [{"type": "dup", "prob": 1.0}]}
        sim = Simulator(topo, faults, seed=0)
        summary = sim.run(1000)
        arrivals = [r for r in sim.records
                    if r["type"] in ("deliver", "duplicate")]
        self.assertEqual([r["type"] for r in arrivals], ["deliver", "duplicate"])
        self.assertEqual([r["copy"] for r in arrivals], [0, 1])
        # Application-level dedup: the log holds the message exactly once.
        self.assertEqual(summary["logs"]["n2"], ["m1"])
        self.assertEqual(summary["delivered"], 1)
        self.assertEqual(summary["duplicates_ignored"], 1)
        self.assertEqual(summary["dup_copies"], 1)

    def test_same_app_id_from_workload_is_deduped(self):
        topo = mesh_topo(["n1", "n2"], delay=5)
        topo["workload"] = [
            {"time": 0, "src": "n1", "dst": "n2", "app_id": "m1"},
            {"time": 1, "src": "n1", "dst": "n2", "app_id": "m1"},
        ]
        sim = Simulator(topo, {"rules": []}, seed=0)
        summary = sim.run(1000)
        self.assertEqual(summary["logs"]["n2"], ["m1"])
        self.assertEqual(summary["delivered"], 1)
        self.assertEqual(summary["duplicates_ignored"], 1)

    def test_distinct_app_ids_are_not_deduped(self):
        topo = mesh_topo(["n1", "n2"], delay=5)
        topo["workload"] = [
            {"time": 0, "src": "n1", "dst": "n2", "app_id": "m1"},
            {"time": 1, "src": "n1", "dst": "n2", "app_id": "m2"},
        ]
        sim = Simulator(topo, {"rules": []}, seed=0)
        summary = sim.run(1000)
        self.assertEqual(summary["logs"]["n2"], ["m1", "m2"])
        self.assertEqual(summary["duplicates_ignored"], 0)


if __name__ == "__main__":
    unittest.main()
