import unittest

from ghtree import Graph, cut_capacity, min_cut
from ghtree.maxflow import flow_ok


class MaxFlowTests(unittest.TestCase):
    def test_simple_path(self):
        caps = {(0, 1): 3, (1, 2): 5}
        value, side, flow = min_cut(3, caps, 0, 2)
        self.assertEqual(value, 3)
        self.assertIn(0, side)
        self.assertNotIn(2, side)
        self.assertEqual(cut_capacity(caps, side), 3)
        self.assertTrue(flow_ok(caps, 0, 2, flow, value))

    def test_parallel_edges_aggregated(self):
        g = Graph(2, [(0, 1, 3), (1, 0, 4), (0, 1, 2)])
        self.assertEqual(g.capacity(0, 1), 9)
        value, _, _ = min_cut(2, g.capacities(), 0, 1)
        self.assertEqual(value, 9)

    def test_zero_capacity_edge(self):
        caps = {(0, 1): 0, (1, 2): 5}
        value, _, flow = min_cut(3, caps, 0, 2)
        self.assertEqual(value, 0)
        self.assertTrue(flow_ok(caps, 0, 2, flow, 0))

    def test_disconnected(self):
        caps = {(0, 1): 5}
        value, side, _ = min_cut(3, caps, 0, 2)
        self.assertEqual(value, 0)
        self.assertNotIn(2, side)

    def test_self_loop_ignored(self):
        g = Graph(2, [(0, 0, 9), (0, 1, 2), (1, 1, 7)])
        self.assertEqual(g.capacities(), {(0, 1): 2})

    def test_undirected_symmetry(self):
        caps = {(0, 1): 4, (1, 2): 6, (0, 2): 5}
        fwd, _, _ = min_cut(3, caps, 0, 2)
        rev, _, _ = min_cut(3, caps, 2, 0)
        self.assertEqual(fwd, rev)

    def test_flow_ok_rejects_infeasible(self):
        caps = {(0, 1): 2}
        self.assertFalse(flow_ok(caps, 0, 1, ((0, 1, 3),), 3))
        self.assertFalse(flow_ok(caps, 0, 1, ((0, 1, 2),), 1))
        self.assertTrue(flow_ok(caps, 0, 1, ((0, 1, 2),), 2))


if __name__ == "__main__":
    unittest.main()
