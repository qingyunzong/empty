import unittest

from symregex import (
    Context, parse, shortest_difference, equivalent, included,
    EQUIVALENT, DIFFERENT,
)


class TestEquivalent(unittest.TestCase):
    def setUp(self):
        self.ctx = Context("abc")

    def eq(self, l, r):
        return equivalent(self.ctx, parse(self.ctx, l), parse(self.ctx, r))

    def test_equivalent_pairs(self):
        cases = [
            ("a", "a"),
            ("a|b", "b|a"),
            ("(a|b|c)*", "~#"),              # Σ* 的两种写法
            ("a*", "(a|@)*"),
            ("a*", "((a*)*)*"),              # 深层嵌套星
            ("~(a|b)", "~a&~b"),             # De Morgan
            ("~~a", "a"),
            ("a(b|c)", "ab|ac"),
            ("(a|b)*abb", "((a|b)(a|b)*)*abb"),
            ("#*a", "a"),                    # ∅* = ε
            ("a&~#", "a"),                   # R & Σ* = R
        ]
        for l, r in cases:
            res = self.eq(l, r)
            self.assertEqual(res.status, EQUIVALENT, (l, r))
            self.assertIsNotNone(res.proof)

    def test_not_equivalent(self):
        cases = [
            ("a", "b", "a"),
            ("a*", "b*", "a"),
            ("(a|b)*", "a*", "b"),
            ("~a", "a", ""),
            ("a&b", "#", "a"),               # 交集为空 vs 空集：等价？不——a&b 即 ∅
        ]
        for l, r, _ in cases[:4]:
            res = self.eq(l, r)
            self.assertEqual(res.status, DIFFERENT, (l, r))

    def test_empty_intersection_language(self):
        # a(a)* 与 b(b)* 的交集为空语言
        res = self.eq("aa*&bb*", "#")
        self.assertEqual(res.status, EQUIVALENT)
        # a* 与 b* 的交集 = {ε}
        res = self.eq("a*&b*", "@")
        self.assertEqual(res.status, EQUIVALENT)
        # 交集为空 => 与任何非空式不等价
        res = self.eq("aa*&bb*", "a")
        self.assertEqual(res.status, DIFFERENT)
        self.assertEqual(res.counterexample, "a")

    def test_complement_and_epsilon(self):
        res = self.eq("~@", ".(~#)")         # 非空串 = 任意字符后接任意串
        self.assertEqual(res.status, EQUIVALENT)
        # 非 "a" 的串 = ε | b | c | 长度 ≥ 2 的串
        res = self.eq("~a", "@|b|c|..(~#)")
        self.assertEqual(res.status, EQUIVALENT)
        res = self.eq("~a&~b", "~(a|b)")     # De Morgan（补）
        self.assertEqual(res.status, EQUIVALENT)
        # ~a 不含 "a" 本身
        res = self.eq("~a", "~#")
        self.assertEqual(res.status, DIFFERENT)
        self.assertEqual(res.counterexample, "a")
        self.assertEqual(res.side, "right")


class TestShortestDifference(unittest.TestCase):
    def setUp(self):
        self.ctx = Context("abcd")

    def diff(self, l, r, budget=None):
        return shortest_difference(self.ctx, parse(self.ctx, l),
                                   parse(self.ctx, r), budget)

    def test_shortest_by_length(self):
        res = self.diff("a|bb", "a")
        self.assertEqual(res.status, DIFFERENT)
        self.assertEqual(res.counterexample, "bb")
        self.assertEqual(res.side, "left")
        res = self.diff("a", "a|bb")
        self.assertEqual(res.counterexample, "bb")
        self.assertEqual(res.side, "right")

    def test_empty_string_counterexample(self):
        res = self.diff("a*", "aa*")   # "" 只在左侧
        self.assertEqual(res.counterexample, "")
        self.assertEqual(res.side, "left")

    def test_lexicographic_tie_break(self):
        # 多个等长反例时取字典序最小
        res = self.diff("da|db", "#")
        self.assertEqual(res.counterexample, "da")
        res = self.diff("b|c", "b")
        self.assertEqual(res.counterexample, "c")
        res = self.diff("(a|b)(a|b)", "aa|ab|ba")
        self.assertEqual(res.counterexample, "bb")
        # 两侧同长度候选：左有 "ba"，右有 "c"，长度 2 vs 1 → 取 "c"
        res = self.diff("a|ba", "a|c")
        self.assertEqual(res.counterexample, "c")

    def test_included(self):
        ctx = self.ctx
        res = included(ctx, parse(ctx, "a*"), parse(ctx, "(a|b)*"))
        self.assertEqual(res.status, EQUIVALENT)   # 包含成立
        res = included(ctx, parse(ctx, "(a|b)*"), parse(ctx, "a*"))
        self.assertEqual(res.status, DIFFERENT)    # 不包含
        self.assertEqual(res.counterexample, "b")
        res = included(ctx, parse(ctx, "a*"), parse(ctx, "a*"))
        self.assertEqual(res.status, EQUIVALENT)
        # 差集为空语言时包含成立
        res = included(ctx, parse(ctx, "aa*&bb*"), parse(ctx, "c"))
        self.assertEqual(res.status, EQUIVALENT)


if __name__ == "__main__":
    unittest.main()
