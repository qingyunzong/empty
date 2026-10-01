import unittest

from docret import Index, QueryError


def build_index():
    idx = Index()
    idx.apply_batch([
        {"op": "add_doc", "doc": "d1", "document": {
            "title": "the quick brown fox",
            "body": "it jumps over\n\nthe lazy dog",
            "tags": ["red fox", "blue whale"],
            "meta": {"author": {"name": "alice"}, "year": 2020},
        }},
        {"op": "add_doc", "doc": "d2", "document": {
            "title": "quick",
            "body": "a silver fox jumps and jumps",
            "tags": ["fox", "red"],
            "meta": {"author": {"name": "bob"}, "year": 2021},
        }},
        {"op": "add_doc", "doc": "d3", "document": {
            "title": "",
            "note": None,
            "meta": {"author": {"name": "carol"}},
        }},
    ])
    return idx


class TestPhrasesAndFields(unittest.TestCase):
    def setUp(self):
        self.idx = build_index()

    def test_phrase_within_field(self):
        res = self.idx.query('"quick brown"')
        self.assertEqual(res.docs, ["d1"])
        self.assertEqual(res.kind, "pos")

    def test_cross_field_pseudo_phrase_rejected(self):
        # "fox" ends the title of d2-ish docs and "jumps" starts bodies,
        # but no single field contains "fox jumps" in d1's title/body mix.
        res = self.idx.query('"fox it"')  # title ends ...fox, body starts it...
        self.assertEqual(res.docs, [])
        # d2 body really contains "fox jumps"
        self.assertEqual(self.idx.query('"fox jumps"').docs, ["d2"])

    def test_same_name_array_fields(self):
        # phrase inside one array element matches
        self.assertEqual(self.idx.query('tags:"red fox"').docs, ["d1"])
        # pseudo phrase spanning two array elements must not match
        self.assertEqual(self.idx.query('tags:"fox blue"').docs, [])
        self.assertEqual(self.idx.query('tags:"fox red"').docs, [])

    def test_paragraph_boundary_blocks_phrase(self):
        # d1 body: "it jumps over" \n\n "the lazy dog" -> cross-paragraph
        self.assertEqual(self.idx.query('"over the"').docs, [])
        self.assertEqual(self.idx.query('"lazy dog"').docs, ["d1"])

    def test_field_inheritance_nested(self):
        self.assertEqual(self.idx.query("meta.author.name:alice").docs, ["d1"])
        self.assertEqual(self.idx.query("meta.author:name").docs, [])
        self.assertEqual(self.idx.query("meta.year:2020").docs, ["d1"])

    def test_wildcard_field_single_instance(self):
        # meta.* matches meta.author.name and meta.year
        self.assertEqual(self.idx.query("meta.*:alice").docs, ["d1"])
        self.assertEqual(self.idx.query("meta.*:2021").docs, ["d2"])
        # phrase across different wildcard-matched fields must not match:
        # d1 has name "alice" and year "2020" as separate instances
        self.assertEqual(self.idx.query('meta.*:"alice 2020"').docs, [])

    def test_boolean_operators(self):
        self.assertEqual(self.idx.query("quick AND fox").docs, ["d1", "d2"])
        self.assertEqual(self.idx.query("alice OR bob").docs, ["d1", "d2"])
        self.assertEqual(self.idx.query("quick AND NOT brown").docs, ["d2"])
        self.assertEqual(
            self.idx.query("(alice OR bob) AND NOT carol").docs, ["d1", "d2"])

    def test_not_universe_semantics(self):
        # NOT is complement over ALL docs, including docs with empty/missing
        # fields: d3 has an empty title and no body at all.
        res = self.idx.query("NOT title:quick")
        self.assertEqual(res.docs, ["d3"])
        self.assertEqual(res.kind, "bool")
        self.assertEqual(self.idx.query("NOT body:jumps").docs, ["d3"])
        # double negation
        self.assertEqual(self.idx.query("NOT NOT quick").docs, ["d1", "d2"])

    def test_not_with_empty_field_value(self):
        # d3 title is "" and note is null: no tokens, but doc still in universe
        self.assertEqual(self.idx.query("title:quick").docs, ["d1", "d2"])
        self.assertEqual(self.idx.query("NOT note:anything").docs,
                         ["d1", "d2", "d3"])

    def test_near(self):
        self.assertEqual(self.idx.query("quick NEAR/1 fox").docs, ["d1"])
        self.assertEqual(self.idx.query("quick NEAR/0 fox").docs, [])
        # NEAR must stay inside one field instance
        self.assertEqual(self.idx.query("tags:(red NEAR/1 fox)").docs, ["d1"])
        self.assertEqual(self.idx.query("tags:(fox NEAR/2 blue)").docs, [])

    def test_near_evidence_span(self):
        res = self.idx.query("quick NEAR/2 fox")
        ev = res.evidence["d1"][0]
        self.assertEqual(ev.text, "quick brown fox")
        self.assertEqual((ev.char_start, ev.char_end), (4, 19))

    def test_mixed_result_not_confused(self):
        # positional AND boolean -> boolean result, no evidence
        res = self.idx.query('"quick brown" AND NOT carol')
        self.assertEqual(res.kind, "bool")
        self.assertEqual(res.docs, ["d1"])
        self.assertEqual(res.evidence, {})
        # purely positional -> positional with evidence
        res = self.idx.query('"quick brown" AND fox')
        self.assertEqual(res.kind, "pos")
        self.assertTrue(res.evidence["d1"])

    def test_phrase_over_boolean_operand_rejected(self):
        with self.assertRaises(QueryError):
            self.idx.query('(NOT a) NEAR/1 b')
        with self.assertRaises(QueryError):
            self.idx.query('title:(NOT a)')

    def test_multiple_fragments_same_doc(self):
        res = self.idx.query("jumps")
        evs = res.evidence["d2"]
        self.assertEqual(len(evs), 2)
        spans = sorted((e.char_start, e.char_end) for e in evs)
        body = "a silver fox jumps and jumps"
        for start, end in spans:
            self.assertEqual(body[start:end], "jumps")
        # two different fields also produce separate fragments
        res = self.idx.query("quick")
        fields = {e.field_path for e in res.evidence["d1"]}
        self.assertEqual(fields, {"title"})

    def test_evidence_locates_original_text(self):
        res = self.idx.query('"lazy dog"')
        ev = res.evidence["d1"][0]
        original = "it jumps over\n\nthe lazy dog"
        self.assertEqual(original[ev.char_start:ev.char_end], "lazy dog")
        self.assertEqual(ev.field_path, "body")
        self.assertEqual(ev.paragraph, 1)
        self.assertEqual(ev.text, "lazy dog")


class TestStatsAtomicity(unittest.TestCase):
    def test_stats_update_atomically_with_index(self):
        idx = build_index()
        before = idx.stats()
        self.assertEqual(before["doc_count"], 3)
        idx.apply_batch([
            {"op": "add_doc", "doc": "d4", "document": {"title": "zebra"}},
            {"op": "set", "doc": "d1", "path": "title", "value": "giraffe"},
        ])
        after = idx.stats()
        self.assertEqual(after["doc_count"], 4)
        # index and stats reflect the same commit
        self.assertEqual(idx.query("zebra").docs, ["d4"])
        self.assertEqual(idx.query("quick").docs, ["d2"])
        self.assertEqual(after["total_tokens"],
                         before["total_tokens"] - 4 + 1 + 1)


if __name__ == "__main__":
    unittest.main()
