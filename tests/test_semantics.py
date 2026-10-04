import unittest

from pathpolicy.normalize import PathError
from pathpolicy.ruleset import Minus, Pattern, Union, expr_from_json, expr_match


def m(pattern, path):
    return expr_match(Pattern(pattern), path)


class SegmentSemanticsTests(unittest.TestCase):
    def test_literal(self):
        self.assertTrue(m("a/b", "a/b"))
        self.assertFalse(m("a/b", "a/c"))
        self.assertFalse(m("a/b", "a/b/c"))
        self.assertFalse(m("a/b", "a"))

    def test_star_matches_exactly_one_segment(self):
        self.assertTrue(m("a/*", "a/b"))
        self.assertTrue(m("a/*", "a/xyz"))
        self.assertFalse(m("a/*", "a"))
        self.assertFalse(m("a/*", "a/b/c"))

    def test_star_never_matches_empty_segment(self):
        # "a//b" normalizes to "a/b", so this is the same path, not an
        # empty segment matched by '*'.
        self.assertTrue(m("a/*", "a//b"))
        self.assertFalse(m("*", ""))

    def test_question_mark_single_char(self):
        self.assertTrue(m("a/?", "a/x"))
        self.assertFalse(m("a/?", "a/xy"))
        self.assertFalse(m("a/?", "a"))

    def test_char_class(self):
        self.assertTrue(m("a/[bc]", "a/b"))
        self.assertTrue(m("a/[bc]", "a/c"))
        self.assertFalse(m("a/[bc]", "a/d"))

    def test_char_class_range(self):
        self.assertTrue(m("a/[0-9]", "a/7"))
        self.assertFalse(m("a/[0-9]", "a/x"))

    def test_char_class_complement(self):
        self.assertTrue(m("a/[^bc]", "a/d"))
        self.assertFalse(m("a/[^bc]", "a/b"))
        self.assertFalse(m("a/[^bc]", "a/c"))

    def test_escaped_metacharacters_are_literal(self):
        self.assertTrue(m(r"a/\*", "a/*"))
        self.assertTrue(m(r"a/\?", "a/?"))
        self.assertFalse(m(r"a/\*", "a/b"))

    def test_root_pattern_matches_only_root(self):
        self.assertTrue(m("", ""))
        self.assertFalse(m("", "a"))


class DoubleStarTests(unittest.TestCase):
    def test_zero_segments_in_the_middle(self):
        self.assertTrue(m("a/**/b", "a/b"))

    def test_zero_segments_at_the_end(self):
        self.assertTrue(m("a/**", "a"))

    def test_zero_segments_at_the_start(self):
        self.assertTrue(m("**/b", "b"))

    def test_starstar_alone_matches_everything_including_root(self):
        self.assertTrue(m("**", ""))
        self.assertTrue(m("**", "x"))
        self.assertTrue(m("**", "x/y/z"))

    def test_multiple_segments(self):
        self.assertTrue(m("a/**/b", "a/x/b"))
        self.assertTrue(m("a/**/b", "a/x/y/z/b"))
        self.assertFalse(m("a/**/b", "a/x/y/z"))
        self.assertFalse(m("a/**/b", "x/a/b"))

    def test_consecutive_double_stars(self):
        self.assertTrue(m("a/**/**/b", "a/b"))
        self.assertTrue(m("a/**/**/b", "a/x/y/b"))
        self.assertTrue(m("**/**", "x/y"))

    def test_no_empty_segments_or_stray_separators(self):
        # Every string the automaton accepts must be a legal normalized
        # path; the interpreter cross-checks this exhaustively elsewhere.
        self.assertFalse(m("a/**/b", "a"))
        self.assertFalse(m("a/**/b", "ab"))
        self.assertFalse(m("a/**", ""))


class RuleSetTests(unittest.TestCase):
    def test_union(self):
        expr = Union((Pattern("a/b"), Pattern("c/d")))
        self.assertTrue(expr_match(expr, "a/b"))
        self.assertTrue(expr_match(expr, "c/d"))
        self.assertFalse(expr_match(expr, "a/d"))

    def test_minus(self):
        expr = Minus(Pattern("**"), Pattern("secret/**"))
        self.assertTrue(expr_match(expr, "a/b"))
        self.assertFalse(expr_match(expr, "secret"))
        self.assertFalse(expr_match(expr, "secret/key"))

    def test_minus_is_relative_to_legal_paths(self):
        # The root path is legal and is in "**" but not in "a".
        expr = Minus(Pattern("**"), Pattern("a"))
        self.assertTrue(expr_match(expr, ""))
        self.assertFalse(expr_match(expr, "a"))

    def test_policy_allow_deny_interaction(self):
        policy = expr_from_json({"allow": ["**"], "deny": ["secret/**", "tmp/*"]})
        self.assertTrue(expr_match(policy, "src/main.py"))
        self.assertFalse(expr_match(policy, "secret"))
        self.assertFalse(expr_match(policy, "secret/key"))
        self.assertFalse(expr_match(policy, "tmp/scratch"))
        self.assertTrue(expr_match(policy, "tmp/scratch/deeper"))

    def test_policy_deny_only_defaults_to_allow_all(self):
        policy = expr_from_json({"deny": ["private/**"]})
        self.assertTrue(expr_match(policy, "public/x"))
        self.assertFalse(expr_match(policy, "private/x"))

    def test_normalization_makes_inputs_equal(self):
        self.assertTrue(expr_match(Pattern("a/b"), "a//./b/"))
        self.assertTrue(expr_match(Pattern("a/b"), "a/c/../b"))

    def test_match_rejects_root_escape(self):
        with self.assertRaises(PathError):
            expr_match(Pattern("**"), "../escape")


if __name__ == "__main__":
    unittest.main()
