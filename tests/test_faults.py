import unittest

from netsim import Simulator
from support import mesh_topo


def topo_with_workload():
    topo = mesh_topo(["n1", "n2"], delay=5)
    topo["workload"] = [
        {"time": t, "src": "n1", "dst": "n2", "app_id": f"m{t}"}
        for t in range(0, 20)
    ]
    return topo


class TestFaultPhaseOrder(unittest.TestCase):
    def test_phase_order_independent_of_rule_listing_order(self):
        rules = [
            {"type": "drop", "src": "n1", "dst": "n2", "prob": 0.5},
            {"type": "dup", "prob": 0.5},
            {"type": "delay", "extra": 3},
        ]
        shuffled = [dict(rules[2]), dict(rules[0]), dict(rules[1])]
        sim_a = Simulator(topo_with_workload(), {"rules": rules}, seed=7)
        sim_b = Simulator(topo_with_workload(), {"rules": shuffled}, seed=7)
        self.assertEqual(sim_a.run(1000), sim_b.run(1000))
        self.assertEqual(sim_a.records, sim_b.records)

    def test_drop_runs_before_dup(self):
        # If drop did not run first, dup would emit copies of a dead message.
        rules = [
            {"type": "dup", "prob": 1.0},
            {"type": "drop", "prob": 1.0},
        ]
        sim = Simulator(topo_with_workload(), {"rules": rules}, seed=1)
        summary = sim.run(1000)
        self.assertEqual(summary["dropped"], 20)
        self.assertEqual(summary["delivered"], 0)
        self.assertEqual(summary["dup_copies"], 0)
        self.assertFalse(any(r["type"] == "dup" for r in sim.records))

    def test_dup_runs_before_delay_so_copies_share_extra_delay(self):
        rules = [
            {"type": "delay", "extra": 10},
            {"type": "dup", "prob": 1.0},
        ]
        topo = mesh_topo(["n1", "n2"], delay=5)
        topo["workload"] = [{"time": 0, "src": "n1", "dst": "n2", "app_id": "m1"}]
        sim = Simulator(topo, {"rules": rules}, seed=1)
        sim.run(1000)
        arrivals = [r for r in sim.records if r["type"] in ("deliver", "duplicate")]
        self.assertEqual(len(arrivals), 2)
        self.assertEqual([r["time"] for r in arrivals], [15, 15])

    def test_fault_window_matching(self):
        rules = [{"type": "drop", "prob": 1.0, "start": 5, "end": 10}]
        sim = Simulator(topo_with_workload(), {"rules": rules}, seed=1)
        summary = sim.run(1000)
        # sends at t in [5, 10) are dropped: t = 5..9
        self.assertEqual(summary["dropped"], 5)
        self.assertEqual(summary["delivered"], 15)


if __name__ == "__main__":
    unittest.main()
