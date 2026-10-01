"""Core semantics: conflicts, idempotent duplicates, version resolution."""

import unittest

from gossip import Simulator
from gossip.simulator import Message


class SemanticsTest(unittest.TestCase):
    def test_concurrent_versions_create_conflict(self):
        sim = Simulator(nodes=2, seed=1, fanout=1)
        sim.inject(0, "k", "from-0")
        sim.inject(1, "k", "from-1")  # same version (1), different origin
        sim.step(1)
        for node in sim.nodes:
            self.assertIn("k", node.conflicts)
            self.assertEqual(len(node.conflicts["k"]), 2)
        self.assertFalse(sim.converged())

    def test_higher_version_resolves_conflict(self):
        sim = Simulator(nodes=2, seed=1, fanout=1)
        sim.inject(0, "k", "from-0")
        sim.inject(1, "k", "from-1")
        sim.step(1)
        self.assertFalse(sim.converged())
        sim.inject(0, "k", "from-0-v2")  # version 2 dominates
        sim.step(2)
        self.assertEqual(sim.nodes[1].store["k"], [2, 0, "from-0-v2"])
        self.assertEqual(sim.nodes[1].conflicts, {})
        self.assertTrue(sim.converged())

    def test_duplicate_message_is_idempotent(self):
        sim = Simulator(nodes=2, seed=1, fanout=1)
        sim.inject(0, "k", "v")
        digest = {k: list(v) for k, v in sim.nodes[0].store.items()}
        msg = Message(0, 1, 1, digest)
        sim._deliver(sim.nodes[1], msg)
        after_first = dict(sim.nodes[1].store)
        sim._deliver(sim.nodes[1], msg)  # duplicate delivery
        sim._deliver(sim.nodes[1], msg)
        self.assertEqual(sim.nodes[1].store, after_first)
        self.assertEqual(sim.nodes[1].conflicts, {})
        duplicates = [e for e in sim.events
                      if e["event"] == "deliver" and e["duplicate"]]
        self.assertEqual(len(duplicates), 2)

    def test_stale_version_ignored(self):
        sim = Simulator(nodes=2, seed=1, fanout=1)
        sim.inject(0, "k", "v1")
        sim.inject(0, "k", "v2")
        sim.step(1)
        stale = Message(0, 1, 1, {"k": [1, 0, "v1"]})
        sim._deliver(sim.nodes[1], stale)
        self.assertEqual(sim.nodes[1].store["k"], [2, 0, "v2"])


if __name__ == "__main__":
    unittest.main()
