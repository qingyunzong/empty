import os
import tempfile
import unittest

from jsondoc import DocumentStore, PatchError, loads


class StoreVersionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = DocumentStore(self.tmp.name)
        self.addCleanup(self.store.close)

    def test_snapshot_survives_gc(self):
        self.store.put("d", {"n": 1})
        snap = self.store.snapshot()
        self.store.apply("d", [{"op": "replace", "path": "/n", "value": 2}])
        self.store.apply("d", [{"op": "replace", "path": "/n", "value": 3}])
        self.store.gc()
        # unpinned, non-latest version 2 is reclaimed
        self.assertNotIn(2, self.store.versions())
        self.assertFalse(os.path.exists(
            os.path.join(self.tmp.name, "versions", "v2.json")))
        # pinned snapshot is unaffected by reclamation
        self.assertEqual(snap.get("d"), {"n": 1})
        self.assertEqual(snap.query({"where": [{"exists": "/n"}]}), ["d"])
        self.assertEqual(self.store.get("d"), {"n": 3})
        snap.close()
        self.store.gc()
        self.assertNotIn(1, self.store.versions())
        with self.assertRaises(RuntimeError):
            snap.get("d")

    def test_snapshot_query_uses_old_index_state(self):
        self.store.put("d", {"n": 1})
        self.store.create_index("by_n", "/n")
        snap = self.store.snapshot()
        self.store.apply("d", [{"op": "replace", "path": "/n", "value": 5}])
        self.assertEqual(snap.query({"where": [{"eq": ["by_n", 1]}]}), ["d"])
        self.assertEqual(snap.query({"where": [{"eq": ["by_n", 5]}]}), [])
        self.assertEqual(self.store.query({"where": [{"eq": ["by_n", 5]}]}), ["d"])
        self.assertEqual(self.store.query({"where": [{"eq": ["by_n", 1]}]}), [])
        snap.close()

    def test_batch_test_failure_full_rollback(self):
        self.store.put("d", {"n": 1})
        self.store.create_index("by_n", "/n")
        version = self.store.latest
        count = self.store.index_count("by_n")
        ops = [
            {"op": "add", "path": "/extra", "value": True},
            {"op": "replace", "path": "/n", "value": 2},
            {"op": "test", "path": "/n", "value": 999},
        ]
        with self.assertRaises(PatchError):
            self.store.apply("d", ops)
        self.assertEqual(self.store.latest, version)
        self.assertEqual(self.store.get("d"), {"n": 1})
        self.assertEqual(self.store.index_count("by_n"), count)
        self.assertEqual(self.store.query({"where": [{"eq": ["by_n", 1]}]}), ["d"])

    def test_move_parent_into_own_subtree_rejected(self):
        self.store.put("d", loads('{"a":{"b":{"c":1}}}'))
        version = self.store.latest
        with self.assertRaises(PatchError):
            self.store.apply("d", [{"op": "move", "from": "/a", "path": "/a/b/moved"}])
        self.assertEqual(self.store.latest, version)
        self.assertEqual(self.store.get("d"), {"a": {"b": {"c": 1}}})

    def test_apply_unknown_doc_rejected(self):
        with self.assertRaises(KeyError):
            self.store.apply("nope", [{"op": "add", "path": "/a", "value": 1}])

    def test_versions_monotonic(self):
        self.store.put("a", {"x": 1})
        self.store.put("b", {"x": 2})
        v = self.store.apply("a", [{"op": "replace", "path": "/x", "value": 3}])
        self.assertEqual(v, 3)
        self.assertEqual(self.store.latest, 3)


if __name__ == "__main__":
    unittest.main()

