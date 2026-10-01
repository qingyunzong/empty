"""Acceptance A: a fixed seed must produce identical summaries across runs."""

import unittest

from netsim.config import Faults
from netsim.sim import Simulator, check_determinism

from helpers import make_config


def build():
    config = make_config(
        nodes=["n1", "n2", "n3"],
        links=[("n1", "n2", 3, 2), ("n2", "n1", 4, 1), ("n1", "n3", 2, 0), ("n3", "n2", 5, 3)],
        clock_offsets={"n2": 7, "n3": -3},
        timeout_intervals={"n1": 25, "n3": 40},
        workload=[
            (0, "n1", "n2", "m1", "a"),
            (1, "n1", "n2", "m2", "b"),
            (2, "n2", "n1", "m3", "c"),
            (3, "n1", "n3", "m4", "d"),
            (4, "n3", "n2", "m5", "e"),
            (5, "n1", "n2", "m6", "f"),
            (6, "n2", "n1", "m7", "g"),
            (7, "n3", "n2", "m8", "h"),
        ],
    )
    faults = Faults(
        drop=[{"src": "n1", "dst": "n2", "rate": 0.4}],
        dup=[{"src": "*", "dst": "n2", "rate": 0.5, "copies": 2}],
        delay=[{"src": "n3", "dst": "*", "extra": 6}],
        clock_apply=[{"node": "n2", "offset": 30, "at": 10}],
    )
    return config, faults


class TestDeterminism(unittest.TestCase):
    def test_same_seed_same_summary(self):
        config, faults = build()
        sim1 = Simulator(config, faults, seed=3, max_steps=1000)
        sim2 = Simulator(config, faults, seed=3, max_steps=1000)
        summary1 = sim1.run()
        summary2 = sim2.run()
        self.assertEqual(summary1, summary2)
        self.assertEqual(sim1.events, sim2.events)
        self.assertEqual(sim1.node_logs, sim2.node_logs)

    def test_check_determinism_ok(self):
        config, faults = build()
        self.assertEqual(check_determinism(config, faults, steps=1000, seed=3), "OK")

    def test_event_heap_ordering_key(self):
        # Events must be emitted in non-decreasing (time, seq) order.
        config, faults = build()
        sim = Simulator(config, faults, seed=3, max_steps=1000)
        sim.run()
        times = [event["time"] for event in sim.events]
        self.assertEqual(times, sorted(times))

    def test_different_seed_changes_run(self):
        config, faults = build()
        sim1 = Simulator(config, faults, seed=3, max_steps=1000)
        sim2 = Simulator(config, faults, seed=4, max_steps=1000)
        sim1.run()
        sim2.run()
        self.assertNotEqual(sim1.events, sim2.events)


if __name__ == "__main__":
    unittest.main()
