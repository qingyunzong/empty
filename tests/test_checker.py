import unittest
from fractions import Fraction as F

from intervalmap import IntervalMap, checker
from intervalmap.checker import CheckFailure


def make_map():
    m = IntervalMap()
    m.add("a", 0, 10)
    m.add("b", 5, 15)
    return m


class TestCheckerAccepts(unittest.TestCase):
    def test_valid_map_passes(self):
        checker.check_map(make_map())

    def test_valid_threshold_passes(self):
        m = make_map()
        for k in (1, 2):
            checker.check_threshold_result(m.intervals(), k, m.covered_at_least(k))


class TestCheckerRejects(unittest.TestCase):
    def setUp(self):
        self.m = make_map()
        self.segs = self.m.intervals()

    def test_unmerged_adjacent_segments(self):
        bad = [dict(self.segs[0]),
               {"lo": F(5), "hi": F(7), "sources": {"a": 1, "b": 1}, "count": 2},
               {"lo": F(7), "hi": F(10), "sources": {"a": 1, "b": 1}, "count": 2},
               dict(self.segs[2])]
        with self.assertRaises(CheckFailure):
            checker.check_canonical(bad)

    def test_overlapping_segments(self):
        bad = [dict(self.segs[0]),
               {"lo": F(4), "hi": F(6), "sources": {"a": 1}, "count": 1}]
        with self.assertRaises(CheckFailure):
            checker.check_canonical(bad)

    def test_tampered_proof(self):
        m = self.m
        result = m.covered_at_least(2)
        result[0]["sources"] = {"a": 1, "evil": 1}
        with self.assertRaises(CheckFailure):
            checker.check_threshold_result(m.intervals(), 2, result)

    def test_incomplete_threshold_result(self):
        m = IntervalMap()
        m.add("a", 0, 10)
        m.add("b", 0, 5)
        m.add("b", 7, 10)
        result = [r for r in m.covered_at_least(2) if r["lo"] != F(7)]
        with self.assertRaises(CheckFailure):
            checker.check_threshold_result(m.intervals(), 2, result)

    def test_wrong_events(self):
        events = self.m.events()
        events[F(5)]["enter"] = {"a": 99}
        with self.assertRaises(CheckFailure):
            checker.check_events(self.segs, events)

    def test_missing_event_endpoint(self):
        events = self.m.events()
        del events[F(10)]
        with self.assertRaises(CheckFailure):
            checker.check_events(self.segs, events)

    def test_wrong_refcounts(self):
        with self.assertRaises(CheckFailure):
            checker.check_refcounts(self.segs, {"a": 7})

    def test_wrong_total_length(self):
        with self.assertRaises(CheckFailure):
            checker.check_total_length(self.segs, F(1))


if __name__ == "__main__":
    unittest.main()
