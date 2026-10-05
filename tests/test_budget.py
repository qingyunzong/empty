import unittest

from symregex import (
    Context, parse, shortest_difference, resume_difference,
    EQUIVALENT, DIFFERENT, UNKNOWN,
)


class TestBudgetResume(unittest.TestCase):
    """预算耗尽 -> unknown + 前沿；恢复必须绑定原表达式与字母表。"""

    def setUp(self):
        self.ctx = Context("ab")
        # 足够大的状态空间，便于预算截断
        self.left = parse(self.ctx, "(a|b)*a(a|b)(a|b)(a|b)")
        self.right = parse(self.ctx, "((a|b)(a|b)*)*a(a|b)(a|b)(a|b)")

    def test_budget_exhaustion_returns_unknown_with_frontier(self):
        res = shortest_difference(self.ctx, self.left, self.right, budget=1)
        self.assertEqual(res.status, UNKNOWN)
        self.assertIsNotNone(res.state)
        self.assertEqual(res.state["kind"], "frontier")
        self.assertTrue(res.state["queue"])  # 未探索状态被保留而非拒绝

    def test_zero_budget(self):
        res = shortest_difference(self.ctx, self.left, self.right, budget=0)
        self.assertEqual(res.status, UNKNOWN)
        self.assertEqual(res.state["queue"][0][2], "")  # 空前缀起点

    def test_one_step_resume_equivalent(self):
        """一步预算反复恢复，最终结果与无预算运行一致（等价）。"""
        full = shortest_difference(self.ctx, self.left, self.right)
        self.assertEqual(full.status, EQUIVALENT)
        res = shortest_difference(self.ctx, self.left, self.right, budget=1)
        steps = 0
        while res.status == UNKNOWN:
            res = resume_difference(res.state, budget=1)
            steps += 1
            self.assertLess(steps, 10000)
        self.assertEqual(res.status, EQUIVALENT)
        self.assertGreater(steps, 1)  # 确实经历了多步恢复

    def test_one_step_resume_different(self):
        """有反例的情形：逐步恢复后反例与直接运行一致。"""
        ctx = Context("abc")
        left = parse(ctx, "(a|b)*c")
        right = parse(ctx, "(a|b)*")
        full = shortest_difference(ctx, left, right)
        self.assertEqual(full.status, DIFFERENT)
        res = shortest_difference(ctx, left, right, budget=2)
        while res.status == UNKNOWN:
            res = resume_difference(res.state, budget=2)
        self.assertEqual(res.status, DIFFERENT)
        self.assertEqual(res.counterexample, full.counterexample)
        self.assertEqual(res.side, full.side)

    def test_resume_binds_expressions_and_alphabet(self):
        """篡改前沿中的表达式/字母表/指纹必须被拒绝。"""
        res = shortest_difference(self.ctx, self.left, self.right, budget=1)
        state = res.state
        # 正常恢复可用
        self.assertIsNotNone(resume_difference(state, budget=1))
        # 篡改左表达式
        bad = dict(state, left="a*")
        with self.assertRaises(ValueError):
            resume_difference(bad)
        # 篡改字母表
        bad = dict(state, alphabet="abc")
        with self.assertRaises(ValueError):
            resume_difference(bad)
        # 篡改指纹
        bad = dict(state, fingerprint="0" * 64)
        with self.assertRaises(ValueError):
            resume_difference(bad)
        # 篡改队列（迁移过的状态）
        bad = dict(state, queue=[["a", "a", ""]])
        with self.assertRaises(ValueError):
            resume_difference(bad)
        # 非前沿对象
        with self.assertRaises(ValueError):
            resume_difference({"kind": "something"})

    def test_frontier_state_is_json_serializable(self):
        import json
        res = shortest_difference(self.ctx, self.left, self.right, budget=1)
        blob = json.dumps(res.state)
        restored = json.loads(blob)
        out = resume_difference(restored, budget=100000)
        self.assertEqual(out.status, EQUIVALENT)


if __name__ == "__main__":
    unittest.main()
