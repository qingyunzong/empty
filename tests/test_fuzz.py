"""Acceptance A: lexpat is compared against an independent, hand-written
character-by-character reference scanner on 200 random inputs covering
nested block comments and string mode switching."""

import random
import unittest

from lexpat import LexError, Spec, lex

FUZZ_SPEC = Spec([
    {"name": "KW_IF", "regex": "if"},
    {"name": "KW_ELSE", "regex": "else"},
    {"name": "KW_WHILE", "regex": "while"},
    {"name": "IDENT", "regex": "[A-Za-z_][A-Za-z0-9_]*"},
    {"name": "NUMBER", "regex": "[0-9]+"},
    {"name": "WS", "regex": "\\s+", "skip": True},
    {"name": "STR_START", "regex": "\"", "push": "string"},
    {"name": "CMT_START", "regex": "/\\*", "push": "comment"},
    {"name": "STR_END", "regex": "\"", "mode": "string", "pop": True},
    {"name": "STR_ESC", "regex": "\\\\.", "mode": "string"},
    {"name": "STR_TEXT", "regex": "[^\"\\\\]+", "mode": "string"},
    {"name": "CMT_NEST", "regex": "/\\*", "mode": "comment", "push": "comment"},
    {"name": "CMT_END", "regex": "\\*/", "mode": "comment", "pop": True},
    {"name": "CMT_TEXT", "regex": "[^*/]+", "mode": "comment"},
    {"name": "CMT_CH", "regex": "[*/]", "mode": "comment"},
])

KEYWORDS = {"if": "KW_IF", "else": "KW_ELSE", "while": "KW_WHILE"}
IDENT_START = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_"
IDENT_PART = IDENT_START + "0123456789"


class RefError(Exception):
    def __init__(self, line, col, mode):
        super().__init__(f"reference error at {line}:{col} in {mode}")
        self.line = line
        self.col = col
        self.mode = mode


def reference_scan(text):
    """Independent char-by-char scanner; shares no code with lexpat."""
    tokens = []
    pos = 0
    line = 1
    col = 1
    end = len(text)
    mode = "main"
    comment_depth = 0

    def advance(count):
        nonlocal pos, line, col
        for _ in range(count):
            if text[pos] == "\n":
                line += 1
                col = 1
            else:
                col += 1
            pos += 1

    def emit(type_, start, tok_line, tok_col, mode_before):
        tokens.append({
            "type": type_,
            "text": text[start:pos],
            "line": tok_line,
            "col": tok_col,
            "mode_before": mode_before,
            "mode_after": mode,
        })

    while pos < end:
        ch = text[pos]
        start, tok_line, tok_col, mode_before = pos, line, col, mode
        if mode == "main":
            if ch in " \t\r\n":
                while pos < end and text[pos] in " \t\r\n":
                    advance(1)
                continue  # WS is skipped
            if ch in IDENT_START:
                while pos < end and text[pos] in IDENT_PART:
                    advance(1)
                emit(KEYWORDS.get(text[start:pos], "IDENT"),
                     start, tok_line, tok_col, mode_before)
                continue
            if ch.isdigit() and ch in "0123456789":
                while pos < end and text[pos] in "0123456789":
                    advance(1)
                emit("NUMBER", start, tok_line, tok_col, mode_before)
                continue
            if ch == '"':
                advance(1)
                mode = "string"
                emit("STR_START", start, tok_line, tok_col, mode_before)
                continue
            if text.startswith("/*", pos):
                advance(2)
                mode = "comment"
                comment_depth = 1
                emit("CMT_START", start, tok_line, tok_col, mode_before)
                continue
            raise RefError(tok_line, tok_col, mode)
        if mode == "string":
            if ch == '"':
                advance(1)
                mode = "main"
                emit("STR_END", start, tok_line, tok_col, mode_before)
                continue
            if ch == "\\":
                if pos + 1 < end and text[pos + 1] != "\n":
                    advance(2)
                    emit("STR_ESC", start, tok_line, tok_col, mode_before)
                    continue
                raise RefError(tok_line, tok_col, mode)
            while pos < end and text[pos] not in '"\\':
                advance(1)
            emit("STR_TEXT", start, tok_line, tok_col, mode_before)
            continue
        # comment mode
        if text.startswith("/*", pos):
            advance(2)
            comment_depth += 1
            emit("CMT_NEST", start, tok_line, tok_col, mode_before)
            continue
        if text.startswith("*/", pos):
            advance(2)
            comment_depth -= 1
            if comment_depth == 0:
                mode = "main"
            emit("CMT_END", start, tok_line, tok_col, mode_before)
            continue
        if ch not in "*/":
            while pos < end and text[pos] not in "*/":
                advance(1)
            emit("CMT_TEXT", start, tok_line, tok_col, mode_before)
            continue
        advance(1)
        emit("CMT_CH", start, tok_line, tok_col, mode_before)
    if mode != "main":
        raise RefError(line, col, mode)
    return tokens


def gen_string(rng):
    parts = ['"']
    for _ in range(rng.randint(0, 6)):
        kind = rng.randrange(4)
        if kind == 0:
            parts.append(rng.choice(["\\\\", '\\"', "\\t"]))
        elif kind == 1:
            parts.append(rng.choice([" ", "\n", "  "]))
        else:
            parts.append("".join(rng.choice("abcdefg ") for _ in range(rng.randint(1, 5))))
    parts.append('"')
    return "".join(parts)


def gen_comment(rng, depth=0):
    parts = ["/*"]
    for _ in range(rng.randint(0, 5)):
        kind = rng.randrange(8)
        if kind == 0 and depth < 3:
            parts.append(gen_comment(rng, depth + 1))
        elif kind == 1:
            parts.append(rng.choice(["a*b", "x/y", "a*b/c"]))
        elif kind == 2:
            parts.append(rng.choice([" ", "\n", "\t"]))
        else:
            parts.append("".join(rng.choice("abcde 0123") for _ in range(rng.randint(1, 6))))
    parts.append("*/")
    return "".join(parts)


def gen_input(rng):
    pieces = []
    for _ in range(rng.randint(1, 25)):
        kind = rng.randrange(7)
        if kind == 0:
            pieces.append(rng.choice(["if", "else", "while"]))
        elif kind == 1:
            pieces.append("".join(rng.choice(IDENT_START) for _ in range(1))
                            + "".join(rng.choice(IDENT_PART)
                                      for _ in range(rng.randint(0, 6))))
        elif kind == 2:
            pieces.append("".join(rng.choice("0123456789")
                                  for _ in range(rng.randint(1, 5))))
        elif kind == 3:
            pieces.append(rng.choice([" ", "  ", "\n", "\t", "\n\n"]))
        elif kind == 4:
            pieces.append(gen_string(rng))
        elif kind == 5:
            pieces.append(gen_comment(rng))
        else:
            pieces.append(rng.choice([" ", "\n"]))
    return "".join(pieces)


class FuzzTests(unittest.TestCase):
    def test_200_random_inputs_match_reference(self):
        rng = random.Random(20261001)
        for case in range(200):
            text = gen_input(rng)
            with self.subTest(case=case, text=text):
                expected = reference_scan(text)
                got = [t.to_dict() for t in lex(text, FUZZ_SPEC)]
                self.assertEqual(got, expected)

    def test_error_positions_match_reference(self):
        bad_inputs = [
            '"abc',                 # unterminated string
            "/* comment",           # unterminated comment
            "/* a /* b */",         # unterminated nested comment
            "@",                    # unknown character in main
            '"a\\',                 # backslash at end of input
            '"a\\\nb"',             # backslash before newline
            "x */ y",               # stray comment closer in main
            'ok\nok\n"unterminated\nmore',
        ]
        for text in bad_inputs:
            with self.subTest(text=text):
                with self.assertRaises(RefError) as ref_ctx:
                    reference_scan(text)
                with self.assertRaises(LexError) as lex_ctx:
                    lex(text, FUZZ_SPEC)
                ref, err = ref_ctx.exception, lex_ctx.exception
                self.assertEqual((err.line, err.col, err.mode),
                                 (ref.line, ref.col, ref.mode))


if __name__ == "__main__":
    unittest.main()
