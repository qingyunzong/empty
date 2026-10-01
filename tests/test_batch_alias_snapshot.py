import os
import tempfile
import unittest

from docret import AliasError, BatchError, Index


def build_index():
    idx = Index()
    idx.apply_batch([
        {"op": "add_doc", "doc": "d1", "document": {
            "title": "alpha beta",
            "meta": {"author": "alice", "city": "paris"},
        }},
        {"op": "add_doc", "doc": "d2", "document": {
            "title": "gamma",
            "meta": {"author": "bob"},
        }},
    ])
    return idx


class TestBatch(unittest.TestCase):
    def test_set_nested_field(self):
        idx = build_index()
        idx.apply_batch([
            {"op": "set", "doc": "d1", "path": "meta.editor.name", "value": "zoe"},
            {"op": "set", "doc": "d2", "path": "tags", "value": ["x ray", "y ray"]},
        ])
        self.assertEqual(idx.query("meta.editor.name:zoe").docs, ["d1"])
        self.assertEqual(idx.query('tags:"x ray"').docs, ["d2"])

    def test_delete_field(self):
        idx = build_index()
        idx.apply_batch([{"op": "delete", "doc": "d1", "path": "meta.city"}])
        self.assertEqual(idx.query("paris").docs, [])
        self.assertEqual(idx.query("meta.author:alice").docs, ["d1"])

    def test_nested_field_move(self):
        idx = build_index()
        idx.apply_batch([
            {"op": "move", "doc": "d1", "from": "meta.author", "to": "writer.name"},
        ])
        self.assertEqual(idx.query("writer.name:alice").docs, ["d1"])
        self.assertEqual(idx.query("meta.author:alice").docs, [])
        # stats moved with the index atomically
        stats = idx.stats()
        self.assertIn("writer.name", stats["fields"])
        # only d2's meta.author remains; d1's moved to writer.name
        self.assertEqual(stats["fields"]["meta.author"]["instances"], 1)
        self.assertEqual(stats["fields"]["writer.name"]["tokens"], 1)

    def test_move_to_existing_path_fails(self):
        idx = build_index()
        with self.assertRaises(BatchError):
            idx.apply_batch([
                {"op": "move", "doc": "d1", "from": "meta.author", "to": "meta.city"},
            ])
        # untouched
        self.assertEqual(idx.query("meta.author:alice").docs, ["d1"])

    def test_failed_batch_rolls_back(self):
        idx = build_index()
        before_stats = idx.stats()
        with self.assertRaises(BatchError):
            idx.apply_batch([
                {"op": "set", "doc": "d1", "path": "title", "value": "changed"},
                {"op": "add_doc", "doc": "d3", "document": {"title": "new"}},
                {"op": "delete", "doc": "d2", "path": "no.such.path"},  # fails
            ])
        # nothing from the batch is visible; stats identical
        self.assertEqual(idx.query("changed").docs, [])
        self.assertEqual(idx.query("new").docs, [])
        self.assertEqual(idx.query("title:alpha").docs, ["d1"])
        self.assertEqual(idx.stats(), before_stats)

    def test_remove_doc_failure_rolls_back(self):
        idx = build_index()
        with self.assertRaises(BatchError):
            idx.apply_batch([
                {"op": "remove_doc", "doc": "d1"},
                {"op": "remove_doc", "doc": "ghost"},
            ])
        self.assertEqual(idx.stats()["doc_count"], 2)

    def test_add_remove_doc(self):
        idx = build_index()
        idx.apply_batch([
            {"op": "add_doc", "doc": "d3", "document": {"title": "delta"}},
            {"op": "remove_doc", "doc": "d2"},
        ])
        self.assertEqual(idx.query("delta").docs, ["d3"])
        self.assertEqual(idx.query("gamma").docs, [])
        self.assertEqual(idx.stats()["doc_count"], 2)


class TestAliases(unittest.TestCase):
    def test_alias_rule(self):
        idx = build_index()
        idx.set_alias("headline", "title")
        self.assertEqual(idx.query("headline:alpha").docs, ["d1"])

    def test_alias_chain(self):
        idx = build_index()
        idx.set_alias("a1", "a2")
        idx.set_alias("a2", "meta.author")
        self.assertEqual(idx.query("a1:alice").docs, ["d1"])

    def test_alias_cycle_rejected(self):
        idx = build_index()
        idx.set_alias("x", "y")
        with self.assertRaises(AliasError):
            idx.set_alias("y", "x")
        with self.assertRaises(AliasError):
            idx.set_alias("x", "x")
        # the failed rule was not installed
        self.assertNotIn("y", idx.aliases)

    def test_alias_to_wildcard(self):
        idx = build_index()
        idx.set_alias("anything", "meta.*")
        self.assertEqual(idx.query("anything:paris").docs, ["d1"])

    def test_cache_invalidated_by_rule_version(self):
        idx = build_index()
        idx.set_alias("headline", "title")
        self.assertEqual(idx.query("headline:alpha").docs, ["d1"])
        self.assertGreaterEqual(idx.cache_size, 1)
        # changing the rule must invalidate cached candidates
        idx.set_alias("headline", "meta.author")
        self.assertEqual(idx.query("headline:alpha").docs, [])
        self.assertEqual(idx.query("headline:alice").docs, ["d1"])

    def test_cache_invalidated_by_commit(self):
        idx = build_index()
        self.assertEqual(idx.query("delta").docs, [])
        idx.apply_batch([
            {"op": "add_doc", "doc": "d3", "document": {"title": "delta"}},
        ])
        self.assertEqual(idx.query("delta").docs, ["d3"])


class TestSnapshots(unittest.TestCase):
    def test_snapshot_query(self):
        idx = build_index()
        snap = idx.snapshot()
        idx.apply_batch([
            {"op": "set", "doc": "d1", "path": "title", "value": "changed"},
            {"op": "add_doc", "doc": "d3", "document": {"title": "alpha too"}},
        ])
        # live index sees the new state
        self.assertEqual(idx.query("alpha").docs, ["d3"])
        # the snapshot still sees the old state
        self.assertEqual(idx.query("alpha", snapshot=snap).docs, ["d1"])
        self.assertEqual(idx.query("changed", snapshot=snap).docs, [])
        self.assertEqual(idx.stats(snapshot=snap)["doc_count"], 2)

    def test_snapshot_keeps_alias_rules(self):
        idx = build_index()
        idx.set_alias("who", "meta.author")
        snap = idx.snapshot()
        idx.set_alias("who", "title")
        self.assertEqual(idx.query("who:alice").docs, [])
        self.assertEqual(idx.query("who:alice", snapshot=snap).docs, ["d1"])


class TestPersistence(unittest.TestCase):
    def test_save_and_restore(self):
        idx = build_index()
        idx.set_alias("headline", "title")
        queries = ["alpha", "meta.author:bob", "NOT gamma",
                   'headline:"alpha beta"', "alpha OR gamma"]
        before = {q: idx.query(q).to_dict() for q in queries}
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "index.json")
            idx.save(path)
            restored = Index.load(path)
        self.assertEqual(restored.aliases, idx.aliases)
        self.assertEqual(restored.stats(), idx.stats())
        for q in queries:
            self.assertEqual(restored.query(q).to_dict(), before[q], q)

    def test_save_empty_index(self):
        idx = Index()
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "index.json")
            idx.save(path)
            restored = Index.load(path)
        self.assertEqual(restored.query("NOT anything").docs, [])


if __name__ == "__main__":
    unittest.main()
