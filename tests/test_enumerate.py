import unittest

from pathpolicy.enumerate import cross_check, legal_paths
from pathpolicy.ruleset import expr_from_json

NAMES = ["a", "b", "1"]
DEPTH = 3
EXPECTED_COUNT = 1 + 3 + 9 + 27  # root plus depths 1..3

EXPRESSIONS = [
    # ** in every position, including zero-segment matches
    "**",
    "a/**",
    "**/a",
    "a/**/b",
    "a/**/**/b",
    "a/**/1",
    # single-segment star and question mark
    "*",
    "*/a",
    "a/*",
    "?",
    "a/?",
    # character classes and complement classes
    "[^a]",
    "a/[ab1]",
    "a/[^b]",
    "[^a]/**",
    "[ab]/[!1]",
    # literals and the empty root pattern
    "",
    "a",
    "a/b/1",
    # unions
    {"union": ["a/b", "a/1"]},
    {"union": ["a/**", "b/*", "1"]},
    # differences (complement relative to legal paths)
    {"minus": ["**", "a/**"]},
    {"minus": [{"union": ["a/**", "b/**"]}, "a/1"]},
    {"minus": ["**", ""]},
    # whitelist + exclude policies
    {"allow": ["**"], "deny": ["a/**", "b/1"]},
    {"allow": ["a/**", "b/**"], "deny": ["**/1"]},
    {"deny": ["a/b/**"]},
]


class EnumerationCrossCheckTests(unittest.TestCase):
    def test_legal_path_enumeration_shape(self):
        paths = list(legal_paths(NAMES, DEPTH))
        self.assertEqual(len(paths), EXPECTED_COUNT)
        self.assertIn("", paths)  # empty root path
        self.assertIn("a/b/1", paths)
        for path in paths:
            self.assertNotIn("//", path)
            self.assertFalse(path.startswith("/"))
            self.assertFalse(path.endswith("/"))

    def test_automaton_matches_interpreter_everywhere(self):
        for expr_json in EXPRESSIONS:
            expr = expr_from_json(expr_json)
            with self.subTest(expr=expr_json):
                result = cross_check(expr, NAMES, DEPTH)
                self.assertEqual(result["checked"], EXPECTED_COUNT)
                self.assertEqual(result["mismatches"], [])

    def test_specific_memberships(self):
        # Spot-check a few verdicts that exercise tricky boundaries.
        expr = expr_from_json("a/**/b")
        result = cross_check(expr, NAMES, DEPTH)
        self.assertEqual(result["mismatches"], [])
        from pathpolicy.interpreter import interp_match

        yes = {"a/b", "a/a/b", "a/1/b", "a/b/b", "a/a/1/b"}
        for path in legal_paths(NAMES, DEPTH):
            self.assertEqual(interp_match(expr, path), path in yes, msg=path)


if __name__ == "__main__":
    unittest.main()
