"""Cross-check the index dataflow against the independent interpreter."""
import unittest

from docret import Index
from docret.index import resolve_alias
from docret.interpreter import evaluate_document
from docret.model import flatten
from docret.query import parse

CORPUS = {
    "d1": {
        "title": "the quick brown fox",
        "body": "it jumps over\n\nthe lazy dog",
        "tags": ["red fox", "blue whale"],
        "meta": {"author": {"name": "alice"}, "year": 2020},
    },
    "d2": {
        "title": "quick",
        "body": "a silver fox jumps and jumps",
        "tags": ["fox", "red"],
        "meta": {"author": {"name": "bob"}, "year": 2021},
    },
    "d3": {
        "title": "",
        "note": None,
        "meta": {"author": {"name": "carol"}},
    },
    "d4": {
        "items": [{"name": "red apple"}, {"name": "green pear"}],
        "title": "fruit basket",
    },
    "d5": {
        "title": "unrelated",
        "sections": [{"head": "intro text", "body": "text intro"}],
    },
}

QUERIES = [
    "quick",
    '"quick brown fox"',
    '"fox blue"',                      # pseudo phrase across array elements
    '"over the"',                      # pseudo phrase across paragraphs
    "tags:red",
    'tags:"red fox"',
    "items.name:red",
    'items.name:"red apple"',
    'items.name:"apple green"',        # pseudo phrase across array objects
    "meta.*:alice",
    "meta.author.name:carol",
    "quick AND fox",
    "quick OR carol",
    "quick AND NOT brown",
    "NOT title:quick",                 # complement incl. empty/missing fields
    "NOT NOT fox",
    "(quick OR carol) AND NOT bob",
    "title:(quick OR fruit)",
    "quick NEAR/1 brown",
    "quick NEAR/0 brown",
    "jumps NEAR/2 jumps",
    "intro NEAR/1 text",
    "sections.head:intro",
    "year:2020",
    "missing_field:value",
    "NOT missing_field:value",
]


class TestCrossCheck(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.index = Index()
        cls.index.set_alias("headline", "title")
        cls.index.apply_batch([
            {"op": "add_doc", "doc": doc_id, "document": doc}
            for doc_id, doc in CORPUS.items()
        ])
        cls.aliases = cls.index.aliases

    def test_full_query_results_match_interpreter(self):
        for query in QUERIES + ["headline:quick", 'headline:"fruit basket"']:
            with self.subTest(query=query):
                result = self.index.query(query)
                ast = parse(query)
                expected = set()
                for doc_id, doc in CORPUS.items():
                    matched, _ = evaluate_document(
                        ast, doc, lambda n: resolve_alias(n, self.aliases))
                    if matched:
                        expected.add(doc_id)
                self.assertEqual(set(result.docs), expected)

    def test_evidence_spans_match_original_text(self):
        for query in QUERIES:
            result = self.index.query(query)
            if result.kind != "pos":
                continue
            for doc_id in result.docs:
                instances = {
                    (inst.path, inst.ordinal): inst.text
                    for inst in flatten(CORPUS[doc_id])
                }
                for ev in result.evidence[doc_id]:
                    with self.subTest(query=query, doc=doc_id, ev=ev):
                        original = instances[(ev.field_path, ev.instance)]
                        self.assertEqual(
                            original[ev.char_start:ev.char_end], ev.text)

    def test_interpreter_evidence_agrees_on_positional_queries(self):
        for query in ['"quick brown fox"', "tags:red", "quick NEAR/1 brown",
                      "items.name:red"]:
            with self.subTest(query=query):
                result = self.index.query(query)
                ast = parse(query)
                for doc_id in result.docs:
                    _, evs = evaluate_document(
                        ast, CORPUS[doc_id],
                        lambda n: resolve_alias(n, self.aliases))
                    idx_spans = sorted(
                        (e.field_path, e.instance, e.char_start, e.char_end)
                        for e in result.evidence[doc_id])
                    int_spans = sorted(
                        (e.field_path, e.instance, e.char_start, e.char_end)
                        for e in evs)
                    self.assertEqual(idx_spans, int_spans)


if __name__ == "__main__":
    unittest.main()
