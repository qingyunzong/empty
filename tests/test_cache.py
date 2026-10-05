import unittest

from symregex import RuleEngine, EQUIVALENT, DIFFERENT


class TestRuleCache(unittest.TestCase):
    """规则子表达式更改后按依赖使缓存失效，防止旧结果污染。"""

    def test_cache_hit_and_invalidation_on_update(self):
        eng = RuleEngine("ab")
        eng.set_rule("A", "a*")
        eng.set_rule("B", "(a|@)*")
        r1 = eng.equivalent("A", "B")
        self.assertEqual(r1.status, EQUIVALENT)
        self.assertEqual(eng.cache_size, 1)
        # 再次查询命中缓存（对象同一）
        r2 = eng.equivalent("A", "B")
        self.assertIs(r1, r2)
        # 更改规则 A：旧缓存必须失效，结果必须反映新表达式
        eng.set_rule("A", "ab")
        r3 = eng.equivalent("A", "B")
        self.assertEqual(r3.status, DIFFERENT)
        self.assertIsNot(r1, r3)

    def test_no_stale_pollution(self):
        eng = RuleEngine("ab")
        eng.set_rule("A", "a")
        eng.set_rule("B", "a")
        self.assertEqual(eng.equivalent("A", "B").status, EQUIVALENT)
        eng.set_rule("A", "b")
        # 若缓存被旧表达式污染，这里会错误地返回 equivalent
        res = eng.equivalent("A", "B")
        self.assertEqual(res.status, DIFFERENT)
        self.assertEqual(res.counterexample, "a")

    def test_dependency_invalidation_reaches_shared_subexpressions(self):
        eng = RuleEngine("ab")
        eng.set_rule("A", "a*")
        eng.set_rule("C", "a*|b")   # 与 A 共享子表达式 a*
        eng.set_rule("D", "(a|@)*|b")
        r1 = eng.equivalent("C", "D")
        self.assertEqual(r1.status, EQUIVALENT)
        size_before = eng.cache_size
        # 修改 A（其旧表达式 a* 是 C/D 缓存条目的依赖子节点）
        eng.set_rule("A", "bb")
        # 依赖 a* 的缓存条目被按依赖失效
        self.assertLess(eng.cache_size, size_before)
        # 重新计算结果仍正确
        r2 = eng.equivalent("C", "D")
        self.assertEqual(r2.status, EQUIVALENT)
        self.assertIsNot(r1, r2)

    def test_unrelated_rules_keep_cache(self):
        eng = RuleEngine("abc")
        eng.set_rule("A", "a")
        eng.set_rule("B", "b")
        eng.set_rule("C", "c")
        eng.equivalent("A", "B")
        eng.equivalent("B", "C")
        self.assertEqual(eng.cache_size, 2)
        eng.set_rule("A", "aa")   # 只影响依赖旧 A 的条目
        self.assertEqual(eng.cache_size, 1)

    def test_set_same_expression_keeps_cache(self):
        eng = RuleEngine("ab")
        eng.set_rule("A", "a*")
        eng.set_rule("B", "(a|@)*")
        eng.equivalent("A", "B")
        eng.set_rule("A", "a*")   # 同一表达式，不失效
        self.assertEqual(eng.cache_size, 1)

    def test_included_cached_separately(self):
        eng = RuleEngine("ab")
        eng.set_rule("A", "a*")
        eng.set_rule("B", "(a|b)*")
        self.assertEqual(eng.included("A", "B").status, EQUIVALENT)
        self.assertEqual(eng.included("B", "A").status, DIFFERENT)
        eng.set_rule("B", "a*")
        self.assertEqual(eng.included("B", "A").status, EQUIVALENT)


if __name__ == "__main__":
    unittest.main()
