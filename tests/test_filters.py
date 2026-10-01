import unittest

from knnindex.filters import evaluate, evaluate_summary

TAGS = ("a", "b")


def all_filter_expressions():
    """All 16 boolean functions over tags {a, b} as filter expressions."""
    t = lambda x: {"tag": x}
    n = lambda e: {"not": e}
    a = lambda *es: {"and": list(es)}
    o = lambda *es: {"or": list(es)}
    return [
        {"all": True},
        {"none": True},
        t("a"),
        n(t("a")),
        t("b"),
        n(t("b")),
        a(t("a"), t("b")),
        a(t("a"), n(t("b"))),
        a(n(t("a")), t("b")),
        a(n(t("a")), n(t("b"))),
        o(t("a"), t("b")),
        o(t("a"), n(t("b"))),
        o(n(t("a")), t("b")),
        o(n(t("a")), n(t("b"))),
        o(a(t("a"), t("b")), a(n(t("a")), n(t("b")))),   # xnor
        o(a(t("a"), n(t("b"))), a(n(t("a")), t("b"))),   # xor
    ]


class TestFilters(unittest.TestCase):
    def test_all_16_boolean_functions(self):
        worlds = [frozenset(), frozenset({"a"}), frozenset({"b"}), frozenset({"a", "b"})]
        exprs = all_filter_expressions()
        truth_tables = {tuple(evaluate(e, w) for w in worlds) for e in exprs}
        self.assertEqual(len(exprs), 16)
        self.assertEqual(len(truth_tables), 16)  # genuinely 16 distinct functions

    def test_summary_single_point_is_decisive(self):
        labels = frozenset({"a"})
        present, absent = labels, frozenset({"b"})  # universe {a, b}
        for expr in all_filter_expressions():
            summary = evaluate_summary(expr, present, absent)
            self.assertEqual(summary, evaluate(expr, labels))

    def test_summary_prune_is_safe(self):
        # whenever the summary says False, every possible member must fail
        exprs = all_filter_expressions()
        worlds = [frozenset(), frozenset({"a"}), frozenset({"b"}), frozenset({"a", "b"})]
        for expr in exprs:
            for w1 in worlds:
                for w2 in worlds:
                    present = w1 | w2
                    absent = (frozenset(TAGS) - w1) | (frozenset(TAGS) - w2)
                    verdict = evaluate_summary(expr, present, absent)
                    if verdict is False:
                        self.assertFalse(evaluate(expr, w1))
                        self.assertFalse(evaluate(expr, w2))
                    if verdict is True:
                        self.assertTrue(evaluate(expr, w1))
                        self.assertTrue(evaluate(expr, w2))

    def test_invalid_expression_raises(self):
        with self.assertRaises(ValueError):
            evaluate({"bogus": 1}, frozenset())
        with self.assertRaises(ValueError):
            evaluate_summary({"bogus": 1}, frozenset(), frozenset())


if __name__ == "__main__":
    unittest.main()
