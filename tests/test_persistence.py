"""Nested snapshots, rollback with branching history, save / reload."""

import json
import os
import tempfile
import unittest

from rational_hull import DynamicConvexHull


def ids(hull):
    return [v.id for v in hull.hull().vertices]


def build_base():
    h = DynamicConvexHull()
    h.insert("a", 0, 0)
    h.insert("b", 6, 0)
    h.insert("c", 3, 4)
    return h


class TestNestedSnapshots(unittest.TestCase):
    def test_push_pop_nesting(self):
        h = build_base()
        base = ids(h)
        h.push()
        h.insert("d", 3, 1)  # interior: hull unchanged
        self.assertEqual(ids(h), base)
        h.push()
        h.insert("e", 10, 2)  # extends the hull
        self.assertEqual(ids(h), ["a", "b", "e", "c"])
        h.pop()  # undo the "e" insert
        self.assertEqual(ids(h), base)
        h.pop()  # undo the "d" insert
        self.assertEqual(ids(h), base)
        self.assertTrue(h.verify())
        with self.assertRaises(IndexError):
            h.pop()

    def test_rollback_then_fork(self):
        h = build_base()
        v0 = h.snapshot()
        # Branch A: grow to the right.
        h.insert("r", 12, 1)
        branch_a = ids(h)
        v_a = h.snapshot()
        # Roll back and fork into branch B: grow upward instead.
        h.restore(v0)
        h.insert("t", 3, 9)
        branch_b = ids(h)
        self.assertNotEqual(branch_a, branch_b)
        self.assertEqual(ids(h), branch_b)
        # Branch A is still fully recoverable.
        h.restore(v_a)
        self.assertEqual(ids(h), branch_a)
        self.assertTrue(h.verify())
        # And the original base state, too.
        h.restore(v0)
        self.assertEqual(ids(h), ["a", "b", "c"])
        self.assertTrue(h.verify())

    def test_deep_nesting(self):
        h = DynamicConvexHull()
        versions = []
        for i in range(10):
            versions.append((h.snapshot(), ids(h)))
            h.insert(f"p{i}", i, (i % 3) * (i - 5))
        for version, want in reversed(versions):
            h.restore(version)
            self.assertEqual(ids(h), want)
            self.assertTrue(h.verify())

    def test_snapshot_isolation(self):
        # Mutating after a snapshot must not disturb the captured version.
        h = build_base()
        v = h.snapshot()
        h.delete("a")
        h.delete("b")
        h.delete("c")
        self.assertEqual(ids(h), [])
        h.restore(v)
        self.assertEqual(ids(h), ["a", "b", "c"])
        self.assertEqual(len(h), 3)


class TestSaveLoad(unittest.TestCase):
    def test_roundtrip(self):
        h = build_base()
        h.insert("d", "3/2", "7/3")
        h.insert("e", "-1/2", 2)
        before = h.hull()
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "state.json")
            h.save(path)
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            self.assertEqual(data["format"], "rational-hull/1")
            self.assertEqual(len(data["points"]), 5)
            h2 = DynamicConvexHull.load(path)
        self.assertEqual(h2.hull(), before)
        self.assertEqual(len(h2), 5)
        self.assertTrue(h2.verify())
        # Deterministic tree: identical stats for identical updates.
        h2.stats.reset()
        h.stats.reset()
        h.insert("z", 5, 5)
        h2.insert("z", 5, 5)
        self.assertEqual(h.hull(), h2.hull())
        self.assertEqual(
            h.stats.last_update_nodes, h2.stats.last_update_nodes
        )

    def test_save_of_historical_version(self):
        h = build_base()
        v0 = h.snapshot()
        h.insert("x", 20, 20)
        h.restore(v0)
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "old.json")
            h.save(path)
            h2 = DynamicConvexHull.load(path)
        self.assertEqual(ids(h2), ["a", "b", "c"])
        self.assertEqual(len(h2), 3)

    def test_load_rejects_bad_format(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "bad.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump({"format": "other/9", "points": []}, fh)
            with self.assertRaises(ValueError):
                DynamicConvexHull.load(path)


if __name__ == "__main__":
    unittest.main()
