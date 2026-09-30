import math
import unittest
from fractions import Fraction

from intervalmap import (
    IntervalMap, Workspace, NEG_INF, POS_INF,
    check_canonical, verify_threshold,
)


def seg(lo, hi, **sources):
    return (Fraction(lo), Fraction(hi), sources)


class TestBasicAddAndCanonicalForm(unittest.TestCase):
    def test_single_add(self):
        m = IntervalMap().add(0, 5, "a")
        self.assertEqual(m.segments(), [seg(0, 5, a=1)])
        self.assertEqual(m.total_length, Fraction(5))
        self.assertEqual(m.refcount("a"), 1)
        self.assertEqual(check_canonical(m), [])

    def test_adjacent_same_source_merges(self):
        m = IntervalMap().add(0, 1, "a").add(1, 2, "a")
        self.assertEqual(m.segments(), [seg(0, 2, a=1)])

    def test_adjacent_different_sources_do_not_merge(self):
        m = IntervalMap().add(0, 1, "a").add(1, 2, "b")
        self.assertEqual(m.segments(), [seg(0, 1, a=1), seg(1, 2, b=1)])

    def test_same_endpoint_in_and_out(self):
        # one source ends exactly where another begins: no zero-width
        # artifacts, no merge across different source sets
        m = IntervalMap().add(0, 1, "a").add(1, 2, "b").add(2, 3, "a")
        self.assertEqual(
            m.segments(),
            [seg(0, 1, a=1), seg(1, 2, b=1), seg(2, 3, a=1)])
        self.assertEqual(check_canonical(m), [])

    def test_touching_identical_multisets_merge_across_gap_fill(self):
        m = IntervalMap().add(0, 1, "a").add(2, 3, "a").add(1, 2, "a")
        self.assertEqual(m.segments(), [seg(0, 3, a=1)])

    def test_overlapping_add_splits_and_counts(self):
        m = IntervalMap().add(0, 4, "a").add(2, 6, "b")
        self.assertEqual(
            m.segments(),
            [seg(0, 2, a=1), seg(2, 4, a=1, b=1), seg(4, 6, b=1)])
        self.assertEqual(m.total_length, Fraction(6))
        self.assertEqual(check_canonical(m), [])

    def test_fully_contained_add(self):
        m = IntervalMap().add(0, 10, "a").add(3, 5, "b")
        self.assertEqual(
            m.segments(),
            [seg(0, 3, a=1), seg(3, 5, a=1, b=1), seg(5, 10, a=1)])
        self.assertEqual(check_canonical(m), [])

    def test_rational_endpoints_exact(self):
        m = IntervalMap().add(Fraction(1, 3), Fraction(1, 2), "a")
        m = m.add(Fraction(1, 2), Fraction(2, 3), "a")
        self.assertEqual(m.segments(),
                         [seg(Fraction(1, 3), Fraction(2, 3), a=1)])
        self.assertEqual(m.total_length, Fraction(1, 3))

    def test_sources_at(self):
        m = IntervalMap().add(0, 4, "a").add(2, 6, "b")
        self.assertEqual(m.sources_at(Fraction(1)), {"a": 1})
        self.assertEqual(m.sources_at(Fraction(3)), {"a": 1, "b": 1})
        self.assertEqual(m.sources_at(Fraction(4)), {"b": 1})  # half-open
        self.assertEqual(m.sources_at(Fraction(99)), {})


class TestInvalidAndDegenerateInput(unittest.TestCase):
    def test_zero_length_add_is_noop(self):
        m = IntervalMap().add(0, 3, "a")
        m2 = m.add(2, 2, "b")
        self.assertIs(m2, m)
        self.assertEqual(m.segments(), [seg(0, 3, a=1)])

    def test_invalid_endpoint_order_changes_nothing(self):
        m = IntervalMap().add(0, 3, "a").add(5, 8, "b")
        before_segments = m.segments()
        before_refs = m.refcounts
        before_total = m.total_length
        with self.assertRaises(ValueError):
            m.add(4, 1, "c")
        self.assertEqual(m.segments(), before_segments)
        self.assertEqual(m.refcounts, before_refs)
        self.assertEqual(m.total_length, before_total)
        self.assertEqual(check_canonical(m), [])

    def test_invalid_count_rejected(self):
        m = IntervalMap()
        with self.assertRaises(ValueError):
            m.add(0, 1, "a", count=0)
        with self.assertRaises(ValueError):
            m.add(0, 1, "")
        self.assertEqual(m.segments(), [])


class TestInfiniteEndpoints(unittest.TestCase):
    def test_open_ended_intervals(self):
        m = IntervalMap().add(NEG_INF, 0, "a").add(0, POS_INF, "a")
        self.assertEqual(m.segments(), [(NEG_INF, POS_INF, {"a": 1})])
        self.assertEqual(m.total_length, math.inf)
        self.assertEqual(check_canonical(m), [])

    def test_infinite_and_finite_mix(self):
        m = IntervalMap().add(NEG_INF, 3, "a").add(1, 2, "b")
        segs = m.segments()
        self.assertEqual(segs[0], (NEG_INF, Fraction(1), {"a": 1}))
        self.assertEqual(segs[1], (Fraction(1), Fraction(2), {"a": 1, "b": 1}))
        self.assertEqual(segs[2], (Fraction(2), Fraction(3), {"a": 1}))
        self.assertEqual(m.total_length, math.inf)

    def test_threshold_with_infinite_length(self):
        m = IntervalMap().add(NEG_INF, POS_INF, "a").add(0, 1, "b")
        res = m.covered_by_at_least(2)
        self.assertEqual(res, [(Fraction(0), Fraction(1), {"a": 1, "b": 1})])
        self.assertEqual(verify_threshold(m, 2, res), [])
        res1 = m.covered_by_at_least(1)
        self.assertEqual(res1, [
            (NEG_INF, Fraction(0), {"a": 1}),
            (Fraction(0), Fraction(1), {"a": 1, "b": 1}),
            (Fraction(1), POS_INF, {"a": 1}),
        ])
        self.assertEqual(verify_threshold(m, 1, res1), [])
        self.assertEqual(m.length_at_least(1), math.inf)


class TestRevoke(unittest.TestCase):
    def test_revoke_one_source_keeps_others(self):
        m = IntervalMap().add(0, 4, "a").add(2, 6, "b")
        m2 = m.revoke("a")
        self.assertEqual(m2.segments(), [seg(2, 6, b=1)])
        self.assertEqual(m2.refcounts, {"b": 1})
        # original untouched (persistence)
        self.assertEqual(len(m.segments()), 3)
        self.assertEqual(check_canonical(m2), [])

    def test_repeated_add_then_partial_revoke(self):
        m = IntervalMap().add(0, 5, "a").add(0, 5, "a").add(0, 5, "a")
        self.assertEqual(m.segments(), [seg(0, 5, a=3)])
        self.assertEqual(m.refcount("a"), 3)
        m2 = m.revoke("a", count=1)
        self.assertEqual(m2.segments(), [seg(0, 5, a=2)])
        self.assertEqual(m2.refcount("a"), 2)
        m3 = m2.revoke("a", count=5)  # over-revoke clamps at zero
        self.assertEqual(m3.segments(), [])
        self.assertEqual(m3.refcounts, {})

    def test_partial_revoke_overlapping_regions(self):
        m = IntervalMap().add(0, 4, "a").add(2, 6, "a")
        self.assertEqual(m.segments(),
                         [seg(0, 2, a=1), seg(2, 4, a=2), seg(4, 6, a=1)])
        m2 = m.revoke("a", count=1)
        # per-segment decrement: singly-covered parts drop out entirely
        self.assertEqual(m2.segments(), [seg(2, 4, a=1)])
        self.assertEqual(m2.refcount("a"), 1)
        self.assertEqual(check_canonical(m2), [])
        self.assertEqual(check_canonical(m2), [])

    def test_revoke_absent_source_is_noop(self):
        m = IntervalMap().add(0, 1, "a")
        self.assertIs(m.revoke("zzz"), m)


class TestBinaryOps(unittest.TestCase):
    def setUp(self):
        self.a = IntervalMap().add(0, 4, "a").add(10, 12, "a")
        self.b = IntervalMap().add(2, 11, "b")

    def test_union(self):
        u = self.a.union(self.b)
        self.assertEqual(
            u.segments(),
            [seg(0, 2, a=1), seg(2, 4, a=1, b=1), seg(4, 10, b=1),
             seg(10, 11, a=1, b=1), seg(11, 12, a=1)])
        self.assertEqual(check_canonical(u), [])

    def test_intersection(self):
        i = self.a.intersection(self.b)
        self.assertEqual(i.segments(),
                         [seg(2, 4, a=1, b=1), seg(10, 11, a=1, b=1)])
        self.assertEqual(i.total_length, Fraction(3))

    def test_difference(self):
        d = self.a.difference(self.b)
        self.assertEqual(d.segments(), [seg(0, 2, a=1), seg(11, 12, a=1)])

    def test_difference_fully_contained(self):
        big = IntervalMap().add(0, 10, "a")
        small = IntervalMap().add(3, 5, "b")
        d = big.difference(small)
        self.assertEqual(d.segments(), [seg(0, 3, a=1), seg(5, 10, a=1)])
        self.assertEqual(check_canonical(d), [])

    def test_union_with_empty(self):
        m = IntervalMap().add(0, 1, "a")
        self.assertEqual(m.union(IntervalMap()).segments(), m.segments())
        self.assertEqual(IntervalMap().union(m).segments(), m.segments())
        self.assertEqual(m.intersection(IntervalMap()).segments(), [])
        self.assertEqual(m.difference(IntervalMap()).segments(), m.segments())


class TestThresholdQuery(unittest.TestCase):
    def test_threshold_and_proofs(self):
        m = (IntervalMap()
             .add(0, 10, "a")
             .add(2, 8, "b")
             .add(4, 6, "c"))
        res = m.covered_by_at_least(2)
        self.assertEqual(res, [
            (Fraction(2), Fraction(4), {"a": 1, "b": 1}),
            (Fraction(4), Fraction(6), {"a": 1, "b": 1, "c": 1}),
            (Fraction(6), Fraction(8), {"a": 1, "b": 1}),
        ])
        self.assertEqual(verify_threshold(m, 2, res), [])
        res3 = m.covered_by_at_least(3)
        self.assertEqual(res3, [(Fraction(4), Fraction(6),
                                 {"a": 1, "b": 1, "c": 1})])
        self.assertEqual(verify_threshold(m, 3, res3), [])
        self.assertEqual(m.length_at_least(2), Fraction(6))

    def test_count_mode_uses_coverage_counts(self):
        m = IntervalMap().add(0, 5, "a").add(1, 2, "a")
        res = m.covered_by_at_least(2, count_mode=True)
        self.assertEqual(res, [(Fraction(1), Fraction(2), {"a": 2})])
        self.assertEqual(verify_threshold(m, 2, res, count_mode=True), [])
        # distinct-source mode sees only one source everywhere
        self.assertEqual(m.covered_by_at_least(2), [])

    def test_checker_detects_tampered_result(self):
        m = IntervalMap().add(0, 4, "a").add(2, 6, "b")
        res = m.covered_by_at_least(2)
        self.assertEqual(verify_threshold(m, 2, res), [])
        bad = [(Fraction(2), Fraction(5), {"a": 1, "b": 1})]
        self.assertTrue(verify_threshold(m, 2, bad))
        bad_proof = [(Fraction(2), Fraction(4), {"a": 1})]
        self.assertTrue(verify_threshold(m, 2, bad_proof))


class TestTransactionsAndSnapshots(unittest.TestCase):
    def test_nested_transaction_rollback(self):
        ws = Workspace()
        ws.add(0, 10, "a")
        ws.snapshot("base")
        ws.begin()
        ws.add(3, 5, "b")          # splits the middle
        ws.begin()
        ws.add(4, 6, "c")
        self.assertEqual(len(ws.current.segments()), 5)
        ws.rollback()              # undo inner
        self.assertEqual(ws.current.refcount("c"), 0)
        self.assertEqual(ws.current.refcount("b"), 1)
        ws.rollback()              # undo outer
        self.assertEqual(ws.current.segments(), [seg(0, 10, a=1)])
        self.assertEqual(ws.current.total_length, Fraction(10))
        self.assertEqual(ws.current.refcounts, {"a": 1})

    def test_transaction_context_manager_failure(self):
        ws = Workspace()
        ws.add(0, 10, "a")
        before = ws.current
        with self.assertRaises(RuntimeError):
            with ws.transaction():
                ws.add(3, 5, "b")   # split inside transaction
                ws.add(4, 12, "c")
                raise RuntimeError("boom")
        self.assertIs(ws.current, before)
        self.assertEqual(ws.current.segments(), [seg(0, 10, a=1)])
        self.assertEqual(ws.transaction_depth, 0)

    def test_commit_keeps_changes(self):
        ws = Workspace()
        with ws.transaction():
            ws.add(0, 2, "a")
            with ws.transaction():
                ws.add(1, 3, "b")
        self.assertEqual(
            ws.current.segments(),
            [seg(0, 1, a=1), seg(1, 2, a=1, b=1), seg(2, 3, b=1)])

    def test_snapshot_branching(self):
        ws = Workspace()
        ws.add(0, 5, "a")
        ws.snapshot("v1")
        ws.add(0, 5, "b")
        ws.snapshot("v2")
        ws.restore("v1")           # branch off the old snapshot
        ws.add(10, 20, "c")
        self.assertEqual(ws.current.segments(),
                         [seg(0, 5, a=1), seg(10, 20, c=1)])
        ws.restore("v2")           # the other branch still exists
        self.assertEqual(ws.current.segments(), [seg(0, 5, a=1, b=1)])
        self.assertEqual(ws.current.refcounts, {"a": 1, "b": 1})

    def test_rollback_restores_aggregates_and_refcounts_together(self):
        ws = Workspace()
        ws.add(0, 4, "a")
        ws.add(2, 6, "b")
        total_before = ws.current.total_length
        refs_before = ws.current.refcounts
        ws.begin()
        ws.revoke("a")
        ws.add(100, 200, "c")
        ws.rollback()
        self.assertEqual(ws.current.total_length, total_before)
        self.assertEqual(ws.current.refcounts, refs_before)
        self.assertEqual(check_canonical(ws.current), [])


class TestPersistence(unittest.TestCase):
    def test_json_roundtrip(self):
        m = (IntervalMap()
             .add(NEG_INF, Fraction(1, 3), "a")
             .add(0, 2, "b")
             .add(5, POS_INF, "c"))
        data = m.to_json()
        m2 = IntervalMap.from_json(data)
        self.assertEqual(m2.segments(), m.segments())
        self.assertEqual(m2.refcounts, m.refcounts)
        self.assertEqual(m2.total_length, m.total_length)
        self.assertEqual(check_canonical(m2), [])

    def test_from_json_rejects_bad_segments(self):
        with self.assertRaises(ValueError):
            IntervalMap.from_json({"segments": [
                {"lo": "5", "hi": "1", "sources": {"a": 1}}]})
        with self.assertRaises(ValueError):
            IntervalMap.from_json({"segments": [
                {"lo": "0", "hi": "1", "sources": {}}]})


if __name__ == "__main__":
    unittest.main()
