import unittest
from fractions import Fraction as F

from intervalmap import IntervalMap, NEG_INF, POS_INF, checker


def seg(lo, hi, **sources):
    return {"lo": F(lo), "hi": F(hi), "sources": sources,
            "count": sum(sources.values())}


class TestBasicOps(unittest.TestCase):
    def test_single_add_canonical(self):
        m = IntervalMap()
        m.add("a", 0, 10)
        self.assertEqual(m.intervals(), [seg(0, 10, a=1)])
        self.assertEqual(m.length(), F(10))
        checker.check_map(m)

    def test_adjacent_same_sources_merge(self):
        m = IntervalMap()
        m.add("a", 0, 5)
        m.add("a", 5, 10)
        self.assertEqual(m.intervals(), [seg(0, 10, a=1)])

    def test_adjacent_different_sources_stay_split(self):
        m = IntervalMap()
        m.add("a", 0, 5)
        m.add("b", 5, 10)
        self.assertEqual(m.intervals(), [seg(0, 5, a=1), seg(5, 10, b=1)])

    def test_overlapping_adds_split_and_merge(self):
        m = IntervalMap()
        m.add("a", 0, 10)
        m.add("b", 3, 7)
        self.assertEqual(m.intervals(), [
            seg(0, 3, a=1), seg(3, 7, a=1, b=1), seg(7, 10, a=1)])
        checker.check_map(m)

    def test_same_source_repeated_add_counts_layers(self):
        m = IntervalMap()
        m.add("a", 0, 10)
        m.add("a", 2, 8)
        m.add("a", 4, 6)
        self.assertEqual(m.intervals(), [
            seg(0, 2, a=1), seg(2, 4, a=2), seg(4, 6, a=3),
            seg(6, 8, a=2), seg(8, 10, a=1)])
        # refcount = sum of per-segment layer counts over canonical segments
        self.assertEqual(m.refcounts(), {"a": 1 + 2 + 3 + 2 + 1})
        checker.check_map(m)

    def test_remove_source_keeps_others(self):
        # deleting one source must not delete time still covered by others
        m = IntervalMap()
        m.add("a", 0, 10)
        m.add("b", 3, 7)
        m.remove_source("a")
        self.assertEqual(m.intervals(), [seg(3, 7, b=1)])
        self.assertEqual(m.refcounts(), {"b": 1})
        checker.check_map(m)

    def test_remove_source_partial_range(self):
        # same source added twice, then partially undone over a subrange
        m = IntervalMap()
        m.add("a", 0, 10)
        m.add("a", 0, 10)
        m.remove_source("a", 2, 5)
        self.assertEqual(m.intervals(), [
            seg(0, 2, a=2), seg(5, 10, a=2)])
        self.assertEqual(m.refcounts(), {"a": 4})
        checker.check_map(m)

    def test_remove_source_full_undo_restores_empty(self):
        m = IntervalMap()
        m.add("a", 0, 10)
        m.add("b", 0, 10)
        m.remove_source("a")
        m.remove_source("b")
        self.assertEqual(m.intervals(), [])
        self.assertEqual(m.length(), F(0))
        self.assertEqual(m.refcounts(), {})
        self.assertEqual(m.events(), {})
        checker.check_map(m)

    def test_full_containment(self):
        m = IntervalMap()
        m.add("a", 0, 100)
        m.add("b", 10, 20)  # fully contained
        m.remove_source("a", 30, 40)  # punch a hole
        self.assertEqual(m.intervals(), [
            seg(0, 10, a=1), seg(10, 20, a=1, b=1), seg(20, 30, a=1),
            seg(40, 100, a=1)])
        checker.check_map(m)

    def test_zero_length_add_is_noop(self):
        m = IntervalMap()
        m.add("a", 0, 10)
        before = m.snapshot()
        m.add("b", 5, 5)
        m.remove_source("a", 3, 3)
        self.assertEqual(m.intervals(), [seg(0, 10, a=1)])
        self.assertEqual(m.refcounts(), {"a": 1})
        self.assertEqual(m.events(), before.events)

    def test_illegal_range_changes_nothing(self):
        m = IntervalMap()
        m.add("a", 0, 10)
        before = (m.intervals(), m.refcounts(), m.events(), m.length())
        with self.assertRaises(ValueError):
            m.add("b", 8, 3)
        with self.assertRaises(ValueError):
            m.remove_source("a", 9, 2)
        after = (m.intervals(), m.refcounts(), m.events(), m.length())
        self.assertEqual(before, after)

    def test_infinite_endpoints(self):
        m = IntervalMap()
        m.add("a", "-inf", "+inf")
        m.add("b", "-inf", 0)
        self.assertEqual(m.intervals(), [
            {"lo": NEG_INF, "hi": F(0), "sources": {"a": 1, "b": 1}, "count": 2},
            {"lo": F(0), "hi": POS_INF, "sources": {"a": 1}, "count": 1}])
        self.assertEqual(m.length(), POS_INF)
        m.remove_source("a", 5, "+inf")
        self.assertEqual(m.intervals(), [
            {"lo": NEG_INF, "hi": F(0), "sources": {"a": 1, "b": 1}, "count": 2},
            {"lo": F(0), "hi": F(5), "sources": {"a": 1}, "count": 1}])
        checker.check_map(m)

    def test_rational_precision(self):
        m = IntervalMap()
        m.add("a", "1/3", "2/3")
        m.add("a", "2/3", "5/6")
        self.assertEqual(m.intervals(),
                         [seg(F(1, 3), F(5, 6), a=1)])
        self.assertEqual(m.length(), F(1, 2))


class TestThreshold(unittest.TestCase):
    def test_threshold_with_proofs(self):
        m = IntervalMap()
        m.add("a", 0, 10)
        m.add("b", 2, 8)
        m.add("c", 4, 6)
        res = m.covered_at_least(2)
        self.assertEqual(res, [
            {"lo": F(2), "hi": F(4), "sources": {"a": 1, "b": 1}, "count": 2},
            {"lo": F(4), "hi": F(6), "sources": {"a": 1, "b": 1, "c": 1}, "count": 3},
            {"lo": F(6), "hi": F(8), "sources": {"a": 1, "b": 1}, "count": 2}])
        checker.check_threshold_result(m.intervals(), 2, res)
        # proofs name the actual sources
        self.assertEqual(set(res[1]["sources"]), {"a", "b", "c"})

    def test_threshold_merges_only_equal_source_sets(self):
        m = IntervalMap()
        m.add("a", 0, 10)
        m.add("a", 0, 5)
        m.add("a", 5, 10)
        # coverage is 2 everywhere with identical sources -> single segment
        self.assertEqual(m.covered_at_least(2), [
            {"lo": F(0), "hi": F(10), "sources": {"a": 2}, "count": 2}])

    def test_threshold_none_qualify(self):
        m = IntervalMap()
        m.add("a", 0, 5)
        self.assertEqual(m.covered_at_least(2), [])


class TestSetOps(unittest.TestCase):
    def setUp(self):
        self.a = IntervalMap()
        self.a.add("a", 0, 10)
        self.a.add("a", 20, 30)
        self.b = IntervalMap()
        self.b.add("b", 5, 25)

    def test_union(self):
        u = self.a.union(self.b)
        self.assertEqual(u.intervals(), [
            seg(0, 5, a=1), seg(5, 10, a=1, b=1), seg(10, 20, b=1),
            seg(20, 25, a=1, b=1), seg(25, 30, a=1)])
        checker.check_map(u)

    def test_intersection(self):
        i = self.a.intersection(self.b)
        self.assertEqual(i.intervals(), [
            seg(5, 10, a=1, b=1), seg(20, 25, a=1, b=1)])

    def test_difference(self):
        d = self.a.difference(self.b)
        self.assertEqual(d.intervals(), [seg(0, 5, a=1), seg(25, 30, a=1)])

    def test_operands_unchanged(self):
        before_a, before_b = self.a.intervals(), self.b.intervals()
        self.a.union(self.b)
        self.a.intersection(self.b)
        self.a.difference(self.b)
        self.assertEqual(self.a.intervals(), before_a)
        self.assertEqual(self.b.intervals(), before_b)


class TestTransactionsAndSnapshots(unittest.TestCase):
    def test_nested_commit_and_rollback(self):
        m = IntervalMap()
        m.add("a", 0, 10)
        m.begin()
        m.add("b", 0, 10)
        m.begin()
        m.add("c", 0, 10)
        m.rollback()  # undo c only
        self.assertEqual(m.intervals(), [seg(0, 10, a=1, b=1)])
        m.rollback()  # undo b
        self.assertEqual(m.intervals(), [seg(0, 10, a=1)])
        self.assertEqual(m.transaction_depth, 0)

    def test_commit_keeps_changes(self):
        m = IntervalMap()
        m.begin()
        m.add("a", 0, 5)
        m.commit()
        self.assertEqual(m.intervals(), [seg(0, 5, a=1)])

    def test_rollback_restores_refcounts_events_length(self):
        m = IntervalMap()
        m.add("a", 0, 10)
        snap = (m.refcounts(), m.events(), m.length())
        m.begin()
        m.add("b", 2, 8)
        m.add("c", 4, 6)
        self.assertNotEqual(m.refcounts(), snap[0])
        m.rollback()
        self.assertEqual((m.refcounts(), m.events(), m.length()), snap)
        checker.check_map(m)

    def test_transaction_split_then_failure(self):
        # splits happen inside a transaction that later fails -> all undone
        m = IntervalMap()
        m.add("a", 0, 100)
        m.begin()
        for i in range(10):
            m.add("b", i * 10 + 2, i * 10 + 8)  # forces many splits
        self.assertGreater(len(m.intervals()), 10)
        m.rollback()
        self.assertEqual(m.intervals(), [seg(0, 100, a=1)])
        checker.check_map(m)

    def test_snapshot_save_restore(self):
        m = IntervalMap()
        m.add("a", 0, 10)
        v1 = m.snapshot()
        m.add("b", 5, 15)
        v2 = m.snapshot()
        m.remove_source("a")
        self.assertEqual(m.intervals(), [seg(5, 15, b=1)])
        m.restore(v1)
        self.assertEqual(m.intervals(), [seg(0, 10, a=1)])
        m.restore(v2)
        self.assertEqual(m.intervals(), [seg(0, 5, a=1), seg(5, 10, a=1, b=1),
                                         seg(10, 15, b=1)])

    def test_rollback_branching(self):
        # restore an old snapshot, diverge, old snapshots still valid
        m = IntervalMap()
        m.add("a", 0, 10)
        base = m.snapshot()
        m.add("b", 0, 10)
        branch1 = m.snapshot()
        m.restore(base)
        m.add("c", 20, 30)  # diverge from base
        self.assertEqual(m.intervals(), [seg(0, 10, a=1), seg(20, 30, c=1)])
        m.restore(branch1)  # the other branch is still intact
        self.assertEqual(m.intervals(), [seg(0, 10, a=1, b=1)])
        m.restore(base)
        m.begin()
        m.add("d", 0, 5)
        m.rollback()
        self.assertEqual(m.intervals(), [seg(0, 10, a=1)])
        checker.check_map(m)

    def test_unbalanced_tx_errors(self):
        m = IntervalMap()
        with self.assertRaises(RuntimeError):
            m.commit()
        with self.assertRaises(RuntimeError):
            m.rollback()


class TestEvents(unittest.TestCase):
    def test_endpoint_events(self):
        m = IntervalMap()
        m.add("a", 0, 10)
        m.add("b", 5, 15)
        ev = m.events()
        self.assertEqual(ev[F(0)], {"enter": {"a": 1}, "leave": {}})
        self.assertEqual(ev[F(5)], {"enter": {"a": 1, "b": 1}, "leave": {"a": 1}})
        self.assertEqual(ev[F(10)], {"enter": {"b": 1}, "leave": {"a": 1, "b": 1}})
        self.assertEqual(ev[F(15)], {"enter": {}, "leave": {"b": 1}})
        checker.check_map(m)


if __name__ == "__main__":
    unittest.main()
