"""Fault rules apply in the fixed phase order drop,dup,delay,clock_apply."""

import json
import tempfile
import unittest

from netsim.config import Faults, load_faults
from netsim.sim import Simulator

from helpers import make_config, write_json


class TestFaultPhaseOrder(unittest.TestCase):
    def test_drop_runs_before_dup(self):
        # With rate 1.0 on both, drop must win: no dup event may be emitted.
        config = make_config(
            nodes=["n1", "n2"],
            links=[("n1", "n2", 1, 0)],
            workload=[(0, "n1", "n2", "m1", "")],
        )
        faults = Faults(
            drop=[{"src": "n1", "dst": "n2", "rate": 1.0}],
            dup=[{"src": "n1", "dst": "n2", "rate": 1.0, "copies": 3}],
        )
        sim = Simulator(config, faults, seed=0, max_steps=100)
        summary = sim.run()
        self.assertEqual(summary["dropped"], 1)
        self.assertEqual(summary["duplicated"], 0)
        self.assertEqual(summary["delivered"], 0)
        self.assertFalse(any(e["type"] == "dup" for e in sim.events))

    def test_dict_key_order_does_not_matter(self):
        # Same rules, different key order in the JSON document -> same result.
        config = make_config(
            nodes=["n1", "n2"],
            links=[("n1", "n2", 2, 1)],
            workload=[(i, "n1", "n2", f"m{i}", "") for i in range(10)],
        )
        doc_a = {
            "drop": [{"src": "n1", "dst": "n2", "rate": 0.3}],
            "dup": [{"src": "n1", "dst": "n2", "rate": 0.4, "copies": 1}],
            "delay": [{"src": "n1", "dst": "n2", "extra": 5}],
        }
        doc_b = {
            "delay": [{"src": "n1", "dst": "n2", "extra": 5}],
            "dup": [{"src": "n1", "dst": "n2", "rate": 0.4, "copies": 1}],
            "drop": [{"src": "n1", "dst": "n2", "rate": 0.3}],
        }
        self.assertEqual(json.loads(json.dumps(doc_a)), json.loads(json.dumps(doc_b)))
        with tempfile.TemporaryDirectory() as d:
            faults_a = load_faults(write_json(d, "fa.json", doc_a), config)
            faults_b = load_faults(write_json(d, "fb.json", doc_b), config)
        sim_a = Simulator(config, faults_a, seed=9, max_steps=1000)
        sim_b = Simulator(config, faults_b, seed=9, max_steps=1000)
        sim_a.run()
        sim_b.run()
        self.assertEqual(sim_a.events, sim_b.events)
        self.assertEqual(sim_a.summary(), sim_b.summary())


if __name__ == "__main__":
    unittest.main()
