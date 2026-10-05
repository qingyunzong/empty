import itertools
import json
import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ghtree import GomoryHuTree
from ghtree.maxflow import cut_capacity


def aggregate(vertices, edges):
    labels = sorted(vertices)
    index = {lab: i for i, lab in enumerate(labels)}
    cap = [dict() for _ in labels]
    for a, b, c in edges:
        if a == b:
            continue
        i, j = index[a], index[b]
        cap[i][j] = cap[i].get(j, 0) + c
        cap[j][i] = cap[j].get(i, 0) + c
    return labels, cap


def brute_mincut(cap, s, t):
    """Min s-t cut by enumerating every subset containing s but not t."""
    others = [x for x in range(len(cap)) if x != s and x != t]
    best = None
    for mask in range(1 << len(others)):
        side = {s}
        for k, x in enumerate(others):
            if mask >> k & 1:
                side.add(x)
        c = cut_capacity(cap, side)
        if best is None or c < best:
            best = c
    return best


def check_all_pairs(testcase, tree, labels, cap):
    index = {lab: i for i, lab in enumerate(labels)}
    for a, b in itertools.combinations(labels, 2):
        expected = brute_mincut(cap, index[a], index[b])
        testcase.assertEqual(tree.query(a, b), expected,
                             "min-cut mismatch for pair (%s, %s)" % (a, b))
        info = tree.query_cut(a, b)
        testcase.assertEqual(info["value"], expected)
        side = set(info["partition"][0])
        testcase.assertEqual(len(info["partition"]), 2)
        testcase.assertEqual(set(info["partition"][1]),
                             set(labels) - side)
        testcase.assertEqual((a in side) != (b in side), True)


def random_graph(rng, n, max_parallel=2, max_cap=6, p=0.55):
    labels = [str(i) for i in range(n)]
    edges = []
    for i in range(n):
        for j in range(i + 1, n):
            if rng.random() < p:
                for _ in range(rng.randint(1, max_parallel)):
                    edges.append((labels[i], labels[j],
                                  rng.randint(0, max_cap)))
    return labels, edges


class TestBuild(unittest.TestCase):
    def test_random_graphs_match_brute_force(self):
        rng = random.Random(20261005)
        for trial in range(30):
            n = rng.randint(2, 8)
            labels, edges = random_graph(rng, n)
            tree = GomoryHuTree(labels, edges)
            _labels, cap = aggregate(labels, edges)
            check_all_pairs(self, tree, labels, cap)
            self.assertTrue(tree.verify()["ok"])

    def test_exhaustive_tiny_graphs(self):
        # n = 3, every capacity in {0, 1, 2} on each of the 3 pairs.
        for caps in itertools.product((0, 1, 2), repeat=3):
            edges = [("0", "1", caps[0]), ("0", "2", caps[1]),
                     ("1", "2", caps[2])]
            labels = ["0", "1", "2"]
            tree = GomoryHuTree(labels, edges)
            _l, cap = aggregate(labels, edges)
            check_all_pairs(self, tree, labels, cap)
        # n = 4, every capacity in {0, 1} on each of the 6 pairs.
        pairs = [("0", "1"), ("0", "2"), ("0", "3"),
                 ("1", "2"), ("1", "3"), ("2", "3")]
        for bits in itertools.product((0, 1), repeat=6):
            edges = [(a, b, c) for (a, b), c in zip(pairs, bits)]
            labels = ["0", "1", "2", "3"]
            tree = GomoryHuTree(labels, edges)
            _l, cap = aggregate(labels, edges)
            check_all_pairs(self, tree, labels, cap)

    def test_zero_capacity_disconnect(self):
        labels = ["a", "b", "c", "d"]
        edges = [("a", "b", 5), ("c", "d", 7), ("b", "c", 0)]
        tree = GomoryHuTree(labels, edges)
        self.assertEqual(tree.query("a", "d"), 0)
        self.assertEqual(tree.query("a", "b"), 5)
        _l, cap = aggregate(labels, edges)
        check_all_pairs(self, tree, labels, cap)
        # fully disconnected graph
        tree2 = GomoryHuTree(labels, [])
        for a, b in itertools.combinations(labels, 2):
            self.assertEqual(tree2.query(a, b), 0)
        self.assertTrue(tree2.verify()["ok"])

    def test_parallel_edges_aggregation(self):
        labels = ["a", "b", "c"]
        multi = [("a", "b", 2), ("a", "b", 3), ("b", "c", 4),
                 ("a", "c", 1), ("b", "a", 1)]
        aggregated = [("a", "b", 6), ("b", "c", 4), ("a", "c", 1)]
        t1 = GomoryHuTree(labels, multi)
        t2 = GomoryHuTree(labels, aggregated)
        for a, b in itertools.combinations(labels, 2):
            self.assertEqual(t1.query(a, b), t2.query(a, b))
        _l, cap = aggregate(labels, multi)
        check_all_pairs(self, t1, labels, cap)

    def test_self_loops_ignored(self):
        labels = ["a", "b", "c"]
        base = [("a", "b", 3), ("b", "c", 2)]
        with_loops = base + [("a", "a", 9), ("c", "c", 1)]
        t1 = GomoryHuTree(labels, base)
        t2 = GomoryHuTree(labels, with_loops)
        self.assertEqual(t1.to_dict(), t2.to_dict())

    def test_degenerate_inputs(self):
        with self.assertRaises(ValueError):
            GomoryHuTree([], [])
        tree = GomoryHuTree(["only"], [])
        self.assertTrue(tree.verify()["ok"])
        with self.assertRaises(ValueError):
            tree.query("only", "only")
        with self.assertRaises(ValueError):
            GomoryHuTree(["a", "b"], [("a", "b", -1)])
        with self.assertRaises(ValueError):
            GomoryHuTree(["a", "b"], [("a", "b", 1.5)])
        with self.assertRaises(ValueError):
            GomoryHuTree(["a", "b"], [("a", "zz", 1)])


class TestUpdate(unittest.TestCase):
    def bridge_tree(self):
        labels = list("abcdef")
        edges = [("a", "b", 10), ("a", "c", 10), ("b", "c", 10),
                 ("d", "e", 10), ("d", "f", 10), ("e", "f", 10),
                 ("c", "d", 3)]
        return labels, edges

    def test_bridge_capacity_up_and_down(self):
        labels, edges = self.bridge_tree()
        tree = GomoryHuTree(labels, edges)
        self.assertEqual(tree.query("a", "d"), 3)
        self.assertEqual(tree.query("a", "b"), 20)

        report = tree.update([("c", "d", 8)])
        self.assertEqual(tree.query("a", "d"), 8)
        self.assertEqual(tree.query("a", "b"), 20)
        self.assertEqual(len(report["reused"]), 5)
        self.assertEqual(report["recomputed"], [])
        self.assertFalse(report["tree_rebuilt"])
        self.assertTrue(tree.verify()["ok"])

        report = tree.update([("c", "d", 1)])
        self.assertEqual(tree.query("a", "d"), 1)
        self.assertEqual(len(report["reused"]), 5)
        self.assertEqual(report["recomputed"], [])
        self.assertTrue(tree.verify()["ok"])

        _l, cap = aggregate(labels, [("a", "b", 10), ("a", "c", 10),
                                     ("b", "c", 10), ("d", "e", 10),
                                     ("d", "f", 10), ("e", "f", 10),
                                     ("c", "d", 1)])
        check_all_pairs(self, tree, labels, cap)

    def test_old_cut_legal_but_not_minimal(self):
        # Triangle, all capacities 4: every pair has min cut 8.
        labels = ["x", "y", "z"]
        edges = [("x", "y", 4), ("y", "z", 4), ("x", "z", 4)]
        tree = GomoryHuTree(labels, edges)
        self.assertEqual(tree.query("x", "y"), 8)
        # Shrinking x-z does not change the capacity of the stored cut
        # {y} for edge (x, y) (still 8), but the true min cut drops to 4.
        report = tree.update([("x", "z", 0)])
        self.assertEqual(tree.query("x", "y"), 4)
        self.assertEqual(tree.query("x", "z"), 4)
        self.assertEqual(tree.query("y", "z"), 4)
        recomputed = {frozenset((r["u"], r["v"])) for r in report["recomputed"]}
        self.assertIn(frozenset(("x", "y")), recomputed)
        self.assertEqual(report["recomputed"][0]["old_weight"], 8)
        self.assertEqual(report["recomputed"][0]["new_weight"], 4)
        self.assertEqual(len(report["reused"]), 1)
        self.assertTrue(report["tree_rebuilt"])
        self.assertTrue(tree.verify()["ok"])
        _l, cap = aggregate(labels, [("x", "y", 4), ("y", "z", 4)])
        check_all_pairs(self, tree, labels, cap)

    def test_multiple_simultaneous_changes(self):
        labels, edges = self.bridge_tree()
        tree = GomoryHuTree(labels, edges)
        # Two changes at once: removing a-c leaves the stored cut {b} of
        # one tree edge legal (capacity 20) but non-minimal (now 10),
        # while the bridge grows from 3 to 8.
        report = tree.update([("a", "c", 0), ("c", "d", 8)])
        self.assertEqual(tree.query("a", "b"), 10)
        self.assertEqual(tree.query("a", "c"), 10)
        self.assertEqual(tree.query("a", "d"), 8)
        self.assertEqual(tree.query("b", "e"), 8)
        self.assertEqual(len(report["reused"]), 4)
        self.assertEqual(len(report["recomputed"]), 1)
        self.assertEqual(report["recomputed"][0]["old_weight"], 20)
        self.assertEqual(report["recomputed"][0]["new_weight"], 10)
        self.assertTrue(tree.verify()["ok"])
        new_edges = [("a", "b", 10), ("b", "c", 10), ("c", "d", 8),
                     ("d", "e", 10), ("d", "f", 10), ("e", "f", 10)]
        _l, cap = aggregate(labels, new_edges)
        check_all_pairs(self, tree, labels, cap)

    def test_random_updates_match_brute_force(self):
        rng = random.Random(77031)
        for trial in range(20):
            n = rng.randint(2, 8)
            labels, edges = random_graph(rng, n)
            tree = GomoryHuTree(labels, edges)
            current = list(edges)
            for _round in range(rng.randint(1, 3)):
                updates = []
                for _ in range(rng.randint(1, 4)):
                    a, b = rng.sample(labels, 2)
                    updates.append((a, b, rng.randint(0, 6)))
                report = tree.update(updates)
                self.assertEqual(
                    len(report["reused"]) + len(report["recomputed"]), n - 1)
                for a, b, c in updates:
                    current = [e for e in current
                               if {e[0], e[1]} != {a, b}]
                    current.append((a, b, c))
                _l, cap = aggregate(labels, current)
                check_all_pairs(self, tree, labels, cap)
                self.assertTrue(tree.verify()["ok"])

    def test_illegal_update_rolls_back_everything(self):
        rng = random.Random(5)
        labels, edges = random_graph(rng, 6)
        tree = GomoryHuTree(labels, edges)
        snapshot = tree.to_dict()
        bad_batches = [
            [(labels[0], labels[1], -2)],                 # negative
            [(labels[0], labels[1], 2.5)],                # non-integer
            [(labels[0], labels[1], True)],               # bool is not int
            [(labels[0], "nope", 3)],                     # unknown vertex
            [(labels[0], labels[1], 4), (labels[1], labels[2], -1)],
        ]
        for batch in bad_batches:
            with self.assertRaises((ValueError, TypeError)):
                tree.update(batch)
            self.assertEqual(tree.to_dict(), snapshot)
        # the tree is still fully functional afterwards
        _l, cap = aggregate(labels, edges)
        check_all_pairs(self, tree, labels, cap)
        self.assertTrue(tree.verify()["ok"])

    def test_save_restore_then_query_and_update_consistently(self):
        rng = random.Random(99)
        labels, edges = random_graph(rng, 7)
        tree = GomoryHuTree(labels, edges)
        tree.update([(labels[0], labels[1], 2), (labels[2], labels[3], 5)])
        state = json.loads(json.dumps(tree.to_dict()))
        restored = GomoryHuTree.from_dict(state)
        self.assertEqual(restored.to_dict(), tree.to_dict())
        for a, b in itertools.combinations(labels, 2):
            self.assertEqual(restored.query(a, b), tree.query(a, b))
        batch = [(labels[1], labels[2], 1), (labels[4], labels[5], 6)]
        r1 = tree.update(batch)
        r2 = restored.update(batch)
        self.assertEqual(r1, r2)
        self.assertEqual(restored.to_dict(), tree.to_dict())
        for a, b in itertools.combinations(labels, 2):
            self.assertEqual(restored.query(a, b), tree.query(a, b))


class TestVerification(unittest.TestCase):
    def build_triangle(self):
        return GomoryHuTree(["x", "y", "z"],
                            [("x", "y", 4), ("y", "z", 4), ("x", "z", 4)])

    def test_tampered_flow_detected(self):
        tree = self.build_triangle()
        state = tree.to_dict()
        edge = state["tree"][0]
        self.assertTrue(edge["flow"])
        edge["flow"][0][2] += 1  # corrupt one flow value
        bad = GomoryHuTree.from_dict(state)
        result = bad.verify()
        self.assertFalse(result["ok"])
        self.assertTrue(any("flow" in e or "conservation" in e or
                            "outflow" in e or "inflow" in e
                            for e in result["errors"]))

    def test_dropped_flow_detected(self):
        tree = self.build_triangle()
        state = tree.to_dict()
        state["tree"][0]["flow"] = []
        bad = GomoryHuTree.from_dict(state)
        self.assertFalse(bad.verify()["ok"])

    def test_tampered_cut_side_detected(self):
        tree = self.build_triangle()
        state = tree.to_dict()
        state["tree"][0]["cut_side"] = ["x", "y", "z"]
        bad = GomoryHuTree.from_dict(state)
        self.assertFalse(bad.verify()["ok"])

    def test_tampered_weight_detected(self):
        tree = self.build_triangle()
        state = tree.to_dict()
        state["tree"][0]["weight"] += 1
        bad = GomoryHuTree.from_dict(state)
        self.assertFalse(bad.verify()["ok"])

    def test_honest_tree_verifies(self):
        rng = random.Random(1234)
        for _ in range(10):
            n = rng.randint(2, 8)
            labels, edges = random_graph(rng, n)
            tree = GomoryHuTree(labels, edges)
            result = tree.verify()
            self.assertTrue(result["ok"], result["errors"])
            self.assertEqual(len(result["pair_checks"]), n * (n - 1) // 2)


if __name__ == "__main__":
    unittest.main()
