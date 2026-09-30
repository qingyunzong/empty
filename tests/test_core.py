import unittest

from slot import BadSlotError, find_slots


class TestTies(unittest.TestCase):
    def test_two_equal_score_slots_both_returned(self):
        # 两个等长空闲槽, 无 prefer, 评分同为 0, 必须都返回且按 start 升序。
        busy = [[[10, 20], [30, 40]]]
        result = find_slots(busy, d=5, s=0, e=50)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["score"], 0)
        self.assertEqual(result["slots"], [(0, 10), (20, 30), (40, 50)])

    def test_tie_break_start_then_end(self):
        # 评分相同 (0) 时按 start 升序; 构造两个评分相同的槽验证顺序。
        busy = [[[5, 10], [15, 20]]]
        result = find_slots(busy, d=5, s=0, e=25)
        self.assertEqual(result["slots"], [(0, 5), (10, 15), (20, 25)])

    def test_higher_score_wins(self):
        busy = [[[10, 40]]]
        # 槽 [0,10) 与 prefer 全重叠 (score 10), 槽 [40,60) score 0。
        result = find_slots(busy, d=5, s=0, e=60, prefer=[[0, 10]])
        self.assertEqual(result["slots"], [(0, 10)])
        self.assertEqual(result["score"], 10)


class TestPreferOverlap(unittest.TestCase):
    def test_overlapping_prefer_counted_once(self):
        # prefer [0,10) 与 [5,15) 重叠, 并集时长 15, 不是 20。
        result = find_slots([], d=1, s=0, e=20, prefer=[[0, 10], [5, 15]])
        self.assertEqual(result["score"], 15)

    def test_nested_prefer_counted_once(self):
        result = find_slots([], d=1, s=0, e=20, prefer=[[0, 20], [3, 7]])
        self.assertEqual(result["score"], 20)


class TestBoundary(unittest.TestCase):
    def test_busy_touching_window_start_allows_immediate_start(self):
        # 忙时 [0,10) 贴到窗左端, 空闲可立刻从 s=10 开始 (半开)。
        result = find_slots([[[0, 10]]], d=5, s=10, e=30)
        self.assertEqual(result["slots"], [(10, 30)])

    def test_busy_touching_window_end(self):
        result = find_slots([[[20, 30]]], d=5, s=0, e=20)
        self.assertEqual(result["slots"], [(0, 20)])

    def test_busy_exactly_filling_gap_edges(self):
        # 忙时首尾相接 [0,10),[10,20) 合并, 空闲从 20 开始。
        result = find_slots([[[0, 10], [10, 20]]], d=5, s=0, e=30)
        self.assertEqual(result["slots"], [(20, 30)])


class TestNoFeasible(unittest.TestCase):
    def test_window_without_enough_length(self):
        # 窗内空闲碎片均 < d。
        busy = [[[0, 8], [12, 28], [32, 40]]]
        result = find_slots(busy, d=5, s=0, e=40)
        self.assertEqual(result["status"], "none")
        self.assertEqual(result["slots"], [])

    def test_fully_busy(self):
        result = find_slots([[[0, 100]]], d=1, s=0, e=100)
        self.assertEqual(result["status"], "none")


class TestBadInput(unittest.TestCase):
    def assert_bad(self, *args, **kwargs):
        with self.assertRaises(BadSlotError) as ctx:
            find_slots(*args, **kwargs)
        self.assertEqual(ctx.exception.code, "BAD_SLOT")

    def test_non_positive_duration(self):
        self.assert_bad([], d=0, s=0, e=10)
        self.assert_bad([], d=-3, s=0, e=10)

    def test_inverted_window(self):
        self.assert_bad([], d=1, s=10, e=10)
        self.assert_bad([], d=1, s=20, e=10)

    def test_inverted_busy_interval(self):
        self.assert_bad([[[5, 2]]], d=1, s=0, e=10)

    def test_inverted_prefer_interval(self):
        self.assert_bad([], d=1, s=0, e=10, prefer=[[9, 4]])

    def test_bad_input_distinct_from_none(self):
        # status=none 是合法结果, 不是错误。
        result = find_slots([[[0, 10]]], d=1, s=0, e=10)
        self.assertEqual(result["status"], "none")
        with self.assertRaises(BadSlotError):
            find_slots([[[0, 10]]], d=0, s=0, e=10)


if __name__ == "__main__":
    unittest.main()
