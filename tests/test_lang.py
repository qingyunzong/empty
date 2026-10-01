"""Unit tests for the lexer and parser."""
import unittest

from mmcheck.lang import (
    INT,
    Bin,
    Call,
    Fun,
    Let,
    Num,
    ParseError,
    Var,
    parse,
    tokenize,
)


class TestLexer(unittest.TestCase):
    def test_tokens_and_lines(self):
        toks = tokenize("let x: Int = 1\nlet y = x + 2\n")
        kinds = [t.kind for t in toks]
        self.assertEqual(
            kinds,
            ["NAME", "NAME", ":", "NAME", "=", "INT", "NEWLINE",
             "NAME", "NAME", "=", "NAME", "+", "INT", "NEWLINE", "EOF"],
        )
        self.assertEqual(toks[5].line, 1)
        self.assertEqual(toks[12].line, 2)

    def test_comments_and_arrow(self):
        toks = tokenize("# hi\nfun f(a: Int) -> Int = a\n")
        kinds = [t.kind for t in toks]
        self.assertIn("ARROW", kinds)
        self.assertNotIn("#", kinds)

    def test_unexpected_character(self):
        with self.assertRaises(ParseError) as ctx:
            tokenize("let x = 1 @ 2")
        self.assertEqual(ctx.exception.line, 1)


class TestParser(unittest.TestCase):
    def test_let_with_annotation(self):
        mod = parse("let x: Int = 1\n")
        self.assertEqual(len(mod.decls), 1)
        decl = mod.decls[0]
        self.assertIsInstance(decl, Let)
        self.assertEqual(decl.name, "x")
        self.assertEqual(decl.ann, INT)
        self.assertIsInstance(decl.expr, Num)

    def test_let_without_annotation(self):
        mod = parse("let y = 2\n")
        self.assertIsNone(mod.decls[0].ann)

    def test_fun(self):
        mod = parse("fun add(a: Int, b: Int) -> Int = a + b\n")
        decl = mod.decls[0]
        self.assertIsInstance(decl, Fun)
        self.assertEqual(decl.name, "add")
        self.assertEqual([p for p, _ in decl.params], ["a", "b"])
        self.assertEqual(decl.ret, INT)
        self.assertIsInstance(decl.body, Bin)

    def test_import(self):
        mod = parse("import util\nimport base\n")
        self.assertEqual([m for m, _ in mod.imports], ["util", "base"])

    def test_precedence(self):
        mod = parse("let x = 1 + 2 * 3\n")
        expr = mod.decls[0].expr
        self.assertIsInstance(expr, Bin)
        self.assertEqual(expr.op, "+")
        self.assertIsInstance(expr.right, Bin)
        self.assertEqual(expr.right.op, "*")

    def test_call(self):
        mod = parse("let x = f(1, 2)\n")
        expr = mod.decls[0].expr
        self.assertIsInstance(expr, Call)
        self.assertIsInstance(expr.func, Var)
        self.assertEqual(len(expr.args), 2)

    def test_parse_error_line(self):
        with self.assertRaises(ParseError) as ctx:
            parse("let x = 1\nlet y = \n")
        self.assertEqual(ctx.exception.line, 2)

    def test_parse_error_bad_type(self):
        with self.assertRaises(ParseError):
            parse("let x: Bool = 1\n")

    def test_empty_source(self):
        mod = parse("\n# nothing\n")
        self.assertEqual(mod.decls, [])
        self.assertEqual(mod.imports, [])


if __name__ == "__main__":
    unittest.main()
