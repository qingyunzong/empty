"""Acceptance A: 500 random small edits must agree with a full rescan
and with an independent regex-based reference scanner."""
import random
import unittest

from inclex import Document, LexError, lex_full

from reference import RefLexError, reference_lex

PIECES = [
    "foo", "bar", "x1", "_tmp", "a", "b",
    "42", "3.14", "0", "7",
    '"hello"', '"a\\"b"', "'s'", '"x y"',
    "// cmt\n", "//\n",
    "/* blk */", "/* multi\nline */", "/**/",
    "+", "-", "*", "/", "==", "&&", "<=", "++", "<<",
    "(", ")", ";", ",", "=", "<", ">", "!", "{", "}",
    " ", "\n", "  ", "\t", "\n\n",
]

EDIT_CHARS = list("abcXZ019_ \n\"'/*=+;.<") + ["//", "*/", "/*", "\\", "@", "é"]


def random_document_text(rng, pieces=60):
    return "".join(rng.choice(PIECES) for _ in range(pieces))


class TestRandomEdits(unittest.TestCase):
    def test_500_random_small_edits(self):
        rng = random.Random(20261001)
        expected_text = random_document_text(rng)
        # The piece alphabet always lexes cleanly.
        reference_lex(expected_text)
        doc = Document(expected_text)

        stats = {"ok": 0, "lex_error": 0, "reused": 0}
        for _ in range(500):
            n = len(expected_text)
            start = rng.randint(0, n)
            end = min(n, start + rng.randint(0, 4))
            replacement = "".join(
                rng.choice(EDIT_CHARS) for _ in range(rng.randint(0, 4))
            )
            new_text = expected_text[:start] + replacement + expected_text[end:]

            try:
                ref_tokens = reference_lex(new_text)
            except RefLexError as ref_err:
                # Incremental edit must fail the same way, at the same
                # offset and state, and leave the document untouched.
                with self.assertRaises(LexError) as ctx:
                    doc.edit(start, end, replacement)
                self.assertEqual(ctx.exception.offset, ref_err.offset)
                self.assertEqual(ctx.exception.state, ref_err.state)
                self.assertEqual(doc.text, expected_text)
                stats["lex_error"] += 1
                continue

            result = doc.edit(start, end, replacement)

            # 1) identical to the independent reference scanner
            self.assertEqual(
                [(t.type, t.text, t.start, t.end) for t in result.tokens],
                ref_tokens,
            )
            # 2) identical to a full rescan
            self.assertEqual(result.tokens, lex_full(new_text))
            # 3) changed_tokens never exceeds the token count
            self.assertLessEqual(result.changed_tokens, len(result.tokens))
            if result.changed_tokens < len(result.tokens):
                stats["reused"] += 1
            stats["ok"] += 1
            expected_text = new_text

        # Sanity: the run actually exercised both paths.
        self.assertGreater(stats["ok"], 0)
        self.assertGreater(stats["lex_error"], 0)
        self.assertGreater(stats["reused"], 0)


if __name__ == "__main__":
    unittest.main()
