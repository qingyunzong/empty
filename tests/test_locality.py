import math
import random
import unittest
from fractions import Fraction

from dynhull import DynamicHull


class LocalityTest(unittest.TestCase):
    """Long update sequences must touch O(log n) nodes per update.

    The treap counts every node it examines (visited) and every node it
    allocates (created).  A sneaky full rebuild would create Theta(n)
    nodes per update; local maintenance stays within a small multiple of
    log2(n).  The recorded sequence is printed for inspection.
    """

    def test_long_sequence_node_visits(self):
        rng = random.Random(31337)
        hull = DynamicHull()
        n = 3000
        created_seq = []
        visited_seq = []
        for pid in range(n):
            hull.insert(pid,
                        Fraction(rng.randrange(10 ** 6), 997),
                        Fraction(rng.randrange(10 ** 6), 991))
            created_seq.append(hull.last_op["created"])
            visited_seq.append(hull.last_op["visited"])
        # mixed insert/delete workload on a large hull
        live = list(range(n))
        for step in range(2000):
            if rng.random() < 0.5 and live:
                pid = live.pop(rng.randrange(len(live)))
                hull.delete(pid)
            else:
                pid = n + step
                hull.insert(pid,
                            Fraction(rng.randrange(10 ** 6), 997),
                            Fraction(rng.randrange(10 ** 6), 991))
                live.append(pid)
            created_seq.append(hull.last_op["created"])
            visited_seq.append(hull.last_op["visited"])

        size = len(hull)
        log_bound = 8 * math.log2(size + 2) + 24
        max_created = max(created_seq)
        max_visited = max(visited_seq)
        avg_created = sum(created_seq) / len(created_seq)
        print(f"\n[locality] ops={len(created_seq)} final_size={size}")
        print(f"[locality] created/op: max={max_created} avg={avg_created:.1f} "
              f"bound={log_bound:.0f} (8*log2(n)+24)")
        print(f"[locality] visited/op: max={max_visited} "
              f"total_visited={sum(visited_seq)}")
        # local maintenance: far below a full Theta(n) rebuild
        self.assertLess(max_created, log_bound)
        self.assertLess(max_visited, log_bound)
        self.assertLess(max_created, size // 10)
        self.assertLess(avg_created, 4 * math.log2(size + 2))

    def test_summary_merge_is_local(self):
        # a single insert into a big hull creates only O(log n) new nodes
        rng = random.Random(5)
        hull = DynamicHull()
        for pid in range(2000):
            hull.insert(pid, rng.randrange(10 ** 6), rng.randrange(10 ** 6))
        hull.reset_stats()
        hull.insert(10 ** 6, 123456, 654321)
        self.assertLess(hull.last_op["created"], 100)
        self.assertLess(hull.last_op["visited"], 100)


if __name__ == "__main__":
    unittest.main()
