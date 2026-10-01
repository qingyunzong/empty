import os
import tempfile
import unittest

from docindex import Index, SnapshotError

from support import DOCS, QUERIES, build_index


class TestSnapshots(unittest.TestCase):
    def test_snapshot_freezes_documents(self):
        index = build_index()
        index.create_snapshot("s1")
        index.add_doc("d7", {"title": "fox in a new doc"})
        self.assertIn("d7", index.search("title:fox")["doc_ids"])
        frozen = index.search("title:fox", snapshot="s1")
        self.assertEqual(frozen["doc_ids"], ["d1", "d6"])
        self.assertEqual(frozen["snapshot"], "s1")

    def test_snapshot_freezes_alias_rules(self):
        index = build_index()
        index.set_aliases({"headline": ["title"]})
        index.create_snapshot("s1")
        index.set_aliases({"headline": ["body"]})
        self.assertEqual(index.search("headline:fox")["doc_ids"], [])
        self.assertEqual(index.search("headline:fox", snapshot="s1")["doc_ids"], ["d1", "d6"])

    def test_snapshot_not_universe_is_the_snapshot(self):
        index = build_index()
        index.create_snapshot("s1")
        index.add_doc("d7", {"title": "extra"})
        self.assertIn("d7", index.search("NOT title:fox")["doc_ids"])
        self.assertNotIn("d7", index.search("NOT title:fox", snapshot="s1")["doc_ids"])

    def test_duplicate_snapshot_rejected(self):
        index = build_index()
        index.create_snapshot("s1")
        with self.assertRaises(SnapshotError):
            index.create_snapshot("s1")

    def test_unknown_snapshot_rejected(self):
        index = build_index()
        with self.assertRaises(SnapshotError):
            index.search("title:fox", snapshot="nope")


class TestPersistence(unittest.TestCase):
    def test_save_restore_round_trip(self):
        index = build_index()
        index.set_aliases({"headline": ["title"]})
        index.create_snapshot("s1")
        index.add_doc("d7", {"title": "added after snapshot"})
        expected_live = {q: index.search(q) for q in QUERIES}
        expected_snap = {q: index.search(q, snapshot="s1") for q in QUERIES}
        expected_stats = index.stats()

        with tempfile.TemporaryDirectory() as tmp:
            store = os.path.join(tmp, "store.json")
            index.save(store)
            restored = Index.restore(store)

        restored_stats = restored.stats()
        # cache_entries is runtime-only state and is not persisted
        self.assertEqual(restored_stats.pop("cache_entries"), 0)
        expected_stats.pop("cache_entries")
        self.assertEqual(restored_stats, expected_stats)
        for q in QUERIES:
            self.assertEqual(restored.search(q), expected_live[q], q)
            self.assertEqual(restored.search(q, snapshot="s1"), expected_snap[q], q)

    def test_restored_index_remains_mutable(self):
        index = build_index()
        with tempfile.TemporaryDirectory() as tmp:
            store = os.path.join(tmp, "store.json")
            index.save(store)
            restored = Index.restore(store)
        restored.add_doc("d8", {"title": "post restore fox"})
        self.assertEqual(restored.search("title:fox")["doc_ids"], ["d1", "d6", "d8"])


if __name__ == "__main__":
    unittest.main()
