"""Acceptance C: fanout=1 ring converges within the theoretical round bound,
otherwise the simulator reports NOT_CONVERGED."""

import unittest

from gossip import MAX_ROUNDS, SimError, Simulator


class RingConvergenceTest(unittest.TestCase):
    def test_ring_converges_within_diameter(self):
        for n in (2, 3, 8, 16):
            sim = Simulator(nodes=n, seed=1, fanout=1, topology="ring")
            sim.inject(0, "key", "value")
            # Delivery happens in the same round the message is sent, so the
            # theoretical bound is the ring diameter: n - 1 rounds.
            sim.step(n - 1)
            self.assertTrue(
                sim.converged(), f"ring of {n} not converged after {n - 1}")
            self.assertEqual(sim.status()["state"], "CONVERGED")

    def test_ring_reports_not_converged_when_node_stays_down(self):
        sim = Simulator(nodes=5, seed=1, fanout=1, topology="ring")
        sim.inject(0, "key", "value")
        sim.down(2)  # node 2 never comes back: convergence is impossible
        sim.step(MAX_ROUNDS)
        status = sim.status()
        self.assertFalse(status["converged"])
        self.assertEqual(status["state"], "NOT_CONVERGED")
        with self.assertRaises(SimError):
            sim.step(1)  # round limit is enforced


if __name__ == "__main__":
    unittest.main()
