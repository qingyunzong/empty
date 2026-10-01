import unittest

from lexpat import LexError, Spec, lex


def make_spec(rules):
    return Spec(rules)


class LongestMatchTests(unittest.TestCase):
    def test_longest_match_wins(self):
        spec = make_spec([
            {"name": "IF", "regex": "if"},
            {"name": "IDENT", "regex": "[a-z]+"},
        ])
        tokens = lex("ifx", spec)
        self.assertEqual([(t.type, t.text) for t in tokens], [("IDENT", "ifx")])

    def test_tie_breaks_by_rule_order(self):
        # Acceptance B: keyword and identifier match the same length,
        # the keyword (lower rule index) wins.
        spec = make_spec([
            {"name": "IF", "regex": "if"},
            {"name": "IDENT", "regex": "[a-z]+"},
        ])
        tokens = lex("if", spec)
        self.assertEqual([(t.type, t.text) for t in tokens], [("IF", "if")])

    def test_tie_break_reverse_order(self):
        spec = make_spec([
            {"name": "IDENT", "regex": "[a-z]+"},
            {"name": "IF", "regex": "if"},
        ])
        tokens = lex("if", spec)
        self.assertEqual([t.type for t in tokens], ["IDENT"])

    def test_skip_rules_emit_no_token(self):
        spec = make_spec([
            {"name": "WS", "regex": "\\s+", "skip": True},
            {"name": "IDENT", "regex": "[a-z]+"},
        ])
        tokens = lex("ab  cd", spec)
        self.assertEqual([(t.type, t.text) for t in tokens],
                         [("IDENT", "ab"), ("IDENT", "cd")])


class ModeStackTests(unittest.TestCase):
    def string_spec(self):
        return make_spec([
            {"name": "WS", "regex": "\\s+", "skip": True},
            {"name": "IDENT", "regex": "[a-z]+"},
            {"name": "STR_START", "regex": "\"", "push": "string"},
            {"name": "STR_END", "regex": "\"", "mode": "string", "pop": True},
            {"name": "STR_TEXT", "regex": "[^\"]+", "mode": "string"},
        ])

    def test_push_pop_and_mode_fields(self):
        tokens = lex('ab "hi" cd', self.string_spec())
        got = [(t.type, t.text, t.mode_before, t.mode_after) for t in tokens]
        self.assertEqual(got, [
            ("IDENT", "ab", "main", "main"),
            ("STR_START", '"', "main", "string"),
            ("STR_TEXT", "hi", "string", "string"),
            ("STR_END", '"', "string", "main"),
            ("IDENT", "cd", "main", "main"),
        ])

    def test_pop_empty_stack_fails(self):
        # Acceptance D: popping when only the start mode remains fails.
        spec = make_spec([
            {"name": "RP", "regex": "\\)", "pop": True},
        ])
        with self.assertRaises(LexError) as ctx:
            lex(")", spec)
        self.assertIn("empty mode stack", str(ctx.exception))

    def test_stack_depth_64_ok_65_fails(self):
        # Acceptance D: depth limit is 64; the 64th push overflows.
        spec = make_spec([
            {"name": "LP", "regex": "\\(", "push": "nest"},
            {"name": "LP", "regex": "\\(", "mode": "nest", "push": "nest"},
            {"name": "RP", "regex": "\\)", "mode": "nest", "pop": True},
        ])
        tokens = lex("(" * 63 + ")" * 63, spec)  # max depth 64: fine
        self.assertEqual(len(tokens), 126)
        with self.assertRaises(LexError) as ctx:
            lex("(" * 64, spec)  # would reach depth 65
        err = ctx.exception
        self.assertIn("stack overflow", str(err))
        self.assertEqual((err.line, err.col), (1, 64))


class ErrorTests(unittest.TestCase):
    def test_empty_match_is_an_error(self):
        spec = make_spec([
            {"name": "AS", "regex": "a*"},
        ])
        with self.assertRaises(LexError) as ctx:
            lex("b", spec)
        err = ctx.exception
        self.assertIn("empty string", str(err))
        self.assertEqual((err.line, err.col, err.mode), (1, 1, "main"))
        self.assertEqual(err.expected, ["AS"])

    def test_unknown_character_reports_position_and_expected(self):
        spec = make_spec([
            {"name": "WS", "regex": "\\s+", "skip": True},
            {"name": "IDENT", "regex": "[a-z]+"},
        ])
        with self.assertRaises(LexError) as ctx:
            lex("ab\n@", spec)
        err = ctx.exception
        self.assertEqual((err.line, err.col, err.mode), (2, 1, "main"))
        self.assertEqual(err.expected, ["WS", "IDENT"])

    def test_unterminated_string_reports_single_precise_error(self):
        # Acceptance C: unterminated string on line 3 -> exactly one
        # LexError, accurately positioned at end of input.
        spec = make_spec([
            {"name": "WS", "regex": "\\s+", "skip": True},
            {"name": "IDENT", "regex": "[a-z]+"},
            {"name": "STR_START", "regex": "\"", "push": "string"},
            {"name": "STR_END", "regex": "\"", "mode": "string", "pop": True},
            {"name": "STR_TEXT", "regex": "[^\"]+", "mode": "string"},
        ])
        errors = []
        try:
            lex('aa\nbb\n"abc', spec)
        except LexError as err:
            errors.append(err)
        self.assertEqual(len(errors), 1)
        err = errors[0]
        self.assertEqual((err.line, err.col), (3, 5))
        self.assertEqual(err.mode, "string")
        self.assertIn("STR_END", err.expected)

    def test_unterminated_nested_comment(self):
        spec = make_spec([
            {"name": "CMT_START", "regex": "/\\*", "push": "comment"},
            {"name": "CMT_NEST", "regex": "/\\*", "mode": "comment",
             "push": "comment"},
            {"name": "CMT_END", "regex": "\\*/", "mode": "comment", "pop": True},
            {"name": "CMT_TEXT", "regex": "[^*/]+", "mode": "comment"},
            {"name": "CMT_CH", "regex": "[*/]", "mode": "comment"},
        ])
        with self.assertRaises(LexError) as ctx:
            lex("/* a /* b */", spec)
        self.assertEqual(ctx.exception.mode, "comment")


class SpecValidationTests(unittest.TestCase):
    def test_capturing_groups_are_forbidden(self):
        with self.assertRaises(ValueError):
            Spec([{"name": "X", "regex": "(ab)+"}])
        # non-capturing groups are fine
        Spec([{"name": "X", "regex": "(?:ab)+"}])

    def test_push_and_pop_conflict(self):
        with self.assertRaises(ValueError):
            Spec([{"name": "X", "regex": "a", "push": "m", "pop": True}])

    def test_invalid_regex(self):
        with self.assertRaises(ValueError):
            Spec([{"name": "X", "regex": "(["}])

    def test_empty_rules_rejected(self):
        with self.assertRaises(ValueError):
            Spec([])


if __name__ == "__main__":
    unittest.main()
