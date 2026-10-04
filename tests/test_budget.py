import unittest

from pathpolicy.dfa import Budget, determinize
from pathpolicy.nfa import compile_pattern_nfa
from pathpolicy.proof import check_inclusion, find_difference
from pathpolicy.ruleset import Pattern, alphabet_of, run_dfa


class BudgetTests(unittest.TestCase):
    def test_determinize_budget_exhaustion_and_resume(self):
        nfa = compile_pattern_nfa("a/b/c/d/e")
        alphabet = alphabet_of(Pattern("a/b/c/d/e"))
        first = determinize(nfa, alphabet, Budget(2))
        self.assertFalse(first.done)
        self.assertTrue(first.frontier)
        resumed = determinize(nfa, alphabet, Budget(1000), resume=first)
        self.assertTrue(resumed.done)
        self.assertEqual(resumed.frontier, [])
        dfa = resumed.dfa.make_complete()
        self.assertTrue(run_dfa(dfa, "a/b/c/d/e"))
        self.assertFalse(run_dfa(dfa, "a/b/c/d"))
        self.assertFalse(run_dfa(dfa, "a/b/c/d/e/f"))

    def test_check_inclusion_unknown_with_frontier(self):
        result = check_inclusion(Pattern("a/b/c"), Pattern("a/**"), budget=1)
        self.assertEqual(result["status"], "unknown")
        self.assertIn("reason", result)
        self.assertTrue(result["frontier"])

    def test_find_difference_unknown_with_frontier(self):
        result = find_difference(Pattern("a/b/c"), Pattern("x"), budget=1)
        self.assertEqual(result["status"], "unknown")
        self.assertTrue(result["frontier"])

    def test_result_recovers_with_larger_budget(self):
        small = check_inclusion(Pattern("a/b/c"), Pattern("a/**"), budget=1)
        self.assertEqual(small["status"], "unknown")
        large = check_inclusion(Pattern("a/b/c"), Pattern("a/**"), budget=10000)
        self.assertEqual(large["status"], "included")


if __name__ == "__main__":
    unittest.main()
