import json
import random
import unittest

from ghtree import CutTree, Graph, UpdateError, cut_capacity

from util import assert_tree_correct, brute_min_cut, random_graph


class UpdateTests(unittest.TestCase):
    def test_bridge_capacity_up_and_down(self):
        # Two triangles joined by a single bridge of capacity 1.
        g = Graph(6, [(0, 1, 5), (1, 2, 5), (0, 2, 5),
                      (3, 4, 7), (4, 5, 7), (3, 5, 7),
                      (2, 3, 1)])
        tree = CutTree(g)
        self.assertEqual(tree.query(0, 5), 1)
        old_ids = {e.id for e in tree.edges}

        report = tree.update([(2, 3, 4)])  # bridge up
        self.assertEqual(tree.query(0, 5), 4)
        self.assertFalse(report["rebuilt"])
        self.assertIn([2, 3], report["resolved"])
        self.assertTrue(report["reused"])  # triangle-internal edges survive
        self.assertEqual({tuple(x) for x in report["reused"] + report["resolved"]},
                         old_ids)
        assert_tree_correct(self, tree)

        report = tree.update([(2, 3, 0)])  # bridge down to zero
        self.assertEqual(tree.query(0, 5), 0)
        self.assertEqual(tree.query(1, 4), 0)
        self.assertEqual(tree.query(0, 1), 10)  # internal cuts unaffected
        assert_tree_correct(self, tree)

        report = tree.update([(2, 3, 9)])  # and back up
        self.assertEqual(tree.query(0, 5), 9)
        assert_tree_correct(self, tree)

    def test_batch_update_old_cut_legal_but_not_minimal(self):
        # Triangle 0-1-2 (all 5) plus tail 2-3:4.  The (0,2) certificate
        # cut is {0} with capacity 10; its flow routes 5 units directly
        # and 5 units through edge (1,2).  A batch update lowers (1,2)
        # to 1 (breaking the flow, not the cut) and raises (2,3) to 7.
        # The old cut side {0} stays a legal cut of capacity 10 but the
        # min 0-2 cut drops to 6 via {0,1}.
        g = Graph(4, [(0, 1, 5), (0, 2, 5), (1, 2, 5), (2, 3, 4)])
        tree = CutTree(g)
        self.assertEqual(tree.query(0, 2), 10)
        cert = next(e for e in tree.edges if e.id == (0, 2))
        self.assertEqual(cert.side, (0,))
        caps = g.capacities()
        self.assertEqual(cut_capacity(caps, set(cert.side)), 10)

        report = tree.update([(1, 2, 1), (2, 3, 7)])
        self.assertIn([0, 2], report["resolved"])
        self.assertEqual(tree.query(0, 2), 6)
        # The old cut side is still a legal cut of capacity 10 ...
        self.assertEqual(
            cut_capacity(tree.graph.capacities(), set(cert.side)), 10)
        # ... but it is no longer minimal.
        self.assertEqual(brute_min_cut(4, tree.graph.capacities(), 0, 2), 6)
        assert_tree_correct(self, tree)

    def test_update_aggregates_parallel_edges(self):
        g = Graph(3, [(0, 1, 2), (0, 1, 3), (1, 2, 4)])
        tree = CutTree(g)
        self.assertEqual(tree.query(0, 1), 5)
        tree.update([(0, 1, 1)])  # sets the aggregate, not one edge
        self.assertEqual(tree.graph.capacity(0, 1), 1)
        self.assertEqual(tree.query(0, 1), 1)
        assert_tree_correct(self, tree)

    def test_random_batch_updates_vs_brute_force(self):
        for n in range(2, 9):
            rng = random.Random(500 + n)
            tree = CutTree(random_graph(rng, n))
            for round_no in range(4):
                old_ids = {e.id for e in tree.edges}
                updates = []
                for _ in range(rng.randint(1, 3)):
                    u = rng.randrange(n)
                    v = rng.randrange(n)
                    if u != v:
                        updates.append((u, v, rng.randint(0, 8)))
                if not updates:
                    continue
                report = tree.update(updates)
                with self.subTest(n=n, round=round_no, updates=updates):
                    if not report["rebuilt"]:
                        self.assertEqual(
                            {tuple(x) for x in
                             report["reused"] + report["resolved"]},
                            old_ids)
                    assert_tree_correct(self, tree)

    def test_illegal_update_rolls_back_everything(self):
        rng = random.Random(99)
        tree = CutTree(random_graph(rng, 6))
        before_state = tree.to_state()
        before_pairs = tree.all_pairs()
        tree.query(0, 1)  # populate the query cache

        for bad in ([(0, 1, -1)], [(0, 1, 2.5)], [(0, 1, "3")],
                    [(0, 9, 1)], [(0, 1, 2), (1, 2, -4)]):
            with self.assertRaises(UpdateError, msg=str(bad)):
                tree.update(bad)
            # Graph, tree and cache are exactly as before.
            self.assertEqual(tree.to_state(), before_state)
            self.assertEqual(tree.all_pairs(), before_pairs)

    def test_self_loop_update_ignored(self):
        tree = CutTree(Graph(3, [(0, 1, 2), (1, 2, 3)]))
        before = tree.to_state()
        tree.update([(1, 1, 7)])
        self.assertEqual(tree.to_state(), before)

    def test_save_restore_consistency(self):
        rng = random.Random(1234)
        tree = CutTree(random_graph(rng, 7))
        # Round-trip through actual JSON text.
        state = json.loads(json.dumps(tree.to_state()))
        twin = CutTree.from_state(state)

        self.assertEqual(tree.all_pairs(), twin.all_pairs())
        self.assertEqual(twin.verify(), [])

        updates = [(0, 3, 1), (2, 5, 9), (1, 4, 0)]
        report_a = tree.update(updates)
        report_b = twin.update(updates)
        self.assertEqual(report_a, report_b)
        self.assertEqual(tree.to_state(), twin.to_state())
        self.assertEqual(tree.all_pairs(), twin.all_pairs())
        assert_tree_correct(self, tree)
        assert_tree_correct(self, twin)

    def test_update_report_is_json_serialisable(self):
        tree = CutTree(Graph(3, [(0, 1, 2), (1, 2, 3)]))
        report = tree.update([(0, 1, 5)])
        json.dumps(report)


if __name__ == "__main__":
    unittest.main()
