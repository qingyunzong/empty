import tempfile
import unittest
from pathlib import Path

from docstore import DocumentStore, PatchError, QueryError


class StoreCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name) / "store"
        self.store = DocumentStore(self.dir, initial={})


class TestBatchAtomicity(StoreCase):
    def test_failed_test_op_rolls_back_everything(self):
        self.store.create_index("byV", "/arr/*/v")
        self.store.apply([{"op": "add", "path": "/arr",
                           "value": [{"v": 1}, {"v": 2}]}])
        before_doc = self.store.get("")
        before_version = self.store.version
        before_count = self.store._version.indexes["byV"].entry_count()
        with self.assertRaises(PatchError):
            self.store.apply([
                {"op": "add", "path": "/arr/0", "value": {"v": 99}},
                {"op": "replace", "path": "/arr/1/v", "value": 100},
                {"op": "test", "path": "/arr/2/v", "value": 12345},
            ])
        self.assertEqual(self.store.get(""), before_doc)
        self.assertEqual(self.store.version, before_version)
        idx = self.store._version.indexes["byV"]
        self.assertEqual(idx.entry_count(), before_count)
        self.assertEqual(idx.as_map(), {"/arr/0/v": 1, "/arr/1/v": 2})

    def test_move_into_own_subtree_rejected_and_rolled_back(self):
        self.store.apply([{"op": "add", "path": "/a",
                           "value": {"b": {"c": 1}}, }])
        with self.assertRaises(PatchError):
            self.store.apply([
                {"op": "add", "path": "/z", "value": 1},
                {"op": "move", "from": "/a", "path": "/a/b/c/child"},
            ])
        self.assertEqual(self.store.get(""), {"a": {"b": {"c": 1}}})
        self.assertEqual(self.store.version, 1)

    def test_move_parent_into_child_rejected(self):
        self.store.apply([{"op": "add", "path": "/a", "value": {"b": 1}}])
        with self.assertRaises(PatchError):
            self.store.apply([{"op": "move", "from": "/a", "path": "/a/b"}])


class TestQueries(StoreCase):
    def setUp(self):
        super().setUp()
        self.store.create_index("byV", "/items/*/v")
        self.store.create_index("byTag", "/items/*/tags/*")
        self.store.apply([{"op": "add", "path": "/items", "value": [
            {"v": 3, "tags": ["x", "y"]},
            {"v": 1, "tags": ["y"]},
            {"v": 2, "tags": ["x"]},
        ]}])

    def test_eq(self):
        rows = self.store.query([{"index": "byV", "eq": 1}])
        self.assertEqual(rows, [{"path": "/items/1/v", "value": 1}])

    def test_eq_type_strict(self):
        self.assertEqual(self.store.query([{"index": "byV", "eq": 1.0}]), [])
        self.assertEqual(self.store.query([{"index": "byV", "eq": True}]), [])

    def test_exists(self):
        rows = self.store.query([{"index": "byV", "exists": True}])
        self.assertEqual({r["path"] for r in rows},
                         {"/items/0/v", "/items/1/v", "/items/2/v"})

    def test_and(self):
        rows = self.store.query([
            {"and": [{"index": "byTag", "eq": "x"},
                     {"index": "byV", "exists": True}]},
        ])
        self.assertEqual(rows, [])
        rows = self.store.query([
            {"and": [{"index": "byV", "exists": True},
                     {"index": "byV", "eq": 2}]},
        ])
        self.assertEqual(rows, [{"path": "/items/2/v", "value": 2}])
        rows = self.store.query([{"index": "byTag", "eq": "x"}])
        self.assertEqual({r["path"] for r in rows},
                         {"/items/0/tags/0", "/items/2/tags/0"})

    def test_sort_by_index_value(self):
        rows = self.store.query([{"index": "byV", "exists": True}],
                                sort_by="byV")
        self.assertEqual([r["value"] for r in rows], [1, 2, 3])
        self.assertEqual([r["path"] for r in rows],
                         ["/items/1/v", "/items/2/v", "/items/0/v"])

    def test_unknown_index(self):
        with self.assertRaises(QueryError):
            self.store.query([{"index": "nope", "eq": 1}])


class TestSnapshots(StoreCase):
    def test_snapshot_isolation_and_reclaim(self):
        self.store.create_index("byV", "/arr/*/v")
        self.store.apply([{"op": "add", "path": "/arr",
                           "value": [{"v": 1}, {"v": 2}]}])
        snap = self.store.open_snapshot()
        self.assertEqual(snap.version, 1)
        self.store.apply([{"op": "add", "path": "/arr/0",
                           "value": {"v": 0}}])
        self.store.reclaim()
        rows = snap.query([{"index": "byV", "exists": True}])
        self.assertEqual({r["path"] for r in rows},
                         {"/arr/0/v", "/arr/1/v"})
        self.assertEqual(snap.get("/arr/1/v"), 2)
        current = self.store.query([{"index": "byV", "exists": True}])
        self.assertEqual(len(current), 3)
        snap.release()
        with self.assertRaises(QueryError):
            snap.query([{"index": "byV", "exists": True}])

    def test_versions_increment(self):
        self.assertEqual(self.store.version, 0)
        self.store.apply([{"op": "add", "path": "/a", "value": 1}])
        self.assertEqual(self.store.version, 1)
        self.store.apply([{"op": "replace", "path": "/a", "value": 2}])
        self.assertEqual(self.store.version, 2)


if __name__ == "__main__":
    unittest.main()
