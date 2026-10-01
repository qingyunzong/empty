import unittest

from netsim import Simulator
from support import mesh_topo


def build_topo(offsets):
    topo = mesh_topo(["n1", "n2", "n3"], delay=5,
                     **{nid: {"clock_offset": off} for nid, off in offsets.items()})
    topo["workload"] = [
        {"time": 0, "src": "n1", "dst": "n2", "app_id": "m1"},
        {"time": 1, "src": "n3", "dst": "n2", "app_id": "m2"},
        {"time": 2, "src": "n2", "dst": "n1", "app_id": "m3"},
    ]
    return topo


class TestClockOffset(unittest.TestCase):
    def test_timeout_fires_at_global_time_minus_offset(self):
        topo = mesh_topo(["n1", "n2"], delay=5,
                         n1={"clock_offset": 10,
                             "timeouts": [{"id": "t1", "at_local": 100}]})
        topo["workload"] = [{"time": 0, "src": "n1", "dst": "n2", "app_id": "m1"}]
        sim = Simulator(topo, {"rules": []}, seed=0)
        sim.run(1000)
        timeouts = [r for r in sim.records if r["type"] == "timeout"]
        self.assertEqual(len(timeouts), 1)
        self.assertEqual(timeouts[0]["time"], 90)        # 100 - offset(10)
        self.assertEqual(timeouts[0]["local_time"], 100)  # reads local clock

    def test_offsets_do_not_change_global_event_order(self):
        plain = Simulator(build_topo({"n1": 0, "n2": 0, "n3": 0}),
                          {"rules": []}, seed=0)
        skewed = Simulator(build_topo({"n1": 7, "n2": -3, "n3": 100}),
                           {"rules": []}, seed=0)
        plain.run(1000)
        skewed.run(1000)

        def global_view(records):
            return [(r["type"], r.get("app_id"), r["time"], r.get("src"),
                     r.get("dst")) for r in records]

        self.assertEqual(global_view(plain.records), global_view(skewed.records))
        # Local times differ exactly by the offsets.
        plain_deliver = [r for r in plain.records if r["type"] == "deliver"]
        skewed_deliver = [r for r in skewed.records if r["type"] == "deliver"]
        for p, s in zip(plain_deliver, skewed_deliver):
            self.assertEqual(p["time"], s["time"])
        self.assertNotEqual(
            [r["local_time"] for r in plain_deliver],
            [r["local_time"] for r in skewed_deliver])

    def test_clock_rule_reoffsets_node_mid_run(self):
        topo = mesh_topo(["n1", "n2"], delay=5)
        topo["workload"] = [
            {"time": 0, "src": "n1", "dst": "n2", "app_id": "m1"},
            {"time": 10, "src": "n1", "dst": "n2", "app_id": "m2"},
        ]
        faults = {"rules": [{"type": "clock", "node": "n2", "offset": 50,
                             "start": 6}]}
        sim = Simulator(topo, faults, seed=0)
        sim.run(1000)
        delivers = [r for r in sim.records if r["type"] == "deliver"]
        # Global arrival times are untouched by the clock fault...
        self.assertEqual([r["time"] for r in delivers], [5, 15])
        # ...but the second delivery is stamped on the shifted local clock.
        self.assertEqual([r["local_time"] for r in delivers], [5, 65])


if __name__ == "__main__":
    unittest.main()
