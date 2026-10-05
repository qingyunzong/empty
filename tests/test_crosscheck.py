"""用独立的 Thompson 构造 / 集合运算自动机核对导数引擎的接受语言与等价性。"""
import itertools
import random
import unittest

from symregex import Context, parse, shortest_difference, EQUIVALENT
from symregex import thompson


def all_strings(alphabet, max_len):
    for n in range(max_len + 1):
        for tup in itertools.product(alphabet, repeat=n):
            yield "".join(tup)


def gen_expr(rng, alphabet, depth):
    if depth == 0:
        return rng.choice([rng.choice(alphabet), "@", "#", "."])
    op = rng.choice(["lit", "cat", "or", "and", "not", "star", "cat", "or"])
    if op == "lit":
        return rng.choice([rng.choice(alphabet), "@", "#", "."])
    if op == "cat":
        return "(" + gen_expr(rng, alphabet, depth - 1) + \
            gen_expr(rng, alphabet, depth - 1) + ")"
    if op == "or":
        return "(" + gen_expr(rng, alphabet, depth - 1) + "|" + \
            gen_expr(rng, alphabet, depth - 1) + ")"
    if op == "and":
        return "(" + gen_expr(rng, alphabet, depth - 1) + "&" + \
            gen_expr(rng, alphabet, depth - 1) + ")"
    if op == "not":
        return "(~" + gen_expr(rng, alphabet, depth - 1) + ")"
    return "(" + gen_expr(rng, alphabet, depth - 1) + ")*"


class TestThompsonCrossCheck(unittest.TestCase):
    def setUp(self):
        self.ctx = Context("ab")

    def check_language(self, pat, max_len=4):
        node = parse(self.ctx, pat)
        for s in all_strings("ab", max_len):
            got = self.ctx.match(node, s)
            want = thompson.match(self.ctx, node, s)
            self.assertEqual(got, want, f"{pat!r} vs {s!r}")

    def test_directed_patterns(self):
        # 覆盖：补与空串、交集空语言、深层嵌套星、区间端点
        pats = [
            "a", "ab", "a|b", "a*", "(a|b)*", "@", "#", "~a", "~@", "~#",
            "a*&b*", "aa*&bb*", "a*&~b", "(((a*)*)*)*", "((a|@)*)*",
            "[a-b]", "[^a]", ".", "(a&b)", "~(a|b)", "(a|b)*abb",
            "~(~(a*))", "(ab|ba)*", "a(b|@)", "(a|b)(a|b)(a|b)",
        ]
        for pat in pats:
            self.check_language(pat)

    def test_random_patterns(self):
        rng = random.Random(20261006)
        for _ in range(150):
            pat = gen_expr(rng, "ab", 3)
            self.check_language(pat, max_len=4)

    def test_equivalence_crosscheck(self):
        rng = random.Random(1234567)
        pairs = [
            ("(a|b)*", "~#"), ("a*", "(a|@)*"), ("~(a|b)", "~a&~b"),
            ("a(b|a)", "(a(b|a))"), ("a*&b*", "@"), ("(a|b)*a", "~(~(a|b)*a)"),
        ]
        pairs += [(gen_expr(rng, "ab", 3), gen_expr(rng, "ab", 3))
                  for _ in range(60)]
        for l, r in pairs:
            nl, nr = parse(self.ctx, l), parse(self.ctx, r)
            res = shortest_difference(self.ctx, nl, nr)
            want = thompson.equivalent(self.ctx, nl, nr)
            self.assertEqual(res.status == EQUIVALENT, want, (l, r))
            if res.status != EQUIVALENT:
                # 反例确实区分两侧（用 Thompson 独立验证）
                ce = res.counterexample
                ml = thompson.match(self.ctx, nl, ce)
                mr = thompson.match(self.ctx, nr, ce)
                self.assertNotEqual(ml, mr, (l, r, ce))
                self.assertEqual(ml, res.side == "left")

    def test_shortest_counterexample_is_minimal(self):
        # 与暴力枚举对照：反例必须是（长度，字典序）最小
        rng = random.Random(99)
        for _ in range(40):
            l = gen_expr(rng, "ab", 3)
            r = gen_expr(rng, "ab", 3)
            nl, nr = parse(self.ctx, l), parse(self.ctx, r)
            res = shortest_difference(self.ctx, nl, nr)
            brute = None
            for s in sorted(all_strings("ab", 5), key=lambda x: (len(x), x)):
                if thompson.match(self.ctx, nl, s) != \
                        thompson.match(self.ctx, nr, s):
                    brute = s
                    break
            if brute is None:
                self.assertEqual(res.status, EQUIVALENT, (l, r))
            else:
                self.assertEqual(res.counterexample, brute, (l, r))


if __name__ == "__main__":
    unittest.main()
