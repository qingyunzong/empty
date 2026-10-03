import unittest

from sessionize import Sessionizer, compute_sessions

GAP = 10


class TestGapBoundary(unittest.TestCase):
    def test_exact_gap_merges(self):
        sessions = compute_sessions("k", [(0, "a"), (GAP, "b")], GAP)
        self.assertEqual(len(sessions), 1)
        self.assertEqual(
            (sessions[0].start, sessions[0].end, sessions[0].count),
            (0, GAP, 2))

    def test_gap_plus_one_splits(self):
        sessions = compute_sessions("k", [(0, "a"), (GAP + 1, "b")], GAP)
        self.assertEqual(len(sessions), 2)

    def test_late_insert_at_exact_gap_merges(self):
        sz = Sessionizer(gap=GAP, late=10 ** 9)
        sz.add("k", 0, "a")
        sz.add("k", GAP + 1, "b")
        self.assertEqual(len(sz.sessions("k")), 2)
        # 1 - 0 = 1 <= gap and (gap + 1) - 1 = gap <= gap: bridges both.
        sz.add("k", 1, "c")
        (s,) = sz.sessions("k")
        self.assertEqual((s.start, s.end, s.count), (0, GAP + 1, 3))

    def test_late_insert_at_gap_plus_one_does_not_merge(self):
        sz = Sessionizer(gap=GAP, late=10 ** 9)
        sz.add("k", 0, "a")
        sz.add("k", GAP + 2, "b")
        # (gap + 2) - 1 = gap + 1 > gap: only merges the first session.
        sz.add("k", 1, "c")
        self.assertEqual(len(sz.sessions("k")), 2)


class TestFinalizationBoundary(unittest.TestCase):
    def test_end_plus_gap_equal_watermark_is_final(self):
        sz = Sessionizer(gap=GAP, late=5)
        self.assertEqual(sz.add("k", 0, "a"), [])
        # wm = 14 - 5 = 9, end + gap = 10 > 9: not final yet.
        self.assertEqual(sz.add("k", 14, "b"), [])
        # wm = 15 - 5 = 10, end + gap = 10 <= 10: final.
        out = sz.add("k", 15, "c")
        finals = [r for r in out if r["type"] == "FINAL"]
        self.assertEqual(len(finals), 1)
        self.assertEqual((finals[0]["start"], finals[0]["end"]), (0, 0))


if __name__ == "__main__":
    unittest.main()
