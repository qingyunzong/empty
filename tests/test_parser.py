import unittest

from regex_deriv.alphabet import Alphabet
from regex_deriv.parser import parse
from regex_deriv.syntax import ALL, EMPTY, EPS, from_raw

AB = Alphabet.from_string("ab")
ABC = Alphabet.from_string("abc")
A2Z = Alphabet.from_string("abcdefghijklmnopqrstuvwxyz")


class TestParser(unittest.TestCase):
    def test_literal_and_concat(self):
        self.assertEqual(parse("ab"), ("concat", ("char", 97, 97),
                                     ("char", 98, 98)))

    def test_union_precedence(self):
        raw = parse("ab|c")
        self.assertEqual(raw[0], "union")
        self.assertEqual(raw[1][0], "concat")
        self.assertEqual(raw[2], ("char", 99, 99))

    def test_inter_binds_tighter_than_union(self):
        raw = parse("a&b|c")
        self.assertEqual(raw[0], "union")
        self.assertEqual(raw[1][0], "inter")

    def test_complement_prefix(self):
        self.assertEqual(parse("~a"), ("compl", ("char", 97, 97)))
        self.assertEqual(parse("~~a"), ("compl", ("compl", ("char", 97, 97))))

    def test_postfix(self):
        self.assertEqual(parse("a*"), ("star", ("char", 97, 97)))
        self.assertEqual(parse("a+")[0], "concat")
        self.assertEqual(parse("a?")[0], "union")
        self.assertEqual(parse("a**"), ("star", ("star", ("char", 97, 97))))

    def test_empty_pattern_is_eps(self):
        self.assertEqual(parse(""), ("eps",))
        self.assertEqual(parse("()"), ("eps",))

    def test_special_literals(self):
        self.assertEqual(parse("∅"), ("empty",))
        self.assertEqual(parse("ε"), ("eps",))

    def test_class_range(self):
        self.assertEqual(parse("[a-c]"), ("union", ("char", 97, 99)))

    def test_class_set_and_dash(self):
        self.assertEqual(parse("[ab]"),
                         ("union", ("char", 97, 97), ("char", 98, 98)))
        raw = parse("[a-]")
        self.assertEqual(raw, ("union", ("char", 97, 97), ("char", 45, 45)))

    def test_negated_class(self):
        raw = parse("[^a-c]", ABC)
        self.assertEqual(raw, ("empty",))  # nothing left
        raw = parse("[^a]", ABC)
        self.assertEqual(raw, ("union", ("char", 98, 99)))

    def test_negated_class_requires_alphabet(self):
        with self.assertRaises(SyntaxError):
            parse("[^a]")

    def test_dot(self):
        raw = parse(".", AB)
        self.assertEqual(raw, ("union", ("char", 97, 98)))
        with self.assertRaises(SyntaxError):
            parse(".")

    def test_escapes(self):
        self.assertEqual(parse("\\*"), ("char", 42, 42))
        self.assertEqual(parse("\\n"), ("char", 10, 10))
        self.assertEqual(parse("\\|a"),
                         ("concat", ("char", 124, 124), ("char", 97, 97)))

    def test_errors(self):
        for bad in ("(", "a)", "[a", "a\\", "*a", "[c-a]"):
            with self.assertRaises(SyntaxError, msg=bad):
                parse(bad)

    def test_semantic_sugar(self):
        self.assertIs(from_raw(parse("a+")), from_raw(parse("aa*")))
        self.assertIs(from_raw(parse("~∅", AB)), ALL)
        self.assertIs(from_raw(parse("∅")), EMPTY)
        self.assertIs(from_raw(parse("ε")), EPS)


if __name__ == "__main__":
    unittest.main()
