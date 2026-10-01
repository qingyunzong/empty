import unittest

from docindex import Index, QueryError
from docindex.query import AllDocs, And, FieldExists, Near, Not, Or, Phrase, Term, parse_query

from support import build_index


class TestParser(unittest.TestCase):
    def test_precedence_not_and_or(self):
        node = parse_query("a OR b AND NOT c")
        self.assertIsInstance(node, Or)
        self.assertEqual(node.children[0], Term(None, "a"))
        and_node = node.children[1]
        self.assertIsInstance(and_node, And)
        self.assertEqual(and_node.children[0], Term(None, "b"))
        self.assertIsInstance(and_node.children[1], Not)

    def test_juxtaposition_is_and(self):
        node = parse_query("title:fox body:dog")
        self.assertIsInstance(node, And)
        self.assertEqual(len(node.children), 2)

    def test_nested_parentheses(self):
        node = parse_query("((a OR (b AND c)) d)")
        self.assertIsInstance(node, And)
        self.assertIsInstance(node.children[0], Or)
        inner_or = node.children[0]
        self.assertIsInstance(inner_or.children[1], And)

    def test_field_qualified_phrase(self):
        node = parse_query('tags[*]:"quick brown"')
        self.assertEqual(node, Phrase("tags[*]", ("quick", "brown")))

    def test_single_word_phrase_becomes_term(self):
        self.assertEqual(parse_query('"hello"'), Term(None, "hello"))

    def test_near_default_and_explicit_distance(self):
        node = parse_query("lazy NEAR dog")
        self.assertIsInstance(node, Near)
        self.assertEqual(node.k, 10)
        node = parse_query("lazy NEAR/3 dog")
        self.assertEqual(node.k, 3)

    def test_star_and_field_star(self):
        self.assertIsInstance(parse_query("*"), AllDocs)
        self.assertIsInstance(parse_query("title:*"), FieldExists)

    def test_operators_are_case_insensitive(self):
        node = parse_query("a or B and Not c")
        self.assertIsInstance(node, Or)

    def test_syntax_errors(self):
        for bad in ["", "  ", "(a OR b", "a OR b)", 'title:"unterminated', '""', "AND a", "a OR"]:
            with self.assertRaises(QueryError, msg=bad):
                parse_query(bad)

    def test_near_rejects_boolean_operands(self):
        index = build_index()
        with self.assertRaises(QueryError):
            index.search("lazy NEAR/2 NOT dog")


class TestEvaluationSemantics(unittest.TestCase):
    def setUp(self):
        self.index = build_index()

    def test_field_qualification(self):
        self.assertEqual(self.index.search("title:quick")["doc_ids"], ["d1", "d2"])
        self.assertEqual(self.index.search("body:quick")["doc_ids"], [])

    def test_phrase(self):
        result = self.index.search('"quick brown"')
        self.assertEqual(result["doc_ids"], ["d1"])

    def test_wildcard_field_phrase_stays_in_one_instance(self):
        # d2 has "quick" in tags[0] and "brown" in tags[1]: no legal single
        # instance contains the phrase, so only d1 may match.
        result = self.index.search('tags[*]:"quick brown"')
        self.assertEqual(result["doc_ids"], ["d1"])

    def test_cross_field_pseudo_phrase_rejected(self):
        # d2 has title="quick" and body="brown"; the phrase "quick brown"
        # must not be assembled across fields.
        result = self.index.search('"quick brown"')
        self.assertNotIn("d2", result["doc_ids"])

    def test_not_universe_semantics(self):
        result = self.index.search("NOT title:fox")
        self.assertEqual(result["doc_ids"], ["d2", "d3", "d4", "d5"])
        # NOT of an empty-matching query yields the whole universe
        self.assertEqual(len(self.index.search("NOT body:zzz")["doc_ids"]), 6)

    def test_not_with_empty_and_missing_fields(self):
        # d3 has an empty title, d4 has none: both behave as "no tokens"
        self.assertEqual(self.index.search("title:*")["doc_ids"], ["d1", "d2", "d5", "d6"])
        self.assertEqual(self.index.search("NOT title:*")["doc_ids"], ["d3", "d4"])

    def test_double_negation(self):
        self.assertEqual(self.index.search("NOT NOT title:fox")["doc_ids"], ["d1", "d6"])

    def test_near_distance(self):
        self.assertEqual(self.index.search("lazy NEAR/1 dog")["doc_ids"], ["d1", "d5"])
        self.assertEqual(self.index.search("quick NEAR/0 fox")["doc_ids"], [])
        self.assertEqual(self.index.search("quick NEAR/2 fox")["doc_ids"], ["d1"])

    def test_near_respects_field_scope(self):
        # "quick" (title) and "brown" (body) of d2 are in different fields
        self.assertNotIn("d2", self.index.search("quick NEAR/5 brown")["doc_ids"])

    def test_paragraph_boundary_blocks_phrase_and_near(self):
        self.assertEqual(self.index.search('"lazy new"')["doc_ids"], [])
        self.assertEqual(self.index.search("lazy NEAR/2 new")["doc_ids"], [])
        # same paragraph, single newline: allowed
        self.assertEqual(self.index.search('body:"over the"')["doc_ids"], ["d1"])

    def test_boolean_and_positional_results_are_distinct(self):
        pos = self.index.search("title:fox")
        self.assertEqual(pos["kind"], "pos")
        self.assertIn("hits", pos)
        mixed = self.index.search("title:fox AND NOT tags:quick")
        self.assertEqual(mixed["kind"], "bool")
        self.assertNotIn("hits", mixed)  # positions are dropped, never mixed
        pure_not = self.index.search("NOT title:fox")
        self.assertEqual(pure_not["kind"], "bool")

    def test_deeply_nested_query(self):
        q = "((title:fox OR title:dog) AND (body:dog OR tags[*]:foo)) OR meta.author.name:ada"
        self.assertEqual(self.index.search(q)["doc_ids"], ["d1", "d3", "d5"])


if __name__ == "__main__":
    unittest.main()
