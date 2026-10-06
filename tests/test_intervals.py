import unittest

from timeline import Instant, LocalInterval, convert_interval
from tzhelpers import L, U, dst_table, historical_table


class IntervalGapTest(unittest.TestCase):
    def setUp(self):
        self.table = dst_table()

    def test_interval_split_at_forward_jump(self):
        # local [00:30, 02:30) on spring-forward day: the hour 01:00-02:00
        # is a gap, so the UTC union is two pieces and 3600 UTC seconds
        # instead of 7200.
        result = convert_interval(self.table.segments, LocalInterval(
            L(2024, 3, 31, 0, 30), L(2024, 3, 31, 2, 30)))
        self.assertEqual(len(result.pieces), 2)
        first, second = result.pieces
        self.assertEqual((first.start, first.end),
                         (U(2024, 3, 31, 0, 30), U(2024, 3, 31, 1, 0)))
        self.assertEqual((second.start, second.end),
                         (U(2024, 3, 31, 1, 0), U(2024, 3, 31, 1, 30)))
        self.assertEqual([(g.start, g.end) for g in result.gaps],
                         [(L(2024, 3, 31, 1, 0), L(2024, 3, 31, 2, 0))])
        self.assertEqual(
            sum(p.end - p.start for p in result.pieces), 3600)

    def test_interval_endpoints_exactly_at_jump(self):
        # start exactly at the gap start, end exactly at the gap end
        result = convert_interval(self.table.segments, LocalInterval(
            L(2024, 3, 31, 1, 0), L(2024, 3, 31, 2, 0)))
        self.assertEqual(result.pieces, ())
        self.assertEqual([(g.start, g.end) for g in result.gaps],
                         [(L(2024, 3, 31, 1, 0), L(2024, 3, 31, 2, 0))])

    def test_open_closed_boundaries_preserved(self):
        # open start at the gap edge: the UTC piece must inherit the open
        # start; closed end must be inherited too.
        result = convert_interval(self.table.segments, LocalInterval(
            L(2024, 3, 31, 0, 30), L(2024, 3, 31, 0, 45),
            start_closed=False, end_closed=True))
        (piece,) = result.pieces
        self.assertFalse(piece.start_closed)
        self.assertTrue(piece.end_closed)
        # a cut made by a segment boundary is closed on the right piece and
        # open on the left piece (half-open UTC segments)
        result = convert_interval(self.table.segments, LocalInterval(
            L(2024, 3, 31, 0, 30), L(2024, 3, 31, 2, 30)))
        first, second = result.pieces
        self.assertTrue(first.start_closed)
        self.assertFalse(first.end_closed)
        self.assertTrue(second.start_closed)
        self.assertFalse(second.end_closed)


class IntervalFoldTest(unittest.TestCase):
    def setUp(self):
        self.table = dst_table()

    def test_fold_produces_duplicate_source_pieces(self):
        # local [00:30, 02:30) on fall-back day spans the folded hour
        result = convert_interval(self.table.segments, LocalInterval(
            L(2024, 10, 27, 0, 30), L(2024, 10, 27, 2, 30)))
        self.assertEqual(len(result.pieces), 2)
        first, second = result.pieces
        self.assertEqual(first.segment_id, "summer")
        self.assertEqual(second.segment_id, "winter-after")
        # the local hour [01:00, 02:00) is the duplicated source of both
        self.assertTrue(first.duplicate)
        self.assertTrue(second.duplicate)
        overlap_lo = max(first.source_local_start, second.source_local_start)
        overlap_hi = min(first.source_local_end, second.source_local_end)
        self.assertEqual((overlap_lo, overlap_hi),
                         (L(2024, 10, 27, 1, 0), L(2024, 10, 27, 2, 0)))
        # UTC union covers 3 hours for a 2-hour wall-clock interval
        self.assertEqual(
            sum(p.end - p.start for p in result.pieces), 3 * 3600)
        self.assertEqual(result.gaps, ())

    def test_interval_entirely_inside_fold(self):
        result = convert_interval(self.table.segments, LocalInterval(
            L(2024, 10, 27, 1, 15), L(2024, 10, 27, 1, 45)))
        self.assertEqual(len(result.pieces), 2)
        for piece in result.pieces:
            self.assertTrue(piece.duplicate)
            self.assertEqual(piece.end - piece.start, 1800)
            self.assertEqual(
                (piece.source_local_start, piece.source_local_end),
                (L(2024, 10, 27, 1, 15), L(2024, 10, 27, 1, 45)))
        # the two UTC pieces are disjoint and exactly one hour apart
        first, second = result.pieces
        self.assertLessEqual(first.end, second.start)
        self.assertEqual(second.start - first.start, 3600)
        self.assertEqual(second.end - first.end, 3600)

    def test_endpoint_at_fold_boundary(self):
        # interval ends exactly where the fold begins
        result = convert_interval(self.table.segments, LocalInterval(
            L(2024, 10, 27, 0, 0), L(2024, 10, 27, 1, 0)))
        self.assertEqual(len(result.pieces), 1)
        self.assertFalse(result.pieces[0].duplicate)


class IntervalHistoricalTest(unittest.TestCase):
    def setUp(self):
        self.table = historical_table()

    def test_split_across_consecutive_transitions(self):
        # local interval spanning both 2024-06-30 transitions (the 15-minute
        # gap across midnight and the 45-minute gap) splits into 3 pieces
        result = convert_interval(self.table.segments, LocalInterval(
            L(2024, 6, 30, 23, 30), L(2024, 7, 1, 2, 0)))
        self.assertEqual(len(result.pieces), 3)
        self.assertEqual([p.segment_id for p in result.pieces],
                         ["plus530", "plus545", "plus630"])
        self.assertEqual(len(result.gaps), 2)
        # non-whole-hour offsets show up in the UTC piece boundaries
        self.assertEqual(result.pieces[0].end, U(2024, 6, 30, 18, 30, 0))
        self.assertEqual(result.pieces[1].start, U(2024, 6, 30, 18, 30, 0))
        self.assertEqual(result.pieces[1].end, U(2024, 6, 30, 19, 0, 0))


if __name__ == "__main__":
    unittest.main()
