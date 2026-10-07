import itertools
import random
import unittest

from patchtool.matching import hungarian


def brute_min(cost):
    n = len(cost)
    return min(sum(cost[i][p[i]] for i in range(n))
               for p in itertools.permutations(range(n)))


class TestHungarian(unittest.TestCase):
    def test_empty(self):
        match, u, v, total = hungarian([])
        self.assertEqual((match, u, v, total), ([], [], [], 0))

    def test_against_brute_force(self):
        rng = random.Random(20261008)
        for n in range(1, 7):
            for _ in range(50):
                cost = [[rng.randint(0, 30) for _ in range(n)] for _ in range(n)]
                match, u, v, total = hungarian(cost)
                self.assertEqual(total, brute_min(cost))
                self.assertEqual(sorted(match), list(range(n)))
                matched = sum(cost[i][match[i]] for i in range(n))
                self.assertEqual(matched, total)
                # dual feasibility + complementary slackness + strong duality
                for i in range(n):
                    for j in range(n):
                        self.assertLessEqual(u[i] + v[j], cost[i][j])
                for i in range(n):
                    self.assertEqual(u[i] + v[match[i]], cost[i][match[i]])
                self.assertEqual(sum(u) + sum(v), total)


if __name__ == "__main__":
    unittest.main()
