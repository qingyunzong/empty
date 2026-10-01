import unittest

from docret.query import And, Field, Near, Not, Or, Phrase, QueryError, Term, parse


class TestParser(unittest.TestCase):
    def test_term(self):
        self.assertEqual(parse("hello"), Term("hello"))

    def test_phrase(self):
        self.assertEqual(parse('"quick brown fox"'),
                         Phrase(("quick", "brown", "fox")))

    def test_field_term_and_phrase(self):
        self.assertEqual(parse("title:hello"), Field("title", Term("hello")))
        self.assertEqual(parse('title:"a b"'),
                         Field("title", Phrase(("a", "b"))))

    def test_field_group(self):
        node = parse("title:(a OR b)")
        self.assertEqual(node, Field("title", Or(Term("a"), Term("b"))))

    def test_precedence_not_and_or(self):
        # NOT > AND > OR
        node = parse("a OR b AND NOT c")
        self.assertEqual(node, Or(Term("a"), And(Term("b"), Not(Term("c")))))

    def test_nested_parentheses(self):
        node = parse("((a OR (b AND c)) AND d)")
        self.assertEqual(
            node,
            And(Or(Term("a"), And(Term("b"), Term("c"))), Term("d")),
        )

    def test_near(self):
        node = parse("quick NEAR/2 fox")
        self.assertEqual(node, Near(Term("quick"), Term("fox"), 2))

    def test_near_with_phrase(self):
        node = parse('"a b" NEAR/1 c')
        self.assertEqual(node, Near(Phrase(("a", "b")), Term("c"), 1))

    def test_wildcard_field(self):
        self.assertEqual(parse("meta.*:x"), Field("meta.*", Term("x")))

    def test_errors(self):
        for bad in ("", "a AND", "OR b", "(a", "a)", '""', "NOT"):
            with self.assertRaises(QueryError, msg=bad):
                parse(bad)


if __name__ == "__main__":
    unittest.main()
