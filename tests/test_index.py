import os
import random
import tempfile
import unittest

from rknni import (
    DimensionError,
    DuplicateIdError,
    Index,
    StaleCursorError,
    StaleVersionError,
)

from helpers import brute_force, check_tree_invariants, make_index, random_vector


class TestMutationBasics(unittest.TestCase):
    def test_insert_len_contains(self):
        idx = Index(2)
        idx.insert("a", [1, 2], tags=["x"], version=1)
        self.assertEqual(len(idx), 1)
        self.assertIn("a", idx)
        self.assertEqual(idx.get("a").version, 1)
        self.assertEqual(idx.data_version, 1)

    def test_duplicate_id_rejected(self):
        idx = Index(2)
        idx.insert("a", [1, 2])
        with self.assertRaises(DuplicateIdError):
            idx.insert("a", [3, 4])
        self.assertEqual(len(idx), 1)
        self.assertEqual(idx.data_version, 1)

    def test_dimension_mismatch_rejected(self):
        idx = Index(2)
        with self.assertRaises(DimensionError):
            idx.insert("a", [1, 2, 3])

    def test_bad_id_rejected(self):
        idx = Index(2)
        for bad in (1.5, True, None, ["x"]):
            with self.assertRaises(TypeError):
                idx.insert(bad, [1, 2])

    def test_delete_missing_raises(self):
        idx = Index(2)
        with self.assertRaises(KeyError):
            idx.delete("nope")

    def test_delete_all_empties_index(self):
        rng = random.Random(7)
        idx = make_index(rng, 40, capacity=4)
        for i in range(40):
            idx.delete(i)
        self.assertEqual(len(idx), 0)
        check_tree_invariants(self, idx)
        res = idx.query([0, 0, 0], 5)
        self.assertEqual(res.status, "exact")
        self.assertEqual(res.items, [])
        self.assertEqual(res.cert_entries, [])


class TestVersionReplacement(unittest.TestCase):
    def test_upsert_replaces_with_newer_version(self):
        idx = Index(2)
        idx.upsert("a", [0, 0], tags=["old"], version=1)
        idx.upsert("a", [10, 0], tags=["new"], version=2)
        self.assertEqual(len(idx), 1)
        point = idx.get("a")
        self.assertEqual(point.version, 2)
        self.assertEqual(point.tags, frozenset({"new"}))
        res = idx.query([10, 0], 1)
        self.assertEqual(res.items[0][0], "a")
        self.assertEqual(str(res.items[0][1]), "0")

    def test_stale_version_rejected(self):
        idx = Index(2)
        idx.upsert("a", [0, 0], version=5)
        for stale in (5, 4, 1):
            with self.assertRaises(StaleVersionError):
                idx.upsert("a", [9, 9], version=stale)
        self.assertEqual(idx.get("a").vector, idx._make_point("a", [0, 0], (), 1).vector)

    def test_upsert_requires_version(self):
        idx = Index(2)
        with self.assertRaises(ValueError):
            idx.upsert("a", [0, 0])


class TestBoundsNeverOverShrink(unittest.TestCase):
    def test_random_mixed_workload_keeps_invariants(self):
        rng = random.Random(1234)
        idx = Index(3, capacity=4, fanout=4)
        live = []
        for step in range(300):
            if not live or rng.random() < 0.6:
                pid = f"p{step}"
                idx.insert(pid, random_vector(rng, 3, lo=-20, hi=20),
                           tags=[t for t in "abc" if rng.random() < 0.3])
                live.append(pid)
            else:
                victim = rng.choice(live)
                live.remove(victim)
                idx.delete(victim)
            check_tree_invariants(self, idx)


class TestDeleteNearestPoint(unittest.TestCase):
    def test_nearest_changes_after_delete(self):
        idx = Index(2, capacity=4)
        idx.insert("near", [1, 0])
        idx.insert("mid", [3, 0])
        idx.insert("far", [9, 0])
        self.assertEqual(idx.query([0, 0], 1).items[0][0], "near")
        idx.delete("near")
        res = idx.query([0, 0], 1)
        self.assertEqual(res.items[0][0], "mid")
        self.assertEqual(str(res.items[0][1]), "9")
        idx.delete("mid")
        self.assertEqual(idx.query([0, 0], 1).items[0][0], "far")


class TestTagSummaryStaleness(unittest.TestCase):
    def test_queries_stay_correct_after_summary_invalidation(self):
        rng = random.Random(99)
        idx = Index(2, capacity=4, fanout=4)
        # Cluster of rare-tagged points plus background points.
        for i in range(6):
            idx.insert(f"rare{i}", [100 + i, 100], tags=["rare"])
        for i in range(40):
            idx.insert(f"bg{i}", random_vector(rng, 2, lo=-10, hi=10), tags=["bg"])
        for i in range(6):
            idx.delete(f"rare{i}")
        check_tree_invariants(self, idx)
        # Stale summaries may still mention "rare"; results must not.
        res = idx.query([100, 100], 10, filter={"tag": "rare"})
        self.assertEqual(res.status, "exact")
        self.assertEqual(res.items, [])
        res2 = idx.query([0, 0], 50, filter={"not": {"tag": "rare"}})
        self.assertEqual(res2.items, brute_force(idx.points(), [0, 0], 50,
                                                 {"not": {"tag": "rare"}}))


class TestSnapshotAndPersistence(unittest.TestCase):
    def test_snapshot_is_isolated(self):
        rng = random.Random(5)
        idx = make_index(rng, 60)
        snap = idx.snapshot()
        idx.insert("new", [0, 0, 0])
        idx.delete(0)
        self.assertEqual(len(snap), 60)
        self.assertEqual(len(idx), 60)
        self.assertNotIn("new", snap)
        self.assertIn(0, snap)
        q = random_vector(rng, 3)
        self.assertEqual(snap.query(q, 7).to_dict()["results"],
                         snap.query(q, 7).to_dict()["results"])
        self.assertNotEqual(snap.data_version, idx.data_version)

    def test_save_and_load_roundtrip(self):
        rng = random.Random(6)
        idx = make_index(rng, 80, capacity=5, fanout=5)
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "index.json")
            idx.save(path)
            loaded = Index.load(path)
        self.assertEqual(idx.to_dict(), loaded.to_dict())
        q = [1, 2, 3]
        filt = {"or": [{"tag": "a"}, {"tag": "b"}]}
        self.assertEqual(
            idx.query(q, 9, filter=filt).to_dict(),
            loaded.query(q, 9, filter=filt).to_dict(),
        )
        check_tree_invariants(self, loaded)


class TestCursorVersionBinding(unittest.TestCase):
    def test_cursor_invalidated_by_mutation(self):
        rng = random.Random(11)
        idx = make_index(rng, 30)
        cur = idx.cursor([0, 0, 0], 4)
        self.assertEqual(cur.run().status, "exact")
        idx.insert("zzz", [1, 1, 1])
        with self.assertRaises(StaleCursorError):
            cur.run()

    def test_cursor_on_snapshot_stays_valid(self):
        rng = random.Random(12)
        idx = make_index(rng, 30)
        snap = idx.snapshot()
        cur = snap.cursor([0, 0, 0], 4)
        idx.insert("zzz", [1, 1, 1])
        idx.delete(0)
        self.assertEqual(cur.run().status, "exact")

    def test_delete_invalidates_cursor(self):
        idx = Index(2)
        idx.insert("a", [0, 0])
        cur = idx.cursor([0, 0], 1)
        idx.delete("a")
        with self.assertRaises(StaleCursorError):
            cur.run()


if __name__ == "__main__":
    unittest.main()
