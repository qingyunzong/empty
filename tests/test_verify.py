import unittest

from docindex import cross_check, interpreter_search

from support import DOCS, QUERIES, build_index


class TestIndependentInterpreter(unittest.TestCase):
    def test_full_query_battery_matches_index(self):
        index = build_index()
        checked = cross_check(index, QUERIES)
        self.assertEqual(checked, len(QUERIES))

    def test_cross_check_after_mutations(self):
        index = build_index()
        index.apply_batch(
            [
                {"op": "move_field", "doc_id": "d4", "from": "nested.a.b", "to": "nested.c"},
                {"op": "set_field", "doc_id": "d2", "path": "tags[1]", "value": "quick brown"},
                {"op": "delete_doc", "doc_id": "d6"},
            ]
        )
        queries = QUERIES + ["nested.c:deep", 'tags[*]:"quick brown"']
        self.assertEqual(cross_check(index, queries), len(queries))

    def test_cross_check_with_aliases(self):
        index = build_index()
        index.set_aliases({"headline": ["title"], "content": ["headline", "body"]})
        queries = ["headline:fox", "content:quick", 'headline:"lazy dog"', "NOT content:dog"]
        self.assertEqual(cross_check(index, queries), len(queries))

    def test_cross_check_on_snapshot(self):
        index = build_index()
        index.create_snapshot("s1")
        index.apply_batch([{"op": "delete_doc", "doc_id": "d1"}])
        self.assertEqual(cross_check(index, QUERIES, snapshot="s1"), len(QUERIES))

    def test_interpreter_not_universe_semantics(self):
        result = interpreter_search("NOT title:fox", DOCS)
        self.assertEqual(result["doc_ids"], ["d2", "d3", "d4", "d5"])
        self.assertEqual(result["kind"], "bool")

    def test_interpreter_evidence_spans(self):
        result = interpreter_search('"quick brown"', DOCS)
        spans = {(f, s, e) for occs in result["hits"].values() for (f, _ps, _pe, _p, s, e) in occs}
        self.assertEqual(spans, {("title", 4, 15), ("tags[0]", 0, 11)})


if __name__ == "__main__":
    unittest.main()
