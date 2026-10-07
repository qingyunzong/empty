"""Cross-check the automaton pipeline against the independent recursive
interpreter by enumerating all legal paths over a small directory-name set.

Finite enumeration is used only to validate the two matchers against each
other; inclusion/equivalence results themselves come from exact automata
emptiness proofs (see test_policy.py), never from sampling.
"""
import unittest

from pathpolicy import (Policy, match_pattern, match_policy, enumerate_paths)
from pathpolicy.compiler import compile_pattern
from pathpolicy.pattern import parse_pattern

NAMES = ["a", "b", "ab", "x1"]
MAX_DEPTH = 3

PATTERNS = [
    "", "**", "*", "?", "a", "ab", "a/**", "**/b", "a/**/b", "a/*/b",
    "**/a/**", "a?b", "a*", "*b", "[ab]", "[^a]", "[a-c]", "[^a-b]x",
    "a//b", "a/./b", "*/b", "a/**/b/**", "[!x]/?", "x1",
]

POLICIES = [
    {"allow": ["**"], "deny": ["a", "a/**"]},
    {"allow": ["a/**", "b/**"], "deny": ["**/x1"]},
    {"allow": ["[ab]/**"], "deny": []},
    {"allow": [], "deny": []},
    {"allow": ["**/ab"], "deny": ["a/**"]},
    {"allow": ["*"], "deny": ["[^a]"]},
]


class CrossCheckTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.paths = list(enumerate_paths(NAMES, MAX_DEPTH))
        cls.compiled = [(p, compile_pattern(parse_pattern(p))) for p in PATTERNS]

    def test_enumeration_is_canonical(self):
        self.assertIn("/", self.paths)
        for p in self.paths:
            self.assertNotIn("//", p)
            self.assertFalse(p.endswith("/") and p != "/")

    def test_pattern_matcher_agrees_with_interpreter(self):
        for text, nfa in self.compiled:
            for path in self.paths:
                expected = match_pattern(text, path)
                got = nfa.accepts_string(path)
                self.assertEqual(expected, got,
                                 "pattern %r on %r: interpreter=%s automaton=%s"
                                 % (text, path, expected, got))

    def test_policy_matcher_agrees_with_interpreter(self):
        for spec in POLICIES:
            policy = Policy.from_json(spec)
            allow_nfas = [compile_pattern(parse_pattern(p)) for p in policy.allow]
            deny_nfas = [compile_pattern(parse_pattern(p)) for p in policy.deny]
            for path in self.paths:
                expected = match_policy(policy, path)
                got = (any(n.accepts_string(path) for n in allow_nfas)
                       and not any(n.accepts_string(path) for n in deny_nfas))
                self.assertEqual(expected, got,
                                 "policy %r on %r" % (spec, path))

    def test_doublestar_zero_segment_case_present(self):
        self.assertTrue(any(match_pattern("a/**/b", p) for p in self.paths))
        self.assertIn("/a/b", self.paths)
        self.assertTrue(match_pattern("a/**/b", "/a/b"))


if __name__ == "__main__":
    unittest.main()
