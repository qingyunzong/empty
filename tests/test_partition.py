import unittest

from netsim import Simulator
from support import mesh_topo


def build_topo():
    topo = mesh_topo(["n1", "n2", "n3"], delay=5)
    topo["workload"] = [
        {"time": 0, "src": "n1", "dst": "n2", "app_id": "m1"},
        {"time": 1, "src": "n1", "dst": "n3", "app_id": "m2"},
        {"time": 2, "src": "n2", "dst": "n1", "app_id": "m3"},
        {"time": 25, "src": "n1", "dst": "n2", "app_id": "m4"},
    ]
    return topo


PARTITION = {"type": "partition",
             "edges": [["n1", "n2"], ["n2", "n1"]], "start": 3, "end": 20}


class TestPartitionRecovery(unittest.TestCase):
    def test_three_node_partition_recovery_matches_reference(self):
        # Hand-computed reference:
        #   m1 n1->n2 sent@0, arrives@5   -> blocked, buffered
        #   m2 n1->n3 sent@1, arrives@6   -> delivered
        #   m3 n2->n1 sent@2, arrives@7   -> blocked, buffered
        #   partition ends@20             -> m1, m3 released FIFO, delivered@20
        #   m4 n1->n2 sent@25, arrives@30 -> delivered
        sim = Simulator(build_topo(), {"rules": [PARTITION]}, seed=0)
        summary = sim.run(1000)
        delivered = [(r["app_id"], r["time"])
                     for r in sim.records if r["type"] == "deliver"]
        self.assertEqual(delivered,
                         [("m2", 6), ("m1", 20), ("m3", 20), ("m4", 30)])
        self.assertEqual(summary["logs"],
                         {"n1": ["m3"], "n2": ["m1", "m4"], "n3": ["m2"]})
        self.assertEqual(summary["buffered"], 2)
        self.assertEqual(summary["released"], 2)
        self.assertEqual(summary["buffered_remaining"], 0)
        self.assertEqual(summary["delivered"], 4)

    def test_unidirectional_edges_block_nothing(self):
        one_way = dict(PARTITION, edges=[["n1", "n2"]])
        sim = Simulator(build_topo(), {"rules": [one_way]}, seed=0)
        summary = sim.run(1000)
        self.assertEqual(summary["buffered"], 0)
        delivered = [(r["app_id"], r["time"])
                     for r in sim.records if r["type"] == "deliver"]
        self.assertEqual(delivered,
                         [("m1", 5), ("m2", 6), ("m3", 7), ("m4", 30)])

    def test_buffer_survives_overlapping_partitions(self):
        second = {"type": "partition",
                  "edges": [["n1", "n2"], ["n2", "n1"]], "start": 10, "end": 40}
        sim = Simulator(build_topo(), {"rules": [PARTITION, second]}, seed=0)
        summary = sim.run(1000)
        # Hand-computed reference:
        #   m1 arrives@5  -> buffered (partition 1 active)
        #   m2 arrives@6  -> delivered
        #   m3 arrives@7  -> buffered
        #   partition 1 ends@20, but partition 2 (10..40) still blocks -> none released
        #   m4 arrives@30 -> buffered
        #   partition 2 ends@40 -> m1, m3, m4 released FIFO
        delivered = [(r["app_id"], r["time"])
                     for r in sim.records if r["type"] == "deliver"]
        self.assertEqual(delivered,
                         [("m2", 6), ("m1", 40), ("m3", 40), ("m4", 40)])
        self.assertEqual(summary["buffered_remaining"], 0)


if __name__ == "__main__":
    unittest.main()
