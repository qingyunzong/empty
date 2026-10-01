"""Acceptance B: <=8 nodes with random failures match a full-sync reference."""

import random
import unittest

from gossip import Simulator


def reference_full_sync(injects):
    """Full-sync reference: every entry propagates to everyone, so the final
    store of every live node is, per key, the inject with the highest
    version (test injects use unique keys, so exactly one per key)."""
    store = {}
    for _node, key, value, version in injects:
        if key not in store or version > store[key][0]:
            store[key] = [version, _node, value]
    return store


class ReferenceComparisonTest(unittest.TestCase):
    def test_random_failures_match_reference(self):
        rng = random.Random(20261001)
        for trial in range(10):
            n = rng.randint(2, 8)
            fanout = rng.randint(1, 4)
            seed = rng.randint(0, 10**6)
            sim = Simulator(nodes=n, seed=seed, fanout=fanout)

            injects = []
            key_count = 0
            # Interleave injects, random failures and steps.
            for _ in range(30):
                action = rng.random()
                if action < 0.45:
                    node = rng.randrange(n)
                    key = f"k{key_count}"
                    key_count += 1
                    value = rng.randint(0, 10**9)
                    version = sim.inject(node, key, value)
                    injects.append((node, key, value, version))
                elif action < 0.7:
                    sim.down(rng.randrange(n))
                else:
                    sim.step(rng.randint(1, 3))

            # Recover every node and run to convergence.
            for node_id in range(n):
                sim.up(node_id)
            while not sim.converged() and sim.round < 200:
                sim.step(1)

            expected = reference_full_sync(injects)
            self.assertTrue(
                sim.converged(),
                f"trial {trial}: not converged after {sim.round} rounds")
            for node in sim.nodes:
                self.assertTrue(node.up)
                self.assertEqual(
                    node.store, expected,
                    f"trial {trial}: node {node.id} diverged from reference")
                self.assertEqual(node.conflicts, {})


if __name__ == "__main__":
    unittest.main()
