import unittest

from symregex import Context, parse
from symregex.automaton import build_dfa, minimize


class TestMatch(unittest.TestCase):
    def setUp(self):
        self.ctx = Context("abcd")

    def m(self, pat, s):
        return self.ctx.match(parse(self.ctx, pat), s)

    def test_literals_and_concat(self):
        self.assertTrue(self.m("ab", "ab"))
        self.assertFalse(self.m("ab", "a"))
        self.assertFalse(self.m("ab", "abc"))

    def test_empty_set_and_epsilon(self):
        self.assertFalse(self.m("#", ""))
        self.assertFalse(self.m("#", "a"))
        self.assertTrue(self.m("@", ""))
        self.assertFalse(self.m("@", "a"))
        self.assertTrue(self.m("a|@", ""))
        self.assertTrue(self.m("a|@", "a"))

    def test_complement_relative_to_alphabet(self):
        # ~a：除 "a" 之外的所有串（含空串）
        self.assertFalse(self.m("~a", "a"))
        self.assertTrue(self.m("~a", ""))
        self.assertTrue(self.m("~a", "b"))
        self.assertTrue(self.m("~a", "aa"))
        # ~@：所有非空串
        self.assertFalse(self.m("~@", ""))
        self.assertTrue(self.m("~@", "a"))
        self.assertTrue(self.m("~@", "abcd"))
        # ~#：全语言 Σ*
        self.assertTrue(self.m("~#", ""))
        self.assertTrue(self.m("~#", "dcba"))
        # 补的补
        self.assertTrue(self.m("~(~a)", "a"))
        self.assertFalse(self.m("~(~a)", "b"))

    def test_intersection(self):
        self.assertTrue(self.m("a*&~b", ""))
        self.assertTrue(self.m("a*&~b", "aaa"))
        self.assertFalse(self.m("a*&~b", "b"))
        self.assertFalse(self.m("a*&~b", "ab"))
        # (aa)* & (aaa)* = 长度 6 倍数
        self.assertTrue(self.m("(aa)*&(aaa)*", "aaaaaa"))
        self.assertFalse(self.m("(aa)*&(aaa)*", "aaaa"))

    def test_deep_nested_stars(self):
        for pat in ["(((a*)*)*)*", "(a*|@)*", "((a|@)*)*"]:
            self.assertTrue(self.m(pat, ""))
            self.assertTrue(self.m(pat, "aaaa"))
            self.assertFalse(self.m(pat, "b"))

    def test_interval_endpoints(self):
        self.assertTrue(self.m("[a-c]", "a"))
        self.assertTrue(self.m("[a-c]", "b"))
        self.assertTrue(self.m("[a-c]", "c"))
        self.assertFalse(self.m("[a-c]", "d"))
        self.assertFalse(self.m("[a-c]", ""))
        self.assertTrue(self.m("[^a-c]", "d"))
        self.assertFalse(self.m("[^a-c]", "a"))

    def test_string_outside_alphabet_rejected(self):
        with self.assertRaises(ValueError):
            self.m("a*", "z")


class TestAutomaton(unittest.TestCase):
    def setUp(self):
        self.ctx = Context("abcd")

    def test_interval_partition(self):
        ctx = self.ctx
        dfa, frontier, truncated = build_dfa(ctx, parse(ctx, "[a-c]"))
        self.assertFalse(truncated)
        self.assertEqual(frontier, [])
        iv = dfa.intervals(dfa.start)
        # 起始状态：a-c -> 接受态(ε)，d -> 死态(∅)
        self.assertEqual(iv, [("a", "c", 1), ("d", "d", 2)])
        self.assertTrue(dfa.accepting[1])
        self.assertFalse(dfa.accepting[2])
        # 全字符 '.' 只有一段区间
        dfa2, _, _ = build_dfa(ctx, parse(ctx, "."))
        self.assertEqual(dfa2.intervals(dfa2.start), [("a", "d", 1)])

    def test_minimize(self):
        ctx = Context("ab")
        dfa, _, _ = build_dfa(ctx, parse(ctx, "(a|b)*abb"))
        mini = minimize(dfa)
        self.assertEqual(len(mini.states), 4)  # 经典最小 DFA
        for s, want in [("abb", True), ("aabb", True), ("ab", False),
                        ("", False), ("babb", True), ("abba", False)]:
            self.assertEqual(mini.match(s), want, s)
        # (a|b)*a 最小为 2 状态
        dfa2, _, _ = build_dfa(ctx, parse(ctx, "(a|b)*a"))
        self.assertEqual(len(minimize(dfa2).states), 2)

    def test_dfa_budget_truncation(self):
        ctx = Context("ab")
        dfa, frontier, truncated = build_dfa(ctx, parse(ctx, "(a|b)*abb"), budget=1)
        self.assertTrue(truncated)
        self.assertTrue(frontier)  # 未探索状态保留在前沿中


if __name__ == "__main__":
    unittest.main()
