import unittest

from docindex import AliasError, BatchError, Index

from support import build_index


class TestBatch(unittest.TestCase):
    def setUp(self):
        self.index = build_index()

    def test_batch_add_set_move_delete(self):
        self.index.apply_batch(
            [
                {"op": "add_doc", "doc_id": "d7", "doc": {"title": "fresh"}},
                {"op": "set_field", "doc_id": "d3", "path": "meta.author.email", "value": "ada@example.com"},
                {"op": "move_field", "doc_id": "d4", "from": "nested.a.b", "to": "nested.c"},
                {"op": "delete_field", "doc_id": "d5", "path": "title"},
                {"op": "delete_doc", "doc_id": "d6"},
            ]
        )
        self.assertEqual(self.index.search("title:fresh")["doc_ids"], ["d7"])
        self.assertEqual(self.index.search("meta.author.email:ada")["doc_ids"], ["d3"])
        # nested field moved: old path empty, new path searchable
        self.assertEqual(self.index.search("nested.a.b:deep")["doc_ids"], [])
        self.assertEqual(self.index.search('nested.c:"deep value"')["doc_ids"], ["d4"])
        self.assertEqual(self.index.search("title:lazy")["doc_ids"], [])
        self.assertEqual(self.index.search("*")["doc_ids"], ["d1", "d2", "d3", "d4", "d5", "d7"])

    def test_batch_is_atomic_on_failure(self):
        before = self.index.search("*")["doc_ids"]
        with self.assertRaises(BatchError):
            self.index.apply_batch(
                [
                    {"op": "set_field", "doc_id": "d1", "path": "title", "value": "mutated"},
                    {"op": "delete_field", "doc_id": "d1", "path": "no.such.field"},
                ]
            )
        self.assertEqual(self.index.search("title:mutated")["doc_ids"], [])
        self.assertEqual(self.index.search("*")["doc_ids"], before)

    def test_move_into_own_descendant_rejected(self):
        with self.assertRaises(BatchError):
            self.index.apply_batch(
                [{"op": "move_field", "doc_id": "d4", "from": "nested.a", "to": "nested.a.b.c"}]
            )
        # unchanged
        self.assertEqual(self.index.search('nested.a.b:"deep value"')["doc_ids"], ["d4"])

    def test_unknown_operation_rejected(self):
        with self.assertRaises(BatchError):
            self.index.apply_batch([{"op": "explode"}])

    def test_empty_batch_rejected(self):
        with self.assertRaises(BatchError):
            self.index.apply_batch([])


class TestAliasesAndCache(unittest.TestCase):
    def setUp(self):
        self.index = build_index()

    def test_alias_resolution(self):
        self.index.set_aliases({"headline": ["title"]})
        self.assertEqual(
            self.index.search("headline:fox")["doc_ids"],
            self.index.search("title:fox")["doc_ids"],
        )

    def test_chained_and_multi_target_aliases(self):
        self.index.set_aliases({"headline": ["title"], "content": ["headline", "body"]})
        self.assertEqual(
            self.index.search("content:quick")["doc_ids"],
            sorted(set(self.index.search("title:quick")["doc_ids"]) | set(self.index.search("body:quick")["doc_ids"])),
        )

    def test_alias_cycle_rejected(self):
        with self.assertRaises(AliasError):
            self.index.set_aliases({"a": ["b"], "b": ["a"]})
        with self.assertRaises(AliasError):
            self.index.set_aliases({"a": ["a"]})
        # failed set_rules must not change the version or the rules
        self.assertEqual(self.index.aliases.version, 0)
        self.assertEqual(self.index.aliases.rules, {})

    def test_candidate_cache_invalidated_by_rule_version(self):
        self.index.set_aliases({"headline": ["title"]})
        first = self.index.search("headline:fox")
        self.assertEqual(first["doc_ids"], ["d1", "d6"])
        self.assertEqual(self.index.cache_size, 1)
        # change the rules: same query string must be re-evaluated
        self.index.set_aliases({"headline": ["body"]})
        second = self.index.search("headline:fox")
        self.assertEqual(second["doc_ids"], [])
        self.assertEqual(self.index.cache_size, 2)  # new version => new entry

    def test_candidate_cache_invalidated_by_index_version(self):
        self.index.search("title:fox")
        self.assertEqual(self.index.cache_size, 1)
        self.index.add_doc("d9", {"title": "fox again"})
        result = self.index.search("title:fox")
        self.assertEqual(result["doc_ids"], ["d1", "d6", "d9"])
        self.assertEqual(self.index.cache_size, 2)


if __name__ == "__main__":
    unittest.main()
