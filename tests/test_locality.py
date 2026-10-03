"""Locality instrumentation: updates must stay sublinear in the set size.

A long mixed insert/delete sequence is applied while the structure records
how many tree nodes each update touches.  A sneaky full rebuild would visit
Omega(n) nodes per update; local maintenance stays within O(log n).
"""

import math
import random
import unittest
from fractions import Fraction

from rational_hull import DynamicConvexHull


class TestLocality(unittest.TestCase):
    def test_long_update_sequence_visits_few_nodes(self):
        rng = random.Random(987654321)
        h = DynamicConvexHull()
        n0 = 1500
        live = []
        for i in range(n0):
            pid = f"base{i}"
            h.insert(
                pid,
                Fraction(rng.randrange(10**6), 997),
                Fraction(rng.randrange(10**6), 991),
            )
            live.append(pid)
        self.assertTrue(h.verify())

        h.stats.reset()
        m = 800
        for i in range(m):
            if rng.random() < 0.5 and live:
                pid = live.pop(rng.randrange(len(live)))
                h.delete(pid)
            else:
                pid = f"wave{i}"
                h.insert(
                    pid,
                    Fraction(rng.randrange(10**6), 983),
                    Fraction(rng.randrange(10**6), 977),
                )
                live.append(pid)

        stats = h.stats
        n = len(h)
        log_n = math.log2(max(n, 2))
        avg_nodes = stats.nodes_visited / m
        avg_chain = stats.chain_steps / m

        # Local maintenance: average and worst-case node visits are
        # logarithmic, and nowhere near a full O(n) rescan.
        self.assertLess(avg_nodes, 16 * log_n)
        self.assertLess(stats.max_update_nodes, 64 * log_n)
        self.assertLess(avg_nodes, n / 20)
        self.assertLess(stats.max_update_nodes, n)
        # Chain-repair work is likewise far below a full rebuild.
        self.assertLess(avg_chain, n / 2)
        self.assertLess(stats.max_update_chain_steps, 2 * n)
        # Sanity: the structure really did the updates.
        self.assertEqual(stats.updates, m)
        self.assertTrue(h.verify())
        print(
            f"\nlocality: n={n} updates={m} "
            f"avg_nodes={avg_nodes:.1f} max_nodes={stats.max_update_nodes} "
            f"log2(n)={log_n:.1f} avg_chain_steps={avg_chain:.1f}"
        )

    def test_visits_do_not_scale_linearly(self):
        # Doubling the set size must not double the per-update cost.
        def measure(size, seed):
            rng = random.Random(seed)
            h = DynamicConvexHull()
            for i in range(size):
                h.insert(f"p{i}", rng.randrange(10**7), rng.randrange(10**7))
            h.stats.reset()
            for i in range(300):
                pid = f"q{i}"
                h.insert(pid, rng.randrange(10**7), rng.randrange(10**7))
                h.delete(pid)
            return h.stats.nodes_visited / 300

        small = measure(400, 1)
        large = measure(3200, 2)
        # 8x the points must cost far less than 8x the node visits.
        self.assertLess(large, small * 4)
        print(f"\nscaling: n=400 -> {small:.1f} visits, "
              f"n=3200 -> {large:.1f} visits")


if __name__ == "__main__":
    unittest.main()
