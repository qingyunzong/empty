"""Tests for inclex: full lexing, incremental re-lexing, CLI."""

from __future__ import annotations

import contextlib
import io
import json
import os
import random
import re
import tempfile
import unittest
from unittest import mock

from inclex import (
    EditError,
    IncrementalLexer,
    InternalConsistencyError,
    LexError,
    LexerState,
    lex,
)
from inclex.__main__ import main as cli_main


# ---------------------------------------------------------------------------
# Independent reference scanner (regex based, separate implementation).
# ---------------------------------------------------------------------------

class RefLexError(Exception):
    def __init__(self, message, offset):
        self.offset = offset
        super().__init__(message)


_REF_RE = re.compile(
    r"""
      (?P<IDENT>[A-Za-z_][A-Za-z0-9_]*)
    | (?P<NUMBER>[0-9]+(?:\.[0-9]+)?)
    | (?P<STRING>"(?:\\.|[^"\\\n])*(?P<STRCLOSE>")?)
    | (?P<LINE_COMMENT>//[^\n]*)
    | (?P<BLOCK_COMMENT>/\*.*?\*/|/\*.*)
    | (?P<OP>==|!=|<=|>=|&&|\|\||\+=|-=|\*=|/=|->
           |[-+*/=<>!&|(){}[\];,.:])
    | (?P<WS>\s+)
    | (?P<MISMATCH>.)
    """,
    re.VERBOSE | re.DOTALL,
)


def reference_lex(source):
    """Return [(type, start, end, value), ...] or raise RefLexError."""
    out = []
    pos = 0
    n = len(source)
    while pos < n:
        m = _REF_RE.match(source, pos)
        assert m is not None
        kind = m.lastgroup
        if kind == "WS":
            pass
        elif kind == "MISMATCH":
            raise RefLexError("unexpected character", pos)
        elif kind == "STRING":
            if m.group("STRCLOSE") is None:
                raise RefLexError("unterminated string", pos)
            out.append(("STRING", m.start(), m.end(), m.group()))
        elif kind == "BLOCK_COMMENT":
            if not m.group().endswith("*/"):
                raise RefLexError("unterminated block comment", pos)
            out.append(("BLOCK_COMMENT", m.start(), m.end(), m.group()))
        else:
            out.append((kind, m.start(), m.end(), m.group()))
        pos = m.end()
    return out


def plain(tokens):
    return [(t.type, t.start, t.end, t.value) for t in tokens]


# ---------------------------------------------------------------------------
# Full-lexer unit tests.
# ---------------------------------------------------------------------------

class TestFullLex(unittest.TestCase):
    def test_all_token_types(self):
        src = 'foo 42 3.14 "hi\\n" // line\n/* block\nspan */ a == b + (c);'
        toks = lex(src)
        types = [t.type for t in toks]
        self.assertEqual(
            types,
            [
                "IDENT", "NUMBER", "NUMBER", "STRING", "LINE_COMMENT",
                "BLOCK_COMMENT", "IDENT", "OP", "IDENT", "OP", "OP",
                "IDENT", "OP", "OP",
            ],
        )
        self.assertEqual(toks[0].value, "foo")
        self.assertEqual(toks[3].value, '"hi\\n"')
        self.assertEqual(toks[5].value, "/* block\nspan */")
        self.assertEqual(toks[7].value, "==")

    def test_block_comment_not_nested(self):
        toks = lex("/* a /* b */ c")
        self.assertEqual(toks[0].type, "BLOCK_COMMENT")
        self.assertEqual(toks[0].value, "/* a /* b */")
        self.assertEqual(toks[1].type, "IDENT")

    def test_offsets_and_state(self):
        src = 'ab "cd"'
        toks = lex(src)
        self.assertEqual((toks[1].start, toks[1].end), (3, 7))
        self.assertTrue(all(t.state is LexerState.MAIN for t in toks))

    def test_unterminated_string(self):
        with self.assertRaises(LexError) as cm:
            lex('x = "abc')
        self.assertEqual(cm.exception.offset, 4)
        self.assertIs(cm.exception.state, LexerState.IN_STRING)

    def test_unterminated_block_comment(self):
        with self.assertRaises(LexError) as cm:
            lex("a /* never ends")
        self.assertEqual(cm.exception.offset, 2)
        self.assertIs(cm.exception.state, LexerState.IN_BLOCK_COMMENT)

    def test_unexpected_character(self):
        with self.assertRaises(LexError) as cm:
            lex("a @ b")
        self.assertEqual(cm.exception.offset, 2)
        self.assertIs(cm.exception.state, LexerState.MAIN)

    def test_empty_source(self):
        self.assertEqual(lex(""), [])
        self.assertEqual(lex("  \n\t "), [])

    def test_matches_reference_on_samples(self):
        samples = [
            'a1_ 0 00.5 6. "x\\"" // y\n/*z*/ == != <= >= && || += -= *= /= ->',
            "/ /*/ */ //",
            '"a" "b\\n c" 1.2.3',
        ]
        for src in samples:
            self.assertEqual(plain(lex(src)), reference_lex(src), src)


# ---------------------------------------------------------------------------
# Incremental re-lexing tests.
# ---------------------------------------------------------------------------

class TestIncremental(unittest.TestCase):
    DOC = (
        'def foo(x, y) {\n'
        '  a = 1.5 + x2; // sum\n'
        '  /* multi\n'
        '     line comment */\n'
        '  s = "hello \\"world\\"";\n'
        '  if (a >= 2 && b != 3) { c += 1; }\n'
        '}\n'
    )

    def setUp(self):
        self.lexer = IncrementalLexer(self.DOC)

    def _check(self, start, end, text):
        new_source = self.lexer.source[:start] + text + self.lexer.source[end:]
        changed = self.lexer.apply_edit(start, end, text)
        self.assertEqual(self.lexer.source, new_source)
        self.assertEqual(plain(self.lexer.tokens), reference_lex(new_source))
        return changed

    def test_small_edit_reuses_suffix(self):
        # Rename the first identifier; everything else must be reused.
        changed = self._check(4, 7, "bar")
        self.assertEqual(changed, 1)
        self.assertEqual(self.lexer.tokens[1].value, "bar")

    def test_noop_edit_changes_nothing(self):
        changed = self._check(0, 0, "")
        self.assertEqual(changed, 0)

    def test_merge_tokens_across_deleted_space(self):
        src = "ab cd"
        lx = IncrementalLexer(src)
        changed = lx.apply_edit(2, 3, "")  # delete the space
        self.assertEqual(plain(lx.tokens), [("IDENT", 0, 4, "abcd")])
        self.assertEqual(changed, 1)

    def test_split_token_by_inserted_space(self):
        lx = IncrementalLexer("abcd")
        lx.apply_edit(2, 2, " ")
        self.assertEqual(plain(lx.tokens), [("IDENT", 0, 2, "ab"),
                                            ("IDENT", 3, 5, "cd")])

    def test_block_comment_insert_terminator(self):
        # Acceptance B: inserting */ inside a block comment only affects
        # the necessary suffix; tokens after the old comment are reused.
        src = "head /* c1 c2 c3 */ tail1 tail2"
        lx = IncrementalLexer(src)
        n_before = len(lx.tokens)
        changed = lx.apply_edit(11, 11, "*/ ")
        full = lex(lx.source)
        self.assertEqual(plain(lx.tokens), plain(full))
        self.assertEqual(plain(lx.tokens), reference_lex(lx.source))
        # The old comment split into comment + code tokens; the two tail
        # identifiers must have been reused, not re-scanned.
        self.assertEqual(changed, len(lx.tokens) - 1 - 2)
        self.assertEqual(lx.tokens[-1].value, "tail2")
        self.assertEqual(n_before, 4)

    def test_delete_string_quote_rescans_everything_after(self):
        # Acceptance C: deleting the opening quote re-pairs all later
        # quotes, so the whole rest of the file is re-scanned.
        src = 's = "abc"; t = 1; // "trailing'
        lx = IncrementalLexer(src)
        start = src.index('"')
        changed = lx.apply_edit(start, start + 1, "")
        self.assertEqual(plain(lx.tokens), reference_lex(lx.source))
        # Nothing could be reused: every token after the kept prefix
        # (the leading `s =`) had to be re-scanned.
        self.assertEqual(changed, len(lx.tokens) - 2)
        self.assertGreater(changed, 1)

    def test_edit_inside_string_only_rescans_string(self):
        src = 'a = "hello world"; b = 2'
        lx = IncrementalLexer(src)
        changed = lx.apply_edit(11, 12, "W")
        self.assertEqual(changed, 1)
        self.assertEqual(lx.tokens[2].value, '"hello World"')

    def test_sequential_edits(self):
        self._check(0, 3, "func")
        self._check(len(self.lexer.source), len(self.lexer.source), "// eof")
        self._check(0, 0, "/*pre*/ ")

    def test_number_lookahead_merges_across_edit(self):
        # "1." + inserted digit must merge into a single NUMBER token.
        lx = IncrementalLexer("1.x")
        lx.apply_edit(2, 3, "5")
        self.assertEqual(plain(lx.tokens), [("NUMBER", 0, 3, "1.5")])
        lx2 = IncrementalLexer("1.")
        lx2.apply_edit(2, 2, "5")  # insertion at EOF replaces EOF terminator
        self.assertEqual(plain(lx2.tokens), [("NUMBER", 0, 3, "1.5")])

    def test_edit_creating_unterminated_constructs(self):
        lx = IncrementalLexer('a "b" c')
        with self.assertRaises(LexError) as cm:
            lx.apply_edit(2, 3, "")  # delete opening quote -> dangling
        self.assertIs(cm.exception.state, LexerState.IN_STRING)
        # Failed edit must leave the lexer untouched.
        self.assertEqual(lx.source, 'a "b" c')
        self.assertEqual(plain(lx.tokens), reference_lex('a "b" c'))
        with self.assertRaises(LexError) as cm:
            lx.apply_edit(0, 0, "/*")
        self.assertIs(cm.exception.state, LexerState.IN_BLOCK_COMMENT)
        self.assertEqual(lx.source, 'a "b" c')

    def test_bounds_and_empty_file(self):
        # Acceptance D: out-of-range edits and empty-file edges.
        lx = IncrementalLexer("")
        self.assertEqual(lx.tokens, [])
        for bad in [(-1, 0), (0, 1), (1, 1), (2, 5)]:
            with self.assertRaises(EditError) as cm:
                lx.apply_edit(bad[0], bad[1], "x")
            self.assertIsNotNone(cm.exception.offset)
            self.assertIs(cm.exception.state, LexerState.MAIN)
        self.assertEqual(lx.tokens, [])
        changed = lx.apply_edit(0, 0, "x = 1")
        self.assertEqual(changed, 3)
        with self.assertRaises(EditError):
            lx.apply_edit(0, 99, "")
        with self.assertRaises(EditError):
            lx.apply_edit(4, 2, "")
        self.assertEqual(lx.source, "x = 1")

    def test_internal_consistency_assertion(self):
        # Force a divergence: the safety net must raise (exit code 11).
        lx = IncrementalLexer("a b c")
        with mock.patch("inclex.lexer.lex", return_value=[]):
            with self.assertRaises(InternalConsistencyError):
                lx.apply_edit(0, 1, "z")

    def test_random_small_edits_500(self):
        # Acceptance A: 500 random small edits; incremental result must
        # match both a full re-lex and the independent reference scanner.
        rng = random.Random(20261004)
        pieces = [
            "foo", "bar", "x1", "_y", "123", "4.5", "0", '"str"', '"a\\"b"',
            "// c\n", "/* blk */", "/* multi\nline */", "+", "-", "==", "!=",
            "<=", "&&", "(", ")", "{", "}", ";", "=", "<", "/", "*", "->",
        ]
        doc = " ".join(rng.choice(pieces) for _ in range(60))
        lx = IncrementalLexer(doc)
        alphabet = [
            "a", "Z", "q", "0", "5", " ", "\n", "\t", '"', "\\", "/*", "*/",
            "//", "+", "==", "(", ")", ";", "=", ".", "_", "xyz", "1.5",
        ]
        for i in range(500):
            n = len(lx.source)
            start = rng.randint(0, n)
            end = min(n, start + rng.randint(0, 4))
            text = "".join(rng.choice(alphabet) for _ in range(rng.randint(0, 4)))
            new_source = lx.source[:start] + text + lx.source[end:]
            try:
                expected = reference_lex(new_source)
            except RefLexError:
                with self.assertRaises(LexError, msg=f"iter {i}"):
                    lx.apply_edit(start, end, text)
                with self.assertRaises(LexError):
                    lex(new_source)
                # Lexer state survives the failed edit.
                self.assertEqual(plain(lx.tokens), reference_lex(lx.source))
                continue
            lx.apply_edit(start, end, text)
            self.assertEqual(
                plain(lx.tokens), expected, f"iter {i}: edit [{start},{end}) {text!r}"
            )


# ---------------------------------------------------------------------------
# CLI tests.
# ---------------------------------------------------------------------------

class TestCLI(unittest.TestCase):
    def _run(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli_main(argv)
        return code, out.getvalue(), err.getvalue()

    def _write(self, data, mode="wb"):
        fd, path = tempfile.mkstemp()
        with os.fdopen(fd, mode) as fh:
            fh.write(data)
        self.addCleanup(os.unlink, path)
        return path

    def test_basic_output_jsonl(self):
        path = self._write(b"a = 1")
        code, out, _ = self._run([path])
        self.assertEqual(code, 0)
        lines = out.splitlines()
        self.assertEqual(lines[0], "changed_tokens: 0")
        toks = [json.loads(line) for line in lines[1:]]
        self.assertEqual(
            toks,
            [
                {"type": "IDENT", "start": 0, "end": 1, "value": "a"},
                {"type": "OP", "start": 2, "end": 3, "value": "="},
                {"type": "NUMBER", "start": 4, "end": 5, "value": "1"},
            ],
        )

    def test_edit_flag(self):
        path = self._write(b"a = 1")
        code, out, _ = self._run([path, "--edit", "4,5,2"])
        self.assertEqual(code, 0)
        lines = out.splitlines()
        self.assertEqual(lines[0], "changed_tokens: 1")
        toks = [json.loads(line) for line in lines[1:]]
        self.assertEqual(toks[-1]["value"], "2")

    def test_multiple_edits_sequential(self):
        path = self._write(b"ab")
        code, out, _ = self._run([path, "--edit", "0,0,x", "--edit", "3,3,y"])
        self.assertEqual(code, 0)
        toks = [json.loads(line) for line in out.splitlines()[1:]]
        self.assertEqual(toks, [{"type": "IDENT", "start": 0, "end": 4,
                                 "value": "xaby"}])

    def test_invalid_utf8(self):
        path = self._write(b"a \xff b")
        code, _, err = self._run([path])
        self.assertEqual(code, 3)
        self.assertIn("EditError", err)
        self.assertIn("offset=2", err)

    def test_out_of_bounds_edit(self):
        path = self._write(b"abc")
        code, _, err = self._run([path, "--edit", "0,10,x"])
        self.assertEqual(code, 3)
        self.assertIn("EditError", err)

    def test_lex_error_exit_code(self):
        path = self._write(b'a = "unterminated')
        code, _, err = self._run([path])
        self.assertEqual(code, 4)
        self.assertIn("LexError", err)
        self.assertIn("state=in_string", err)

    def test_bad_edit_spec(self):
        path = self._write(b"abc")
        code, _, err = self._run([path, "--edit", "bogus"])
        self.assertEqual(code, 2)

    def test_internal_error_exit_11(self):
        path = self._write(b"a b c")
        with mock.patch("inclex.lexer.lex", return_value=[]):
            code, _, err = self._run([path, "--edit", "0,1,z"])
        self.assertEqual(code, 11)
        self.assertIn("InternalConsistencyError", err)

    def test_empty_file(self):
        path = self._write(b"")
        code, out, _ = self._run([path, "--edit", "0,0,hi"])
        self.assertEqual(code, 0)
        lines = out.splitlines()
        self.assertEqual(lines[0], "changed_tokens: 1")
        self.assertEqual(json.loads(lines[1])["value"], "hi")


if __name__ == "__main__":
    unittest.main()
