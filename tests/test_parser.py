import unittest

from symregex import Context, parse, ParseError
from symregex import ast as A


class TestParser(unittest.TestCase):
    def setUp(self):
        self.ctx = Context("abcde")

    def test_basic_constructs(self):
        ctx = self.ctx
        self.assertEqual(parse(ctx, "a").tag, A.CHAR)
        self.assertEqual(parse(ctx, "ab").tag, A.CONCAT)
        n = parse(ctx, "a|b")          # 字符集合并规范化
        self.assertEqual(n.tag, A.CHAR)
        self.assertEqual(n.args[0], frozenset("ab"))
        self.assertEqual(parse(ctx, "a&b").tag, A.EMPTY)  # 字符集相交为空
        self.assertEqual(parse(ctx, "a*").tag, A.STAR)
        self.assertEqual(parse(ctx, "~a").tag, A.COMPL)
        self.assertEqual(parse(ctx, "@").tag, A.EPS)
        self.assertEqual(parse(ctx, "#").tag, A.EMPTY)
        self.assertEqual(parse(ctx, "ε").tag, A.EPS)
        self.assertEqual(parse(ctx, "∅").tag, A.EMPTY)

    def test_precedence(self):
        ctx = self.ctx
        # ~ 绑定最紧，然后 *，然后连接，然后 &，最后 |
        n = parse(ctx, "~ab|cd")
        self.assertEqual(n.tag, A.UNION)
        self.assertEqual(ctx.to_str(n), "~ab|cd")
        n = parse(ctx, "~ab|c&d")      # c&d = ∅，被并吸收
        self.assertEqual(n.tag, A.CONCAT)
        self.assertEqual(ctx.to_str(n), "~ab")
        n = parse(ctx, "ab*")
        self.assertEqual(n.tag, A.CONCAT)  # a(b*)，不是 (ab)*

    def test_classes_and_ranges(self):
        ctx = self.ctx
        n = parse(ctx, "[a-c]")
        self.assertEqual(n.args[0], frozenset("abc"))
        n = parse(ctx, "[^a-c]")
        self.assertEqual(n.args[0], frozenset("de"))
        n = parse(ctx, ".")
        self.assertEqual(n.args[0], ctx.alphabet_set)
        n = parse(ctx, "[ce]")
        self.assertEqual(n.args[0], frozenset("ce"))

    def test_escapes(self):
        ctx = Context("ab*|]-")
        self.assertEqual(parse(ctx, "\\*").args[0], frozenset("*"))
        self.assertEqual(parse(ctx, "\\|").args[0], frozenset("|"))
        self.assertEqual(parse(ctx, "[\\]-]").args[0], frozenset("]-"))
        self.assertEqual(parse(self.ctx, "\\a").args[0], frozenset("a"))

    def test_roundtrip_canonical_str(self):
        ctx = self.ctx
        for pat in ["a", "a|b", "(a|b)*abb", "~(a&b)", "[a-c]d*", "@", "#",
                    "a&(b|c)", "~(a*b)&(c|d)", "((a|b)(a|b))*", "."]:
            node = parse(ctx, pat)
            self.assertIs(parse(ctx, ctx.to_str(node)), node, pat)

    def test_errors(self):
        ctx = self.ctx
        for bad in ["", "(", ")", "a)", "(a", "[a", "[c-a]", "*a", "z", "[z]",
                    "a&", "|a"]:
            with self.assertRaises(ParseError, msg=bad):
                parse(ctx, bad)

    def test_char_outside_alphabet_rejected(self):
        ctx = Context("ab")
        with self.assertRaises(ValueError):
            parse(ctx, "c")
        with self.assertRaises(ValueError):
            parse(ctx, ".").__class__  # '.' 合法
            parse(ctx, "[a-c]")


if __name__ == "__main__":
    unittest.main()
