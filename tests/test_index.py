import unittest

from logfilter import Index


class TestIndex(unittest.TestCase):
    def test_add_and_counts(self):
        index = Index()
        index.add_document("d1", ["Foo", "bar", "foo"])  # dedup per document
        index.add_document("d2", ["bar", "baz"])
        self.assertEqual(index.num_docs, 2)
        self.assertEqual(index.num_terms, 3)  # foo, bar, baz (casefolded)
        self.assertEqual(index.postings["foo"], ["d1"])
        self.assertEqual(index.postings["bar"], ["d1", "d2"])

    def test_delete_updates_counts_and_postings(self):
        index = Index()
        index.add_document("d1", ["shared", "only1"])
        index.add_document("d2", ["shared", "only2"])
        gen = index.generation

        self.assertTrue(index.delete_document("d1"))
        self.assertGreater(index.generation, gen)
        self.assertEqual(index.num_docs, 1)
        self.assertEqual(index.num_terms, 2)  # shared, only2
        self.assertEqual(index.postings["shared"], ["d2"])
        self.assertNotIn("only1", index.postings)
        self.assertFalse(index.automaton.accepts("only1"))
        self.assertTrue(index.automaton.accepts("shared"))

    def test_delete_missing_document(self):
        index = Index()
        index.add_document("d1", ["x"])
        gen = index.generation
        self.assertFalse(index.delete_document("nope"))
        self.assertEqual(index.generation, gen)

    def test_readd_replaces_document(self):
        index = Index()
        index.add_document("d1", ["old"])
        index.add_document("d1", ["new"])
        self.assertEqual(index.num_terms, 1)
        self.assertNotIn("old", index.postings)
        self.assertEqual(index.postings["new"], ["d1"])

    def test_empty_terms_ignored(self):
        index = Index()
        index.add_document("d1", ["", "ok"])
        self.assertEqual(index.num_terms, 1)

    def test_serialization_roundtrip(self):
        index = Index()
        index.add_document("d1", ["alpha", "beta"])
        index.add_document("d2", ["beta"])
        clone = Index.from_dict(index.to_dict())
        self.assertEqual(clone.generation, index.generation)
        self.assertEqual(clone.postings, index.postings)
        self.assertEqual(clone.docs, index.docs)
        self.assertEqual(clone.automaton.node_count, index.automaton.node_count)


if __name__ == "__main__":
    unittest.main()
