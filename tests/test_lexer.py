import unittest

from inclex import LexError, lex_full
from inclex.lexer import (
    STATE_IN_BLOCK_COMMENT,
    STATE_IN_STRING,
    STATE_MAIN,
)


def kinds(text):
    return [(t.type, t.text) for t in lex_full(text)]


class TestLexerBasics(unittest.TestCase):
    def test_empty_text(self):
        self.assertEqual(lex_full(""), [])

    def test_whitespace_only(self):
        self.assertEqual(lex_full("  \n\t \r\n"), [])

    def test_idents_numbers_ops(self):
        self.assertEqual(
            kinds("foo bar_1 42 3.14 + == ;"),
            [
                ("IDENT", "foo"),
                ("IDENT", "bar_1"),
                ("NUMBER", "42"),
                ("NUMBER", "3.14"),
                ("OP", "+"),
                ("OP", "=="),
                ("OP", ";"),
            ],
        )

    def test_number_dot_without_trailing_digit(self):
        self.assertEqual(kinds("3."), [("NUMBER", "3"), ("OP", ".")])

    def test_multi_char_ops_preferred(self):
        self.assertEqual(
            kinds("a==b a<=b a&&b a<<= "),
            [
                ("IDENT", "a"), ("OP", "=="), ("IDENT", "b"),
                ("IDENT", "a"), ("OP", "<="), ("IDENT", "b"),
                ("IDENT", "a"), ("OP", "&&"), ("IDENT", "b"),
                ("IDENT", "a"), ("OP", "<<"), ("OP", "="),
            ],
        )

    def test_string_with_escapes(self):
        toks = lex_full(r'"a\"b" "c\\"')
        self.assertEqual([t.text for t in toks], [r'"a\"b"', r'"c\\"'])

    def test_single_quoted_string(self):
        self.assertEqual(kinds("'it' x"), [("STRING", "'it'"),
                                           ("IDENT", "x")])

    def test_line_comment_runs_to_newline(self):
        self.assertEqual(
            kinds("// hi \" /* \nx"),
            [("LINE_COMMENT", '// hi " /* '), ("IDENT", "x")],
        )

    def test_block_comment_multiline_not_nested(self):
        toks = lex_full("/* a\nb */ x /* c /* d */ y")
        self.assertEqual(
            [(t.type, t.text) for t in toks],
            [
                ("BLOCK_COMMENT", "/* a\nb */"),
                ("IDENT", "x"),
                ("BLOCK_COMMENT", "/* c /* d */"),  # ends at first */
                ("IDENT", "y"),
            ],
        )

    def test_token_positions_and_start_state(self):
        toks = lex_full("a  /* x */ b")
        self.assertEqual(
            [(t.start, t.end) for t in toks],
            [(0, 1), (3, 10), (11, 12)],
        )
        self.assertTrue(all(t.state == STATE_MAIN for t in toks))


class TestLexerErrors(unittest.TestCase):
    def test_unterminated_string_eof(self):
        with self.assertRaises(LexError) as ctx:
            lex_full('ab "cd')
        self.assertEqual(ctx.exception.offset, 3)
        self.assertEqual(ctx.exception.state, STATE_IN_STRING)

    def test_unterminated_string_newline(self):
        with self.assertRaises(LexError) as ctx:
            lex_full('"ab\ncd"')
        self.assertEqual(ctx.exception.offset, 0)
        self.assertEqual(ctx.exception.state, STATE_IN_STRING)

    def test_unterminated_block_comment(self):
        with self.assertRaises(LexError) as ctx:
            lex_full("ok /* never closed")
        self.assertEqual(ctx.exception.offset, 3)
        self.assertEqual(ctx.exception.state, STATE_IN_BLOCK_COMMENT)

    def test_unexpected_character(self):
        with self.assertRaises(LexError) as ctx:
            lex_full("a @ b")
        self.assertEqual(ctx.exception.offset, 2)
        self.assertEqual(ctx.exception.state, STATE_MAIN)

    def test_non_ascii_unexpected(self):
        with self.assertRaises(LexError):
            lex_full("café")


if __name__ == "__main__":
    unittest.main()
