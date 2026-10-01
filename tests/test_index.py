import unittest

from docindex import BatchError

from support import build_index


class TestEvidence(unittest.TestCase):
    def setUp(self):
        self.index = build_index()

    def test_hit_locates_into_original_text(self):
        result = self.index.search('title:"quick brown"')
        self.assertEqual(len(result["hits"]), 1)
        hit = result["hits"][0]
        self.assertEqual(hit["doc_id"], "d1")
        self.assertEqual(hit["field"], "title")
        self.assertEqual(hit["paragraph"], 0)
        self.assertEqual(hit["span"], [4, 15])
        self.assertEqual(hit["text"], "quick brown")

    def test_multiple_fragments_in_one_document(self):
        result = self.index.search('"quick brown"')
        d1_hits = [h for h in result["hits"] if h["doc_id"] == "d1"]
        self.assertEqual({h["field"] for h in d1_hits}, {"title", "tags[0]"})

    def test_paragraph_recorded_in_evidence(self):
        result = self.index.search("body:paragraph")
        hit = result["hits"][0]
        self.assertEqual(hit["paragraph"], 1)
        self.assertEqual(hit["text"], "paragraph")

    def test_same_name_array_fields_are_separate_instances(self):
        self.assertEqual(self.index.search("tags[1]:fox")["doc_ids"], ["d1"])
        self.assertEqual(self.index.search("tags[0]:fox")["doc_ids"], [])
        hit = self.index.search("tags[1]:fox")["hits"][0]
        self.assertEqual(hit["field"], "tags[1]")

    def test_nested_field_evidence(self):
        hit = self.index.search("meta.author.name:lovelace")["hits"][0]
        self.assertEqual(hit["field"], "meta.author.name")
        self.assertEqual(hit["text"], "lovelace")


class TestStatsAtomicity(unittest.TestCase):
    def test_stats_track_index(self):
        index = build_index()
        stats = index.stats()
        self.assertEqual(stats["num_docs"], 6)
        self.assertGreater(stats["num_tokens"], 0)
        # d3's title is empty and d4 has no title: 4 docs carry title tokens
        self.assertEqual(stats["fields"]["title"]["doc_count"], 4)
        before = (stats["num_tokens"], stats["index_version"])
        index.add_doc("d7", {"title": "brand new document"})
        after = index.stats()
        self.assertEqual(after["num_docs"], 7)
        self.assertEqual(after["num_tokens"], before[0] + 3)
        self.assertEqual(after["index_version"], before[1] + 1)

    def test_failed_batch_leaves_stats_and_index_untouched(self):
        index = build_index()
        before = index.search("*")["doc_ids"]
        before_stats = index.stats()
        with self.assertRaises(BatchError):
            index.apply_batch(
                [
                    {"op": "add_doc", "doc_id": "dx", "doc": {"title": "should rollback"}},
                    {"op": "delete_doc", "doc_id": "missing"},
                ]
            )
        self.assertEqual(index.stats(), before_stats)
        self.assertEqual(index.search("*")["doc_ids"], before)
        self.assertEqual(index.search("title:rollback")["doc_ids"], [])

    def test_delete_doc_updates_stats(self):
        index = build_index()
        index.delete_doc("d1")
        stats = index.stats()
        self.assertEqual(stats["num_docs"], 5)
        # d2 and d4 still have a tags[0] instance
        self.assertEqual(stats["fields"]["tags[0]"]["doc_count"], 2)
        self.assertEqual(index.search("title:quick")["doc_ids"], ["d2"])


if __name__ == "__main__":
    unittest.main()
