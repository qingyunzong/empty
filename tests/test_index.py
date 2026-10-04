import unittest

from logfilter import Index, NormalizationRules, VersionMismatchError


class TestIndex(unittest.TestCase):
    def test_add_and_stats(self):
        idx = Index()
        idx.add_document("d1", "foo foo bar")
        idx.add_document("d2", "foo baz")
        stats = idx.stats()
        self.assertEqual(stats["documents"], 2)
        self.assertEqual(stats["distinct_terms"], 3)
        self.assertEqual(stats["postings"], 4)  # foo in 2 docs, bar+baz in 1 each
        self.assertEqual(stats["tokens"], 5)
        self.assertEqual(idx.postings_for("foo"), {"d1": 2, "d2": 1})

    def test_same_word_different_documents_dedup(self):
        idx = Index()
        idx.add_document("d1", "error error")
        idx.add_document("d2", "error")
        idx.add_document("d3", "unrelated")
        # one dictionary entry, both documents listed once
        self.assertEqual(idx.stats()["distinct_terms"], 2)
        self.assertEqual(sorted(idx.postings_for("error")), ["d1", "d2"])

    def test_delete_updates_counts(self):
        idx = Index()
        idx.add_document("d1", "foo bar")
        idx.add_document("d2", "foo baz")
        idx.delete_document("d1")
        stats = idx.stats()
        self.assertEqual(stats["documents"], 1)
        self.assertEqual(stats["distinct_terms"], 2)  # bar is gone
        self.assertEqual(stats["postings"], 2)
        self.assertEqual(sorted(idx.postings_for("foo")), ["d2"])
        self.assertFalse(idx.dictionary.contains("bar"))

    def test_delete_last_reference_compresses_dictionary(self):
        idx = Index()
        idx.add_document("d1", "error erroneous")
        idx.add_document("d2", "error")
        self.assertTrue(idx.dictionary.contains("erroneous"))
        idx.delete_document("d1")
        # last reference to "erroneous" removed: term and nodes gone
        self.assertFalse(idx.dictionary.contains("erroneous"))
        self.assertTrue(idx.dictionary.contains("error"))
        self.assertEqual(list(idx.dictionary.words()), ["error"])
        idx.delete_document("d2")
        self.assertEqual(idx.stats()["distinct_terms"], 0)
        self.assertEqual(idx.dictionary.size, 0)

    def test_delete_missing_document(self):
        idx = Index()
        idx.add_document("d1", "foo")
        self.assertFalse(idx.delete_document("nope"))
        self.assertEqual(idx.stats()["documents"], 1)

    def test_replace_document(self):
        idx = Index()
        idx.add_document("d1", "foo bar")
        idx.add_document("d1", "baz")
        self.assertEqual(idx.stats()["distinct_terms"], 1)
        self.assertFalse(idx.dictionary.contains("foo"))
        self.assertTrue(idx.dictionary.contains("baz"))

    def test_normalization_version_recorded(self):
        idx = Index(NormalizationRules("identity-v0"))
        idx.add_document("d1", "Hello")
        self.assertTrue(idx.dictionary.contains("Hello"))
        self.assertFalse(idx.dictionary.contains("hello"))
        idx2 = Index()  # default: nfc-casefold-v1
        idx2.add_document("d1", "Hello")
        self.assertTrue(idx2.dictionary.contains("hello"))

    def test_version_mismatch_rejected(self):
        idx = Index(NormalizationRules("identity-v0"))
        idx.add_document("d1", "Foo")
        data = idx.to_dict()
        with self.assertRaises(VersionMismatchError):
            Index.from_dict(data, NormalizationRules("nfc-casefold-v1"))
        # loading with matching (or no) rules works
        Index.from_dict(data, NormalizationRules("identity-v0"))
        Index.from_dict(data)

    def test_persistence_roundtrip(self):
        idx = Index()
        idx.add_document("d1", "foo bar")
        idx.add_document("d2", "foo")
        clone = Index.from_dict(idx.to_dict())
        self.assertEqual(clone.stats(), idx.stats())
        self.assertEqual(list(clone.dictionary.words()), list(idx.dictionary.words()))
        self.assertEqual(clone.postings_for("foo"), idx.postings_for("foo"))


if __name__ == "__main__":
    unittest.main()
