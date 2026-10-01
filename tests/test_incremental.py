import unittest
from unittest import mock

from inclex import (
    Document,
    EditError,
    InternalConsistencyError,
    LexError,
    lex_full,
)


class TestBasicEdits(unittest.TestCase):
    def test_insert_into_ident_relexes_one_token(self):
        doc = Document("foo bar")
        result = doc.edit(3, 3, "baz")  # "foobaz bar"
        self.assertEqual([t.text for t in result.tokens], ["foobaz", "bar"])
        self.assertEqual(result.changed_tokens, 1)  # "bar" reused

    def test_delete_whitespace_merges_tokens(self):
        doc = Document("abc def")
        result = doc.edit(3, 4, "")  # "abcdef"
        self.assertEqual([t.text for t in result.tokens], ["abcdef"])
        self.assertEqual(result.changed_tokens, 1)

    def test_pure_deletion_shifts_suffix_without_relexing(self):
        doc = Document("a b")
        result = doc.edit(0, 2, "")  # "b"
        self.assertEqual([t.text for t in result.tokens], ["b"])
        self.assertEqual(result.changed_tokens, 0)

    def test_sequential_edits(self):
        doc = Document("x = 1")
        doc.edit(4, 5, "2")
        result = doc.edit(0, 0, "y ; ")
        self.assertEqual(doc.text, "y ; x = 2")
        self.assertEqual(result.tokens, lex_full(doc.text))


class TestBlockCommentSuffix(unittest.TestCase):
    """Acceptance B: inserting */ inside a block comment."""

    def test_insert_terminator_inside_block_comment(self):
        doc = Document("a /* hello */ b")
        result = doc.edit(7, 7, "*/")
        self.assertEqual(doc.text, "a /* he*/llo */ b")
        self.assertEqual(
            [(t.type, t.text) for t in result.tokens],
            [
                ("IDENT", "a"),
                ("BLOCK_COMMENT", "/* he*/"),
                ("IDENT", "llo"),
                ("OP", "*"),
                ("OP", "/"),
                ("IDENT", "b"),
            ],
        )
        # Only the necessary suffix was re-lexed: "a" untouched, "b" reused.
        self.assertEqual(result.changed_tokens, 4)
        self.assertEqual(result.tokens, lex_full(doc.text))


class TestStringQuoteDeletion(unittest.TestCase):
    """Acceptance C: deleting a string quote rescans the whole suffix."""

    def test_deleted_quote_rescans_to_eof(self):
        # One quote hides inside the trailing block comment; deleting the
        # closing quote of "a" makes it live, so every token boundary up
        # to EOF shifts and no old token can be reused.
        doc = Document('"a" m "b" /* " */')
        result = doc.edit(2, 3, "")  # delete closing quote of "a"
        self.assertEqual(doc.text, '"a m "b" /* " */')
        self.assertEqual(
            [(t.type, t.text) for t in result.tokens],
            [
                ("STRING", '"a m "'),
                ("IDENT", "b"),
                ("STRING", '" /* "'),
                ("OP", "*"),
                ("OP", "/"),
            ],
        )
        # Everything from the edit point to EOF was re-lexed.
        self.assertEqual(result.changed_tokens, len(result.tokens))
        self.assertEqual(result.tokens, lex_full(doc.text))


class TestBoundaries(unittest.TestCase):
    """Acceptance D: out-of-bounds edits and empty-file edges."""

    def test_empty_document(self):
        doc = Document("")
        self.assertEqual(doc.tokens, [])
        result = doc.edit(0, 0, "x")
        self.assertEqual([t.text for t in result.tokens], ["x"])
        result = doc.edit(1, 1, "")
        self.assertEqual([t.text for t in result.tokens], ["x"])
        result = doc.edit(0, 1, "")
        self.assertEqual(result.tokens, [])
        self.assertEqual(doc.text, "")

    def test_out_of_bounds_edits(self):
        doc = Document("abc")
        for start, end in [(-1, 0), (0, 4), (2, 1), (0, 99), (-3, -1)]:
            with self.assertRaises(EditError):
                doc.edit(start, end, "")
        self.assertEqual(doc.text, "abc")  # untouched by failed edits

    def test_out_of_bounds_on_empty_document(self):
        doc = Document("")
        with self.assertRaises(EditError):
            doc.edit(0, 1, "")
        with self.assertRaises(EditError):
            doc.edit(1, 1, "x")

    def test_edit_error_carries_offset_and_state(self):
        doc = Document("abc")
        with self.assertRaises(EditError) as ctx:
            doc.edit(0, 99, "")
        self.assertEqual(ctx.exception.offset, 99)
        self.assertEqual(ctx.exception.state, "main")

    def test_failed_edit_leaves_document_unchanged(self):
        doc = Document('a "b" c')
        with self.assertRaises(LexError) as ctx:
            doc.edit(4, 5, "")  # delete closing quote -> unterminated
        self.assertEqual(ctx.exception.offset, 2)
        self.assertEqual(ctx.exception.state, "in_string")
        self.assertEqual(doc.text, 'a "b" c')
        self.assertEqual(doc.tokens, lex_full('a "b" c'))

    def test_unterminated_block_comment_via_edit(self):
        doc = Document("a */ b")
        with self.assertRaises(LexError) as ctx:
            doc.edit(2, 3, "/*")  # "a /*/ b" -> opens a block comment
        self.assertEqual(ctx.exception.state, "in_block_comment")


class TestInternalAssertion(unittest.TestCase):
    def test_divergence_raises_internal_error(self):
        doc = Document("a b")
        with mock.patch("inclex.incremental.lex_full",
                        return_value=["bogus"]):
            with self.assertRaises(InternalConsistencyError):
                doc.edit(0, 0, "c ")
        # Document stays consistent after the failed assertion path.
        self.assertEqual(doc.text, "a b")


if __name__ == "__main__":
    unittest.main()
