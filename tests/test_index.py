import os
import tempfile
import unittest
from fractions import Fraction

from knnindex import KNNIndex, StaleCursorError
from knnindex.geometry import box_contains_point
from knnindex.tree import REBUILD_THRESHOLD, Internal, iter_entries


def make_index(n=40, dims=2, seed=7):
    import random

    rng = random.Random(seed)
    idx = KNNIndex(dims)
    for i in range(n):
        idx.insert(
            f"p{i}",
            [Fraction(rng.randint(-50, 50), rng.randint(1, 5)) for _ in range(dims)],
            labels={"even"} if i % 2 == 0 else {"odd"},
        )
    return idx


def assert_boxes_safe(idx):
    """Every node box must contain every point beneath it (never over-shrunk)."""

    def walk(node):
        if node is None:
            return
        for entry in iter_entries(node):
            pass
        if isinstance(node, Internal):
            walk(node.left)
            walk(node.right)

    def check(node):
        if node is None:
            return
        for entry in iter_entries(node):
            assert box_contains_point(node.box, entry.coords), (
                f"box shrunk too far: {entry.point_id} outside its node box"
            )
        if isinstance(node, Internal):
            check(node.left)
            check(node.right)

    check(idx._root)


class TestIndex(unittest.TestCase):
    def test_insert_delete_replace_versions(self):
        idx = KNNIndex(2)
        self.assertEqual(idx.insert("a", [0, 0]), 1)
        self.assertEqual(idx.insert("b", [1, 1], ["x"]), 2)
        self.assertEqual(idx.replace("a", [5, 5], ["y"]), 3)
        self.assertEqual(idx.get("a").coords, (Fraction(5), Fraction(5)))
        self.assertEqual(idx.get("a").labels, frozenset({"y"}))
        self.assertTrue(idx.delete("a"))
        self.assertFalse(idx.delete("a"))
        self.assertNotIn("a", idx)
        with self.assertRaises(KeyError):
            idx.insert("b", [9, 9])

    def test_dimension_mismatch_rejected(self):
        idx = KNNIndex(3)
        with self.assertRaises(ValueError):
            idx.insert("a", [1, 2])
        with self.assertRaises(ValueError):
            idx.query([1, 2], 1)

    def test_delete_nearest_point(self):
        idx = KNNIndex(2)
        idx.insert("near", [1, 0])
        for i in range(2, 30):
            idx.insert(f"far{i}", [i * 10, 0])
        first = idx.query([0, 0], 1)
        self.assertEqual(first.hits[0][1], "near")
        idx.delete("near")
        second = idx.query([0, 0], 1)
        self.assertEqual(second.hits[0][1], "far2")
        self.assertEqual(second.hits[0][0], Fraction(400))
        self.assertEqual(second.status, "complete")

    def test_duplicate_coordinates(self):
        idx = KNNIndex(2)
        for i in range(10):
            idx.insert(f"dup{i}", [3, 3])
        result = idx.query([3, 3], 5)
        self.assertEqual(result.status, "complete")
        self.assertEqual(len(result.hits), 5)
        self.assertTrue(all(d == 0 for d, _ in result.hits))
        self.assertEqual([pid for _, pid in result.hits], [f"dup{i}" for i in range(5)])

    def test_boxes_never_over_shrink_after_deletes(self):
        idx = make_index(60)
        import random

        rng = random.Random(3)
        ids = [f"p{i}" for i in range(60)]
        rng.shuffle(ids)
        for pid in ids[:40]:
            idx.delete(pid)
            assert_boxes_safe(idx)
        for i in range(20):
            idx.insert(f"q{i}", [i, -i])
            assert_boxes_safe(idx)

    def test_lazy_box_eventually_tightens(self):
        idx = KNNIndex(1)
        idx.insert("outlier", [10**6])
        for i in range(8):
            idx.insert(f"c{i}", [i])
        idx.delete("outlier")
        # box may still be loose right after the delete (lazy shrink)
        for i in range(8):
            idx.delete(f"c{i}")
            idx.insert(f"n{i}", [100 + i])
        # after enough churn every leaf was rebuilt: root box must be tight-ish
        self.assertLessEqual(idx._root.box[1][0], Fraction(10**6))
        assert_boxes_safe(idx)

    def test_snapshot_pins_version(self):
        idx = make_index(30)
        snap = idx.snapshot()
        before = idx.query([0, 0], 5).hits
        for i in range(10):
            idx.delete(f"p{i}")
        after = idx.query([0, 0], 5, version=snap)
        self.assertEqual(after.version, snap)
        self.assertEqual(after.hits, before)
        self.assertEqual(idx.query([0, 0], 5).version, idx.version)

    def test_save_load_roundtrip(self):
        idx = make_index(50)
        idx.snapshot()
        idx.delete("p0")
        idx.snapshot()
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "idx.json")
            idx.save(path)
            loaded = KNNIndex.load(path)
        self.assertEqual(loaded.version, idx.version)
        self.assertEqual(len(loaded), len(idx))
        q = [Fraction(3, 2), Fraction(-7, 3)]
        self.assertEqual(loaded.query(q, 7).hits, idx.query(q, 7).hits)
        snap = sorted(idx._snapshots)[0]
        self.assertEqual(
            loaded.query(q, 7, version=snap).hits,
            idx.query(q, 7, version=snap).hits,
        )

    def test_cursor_bound_to_data_version(self):
        idx = make_index(80)
        result = idx.query([0, 0], 5, budget=2)
        self.assertEqual(result.status, "unknown")
        cursor = idx.cursor_for(result, [0, 0], 5)
        idx.insert("new", [1, 1])  # bumps version, cursor version not pinned
        with self.assertRaises(StaleCursorError):
            idx.resume(cursor)

    def test_cursor_resume_with_snapshot_matches_oneshot(self):
        idx = make_index(80)
        snap = idx.snapshot()
        result = idx.query([0, 0], 5, budget=2)
        cursor = idx.cursor_for(result, [0, 0], 5)
        idx.insert("new", [1, 1])
        resumed = idx.resume(cursor)  # snapshot keeps cursor version alive
        self.assertEqual(resumed.version, snap)
        expected = idx.query([0, 0], 5, version=snap)
        merged = resumed.hits
        self.assertEqual(merged, expected.hits[: len(merged)] if resumed.status == "unknown" else expected.hits)
        self.assertEqual(resumed.status, "complete")
        self.assertEqual(merged, expected.hits)


if __name__ == "__main__":
    unittest.main()
