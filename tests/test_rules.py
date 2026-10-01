import unittest

from regex_deriv.alphabet import Alphabet
from regex_deriv.rules import RuleSet

AB = Alphabet.from_string("ab")


class TestRuleSet(unittest.TestCase):
    def make(self):
        rs = RuleSet(AB)
        rs.set("word", "a(ba)*")
        rs.set("word2", "(ab)*a")
        rs.set("other", "b+")
        return rs

    def test_basic_queries(self):
        rs = self.make()
        self.assertEqual(rs.equivalent("word", "word2")["status"],
                         "equivalent")
        self.assertEqual(rs.included("other", "word")["status"],
                         "not_included")
        self.assertTrue(rs.match("word", "aba"))
        self.assertFalse(rs.match("word", "ab"))

    def test_cache_hit(self):
        rs = self.make()
        rs.equivalent("word", "word2")
        misses = rs.misses
        rs.equivalent("word", "word2")
        self.assertEqual(rs.misses, misses)
        self.assertGreater(rs.hits, 0)

    def test_dependent_entries_invalidated_on_change(self):
        rs = self.make()
        r1 = rs.equivalent("word", "word2")
        self.assertEqual(r1["status"], "equivalent")
        a1 = rs.automaton("word")
        rs.set("word", "a(ba)*b")  # redefine: no longer equivalent
        self.assertGreaterEqual(rs.invalidated, 2)  # both entries dropped
        misses = rs.misses
        r2 = rs.equivalent("word", "word2")
        self.assertEqual(r2["status"], "not_equivalent")
        self.assertEqual(rs.misses, misses + 1)  # recomputed, not stale

    def test_unrelated_entries_survive(self):
        rs = self.make()
        rs.automaton("other")
        rs.equivalent("word", "word2")
        hits = rs.hits
        rs.set("word", "a*")  # touches only 'word' entries
        rs.automaton("other")  # must still be cached
        self.assertEqual(rs.hits, hits + 1)

    def test_no_stale_results_after_change(self):
        rs = self.make()
        self.assertEqual(rs.equivalent("word", "word2")["status"],
                         "equivalent")
        rs.set("word2", "b(ab)*")  # now different languages
        self.assertEqual(rs.equivalent("word", "word2")["status"],
                         "not_equivalent")
        rs.set("word2", "(ab)*a")  # change back
        self.assertEqual(rs.equivalent("word", "word2")["status"],
                         "equivalent")

    def test_version_bumps(self):
        rs = self.make()
        v = rs.version("word")
        rs.set("word", "a*")
        self.assertEqual(rs.version("word"), v + 1)


if __name__ == "__main__":
    unittest.main()
