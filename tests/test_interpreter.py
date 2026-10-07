import unittest

from pathpolicy import match_pattern, match_policy, Policy, PathEscapeError


class InterpreterTest(unittest.TestCase):
    def test_literals(self):
        self.assertTrue(match_pattern("a/b", "/a/b"))
        self.assertFalse(match_pattern("a/b", "/a/c"))
        self.assertFalse(match_pattern("a/b", "/a/b/c"))
        self.assertFalse(match_pattern("a/b", "/a"))

    def test_star_stays_in_segment(self):
        self.assertTrue(match_pattern("a*", "/abc"))
        self.assertTrue(match_pattern("a*", "/a"))
        self.assertFalse(match_pattern("a*", "/a/b"))
        self.assertFalse(match_pattern("a*", "/ba"))
        self.assertTrue(match_pattern("*", "/anything"))
        self.assertFalse(match_pattern("*", "/"))

    def test_question(self):
        self.assertTrue(match_pattern("a?c", "/abc"))
        self.assertFalse(match_pattern("a?c", "/ac"))
        self.assertFalse(match_pattern("a?c", "/a/c"))
        self.assertFalse(match_pattern("a?c", "/abbc"))

    def test_doublestar_zero_segments(self):
        self.assertTrue(match_pattern("a/**/b", "/a/b"))
        self.assertTrue(match_pattern("a/**/b", "/a/x/b"))
        self.assertTrue(match_pattern("a/**/b", "/a/x/y/z/b"))
        self.assertFalse(match_pattern("a/**/b", "/a/x/y"))
        self.assertTrue(match_pattern("a/**", "/a"))
        self.assertTrue(match_pattern("a/**", "/a/x/y"))
        self.assertTrue(match_pattern("**", "/"))
        self.assertTrue(match_pattern("**", "/a/b/c"))
        self.assertTrue(match_pattern("**/b", "/b"))
        self.assertTrue(match_pattern("**/b", "/x/y/b"))

    def test_doublestar_segment_boundaries(self):
        self.assertFalse(match_pattern("**/b", "/axb"))
        self.assertFalse(match_pattern("**/b", "/ab"))
        with self.assertRaises(Exception):
            match_pattern("a**b", "/axxb")

    def test_char_class(self):
        self.assertTrue(match_pattern("[ab]", "/a"))
        self.assertTrue(match_pattern("[ab]", "/b"))
        self.assertFalse(match_pattern("[ab]", "/c"))
        self.assertFalse(match_pattern("[ab]", "/ab"))
        self.assertTrue(match_pattern("[a-c]", "/b"))

    def test_char_class_complement(self):
        self.assertTrue(match_pattern("[^a]", "/b"))
        self.assertFalse(match_pattern("[^a]", "/a"))
        self.assertFalse(match_pattern("[^a]", "/"))
        self.assertTrue(match_pattern("[!a]", "/b"))
        self.assertFalse(match_pattern("[!a]", "/a"))

    def test_empty_root(self):
        self.assertTrue(match_pattern("", "/"))
        self.assertTrue(match_pattern("", ""))
        self.assertFalse(match_pattern("", "/a"))
        self.assertFalse(match_pattern("a", "/"))

    def test_consecutive_separators_normalize(self):
        self.assertTrue(match_pattern("a//b", "a/b"))
        self.assertTrue(match_pattern("a/b", "a//b"))
        self.assertTrue(match_pattern("a/./b", "a/b/"))

    def test_escape_rejected_on_match(self):
        with self.assertRaises(PathEscapeError):
            match_pattern("**", "a/../..")

    def test_policy_whitelist_minus_blacklist(self):
        pol = Policy.from_json({"allow": ["**"], "deny": ["secret", "secret/**"]})
        self.assertTrue(match_policy(pol, "/a"))
        self.assertTrue(match_policy(pol, "/secretx"))
        self.assertFalse(match_policy(pol, "/secret"))
        self.assertFalse(match_policy(pol, "/secret/x"))
        self.assertFalse(match_policy(Policy.from_json({"allow": [], "deny": []}), "/a"))


if __name__ == "__main__":
    unittest.main()
