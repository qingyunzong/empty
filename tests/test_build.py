import random
import unittest

from ghtree import CutTree, Graph

from util import assert_tree_correct, brute_min_cut, random_graph


class BuildExhaustiveTests(unittest.TestCase):
    """Cross-check every pair against full cut enumeration (n <= 8)."""

    def test_exhaustive_random_graphs(self):
        for n in range(2, 9):
            for seed in range(6):
                rng = random.Random(1000 * n + seed)
                tree = CutTree(random_graph(rng, n))
                with self.subTest(n=n, seed=seed):
                    assert_tree_correct(self, tree)

    def test_exhaustive_dense_and_sparse(self):
        for n in (5, 8):
            for prob in (0.25, 0.95):
                rng = random.Random(42 + n)
                tree = CutTree(random_graph(rng, n, edge_prob=prob))
                with self.subTest(n=n, prob=prob):
                    assert_tree_correct(self, tree)

    def test_zero_capacity_disconnection(self):
        # Two triangles joined by a zero-capacity bridge.
        g = Graph(6, [(0, 1, 5), (1, 2, 5), (0, 2, 5),
                      (3, 4, 7), (4, 5, 7), (3, 5, 7),
                      (2, 3, 0)])
        tree = CutTree(g)
        self.assertEqual(tree.query(0, 5), 0)
        self.assertEqual(tree.query(2, 3), 0)
        self.assertEqual(tree.query(0, 1), 10)
        self.assertEqual(tree.query(3, 4), 14)
        assert_tree_correct(self, tree)

    def test_parallel_edges_aggregated(self):
        g = Graph(3, [(0, 1, 2), (1, 0, 3), (0, 1, 1),
                      (1, 2, 4), (2, 1, 1)])
        self.assertEqual(g.capacity(0, 1), 6)
        self.assertEqual(g.capacity(1, 2), 5)
        tree = CutTree(g)
        self.assertEqual(tree.query(0, 1), 6)
        self.assertEqual(tree.query(1, 2), 5)
        self.assertEqual(tree.query(0, 2), 5)
        assert_tree_correct(self, tree)

    def test_single_vertex(self):
        tree = CutTree(Graph(1))
        self.assertIsNone(tree.query(0, 0))
        self.assertEqual(tree.verify(), [])

    def test_same_vertex_query(self):
        tree = CutTree(Graph(3, [(0, 1, 2), (1, 2, 3)]))
        self.assertIsNone(tree.query(1, 1))

    def test_deterministic_under_edge_permutation(self):
        rng = random.Random(7)
        base = random_graph(rng, 8)
        edges = base.edge_list()
        states = []
        for seed in range(5):
            shuffled = list(edges)
            random.Random(seed).shuffle(shuffled)
            # Re-add as parallel single edges to vary construction order.
            g = Graph(8, [tuple(e) for e in shuffled])
            states.append(CutTree(g).to_state())
        for other in states[1:]:
            self.assertEqual(states[0], other)

    def test_canonical_cut_sides(self):
        rng = random.Random(11)
        tree = CutTree(random_graph(rng, 8))
        for e in tree.edges:
            self.assertIn(0, e.side)
            self.assertEqual(list(e.side), sorted(e.side))
            self.assertLess(len(e.side), 8)


if __name__ == "__main__":
    unittest.main()
