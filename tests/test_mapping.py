import unittest

from timeline import Instant, LocalDateTime, local_to_instant, instant_to_local
from tzhelpers import L, U, brute_candidates, dst_table, historical_table


class GapAndFoldTest(unittest.TestCase):
    def setUp(self):
        self.table = dst_table()

    def test_forward_jump_gap_has_zero_candidates(self):
        # 2024-03-31 01:00:00 .. 01:59:59 local never happens
        for minute in range(60):
            local = L(2024, 3, 31, 1, minute, 0)
            self.assertEqual(local_to_instant(self.table, local), [])
            self.assertEqual(brute_candidates(self.table.segments, local), [])

    def test_gap_edges(self):
        # last valid local second before the gap
        before = local_to_instant(self.table, L(2024, 3, 31, 0, 59, 59))
        self.assertEqual([c.instant for c in before], [U(2024, 3, 31, 0, 59, 59)])
        # first valid local second after the gap
        after = local_to_instant(self.table, L(2024, 3, 31, 2, 0, 0))
        self.assertEqual([c.instant for c in after], [U(2024, 3, 31, 1, 0, 0)])
        self.assertEqual(after[0].segment.seg_id, "summer")

    def test_backward_jump_fold_has_two_candidates(self):
        local = L(2024, 10, 27, 1, 30, 0)
        cands = local_to_instant(self.table, local)
        self.assertEqual(len(cands), 2)
        self.assertEqual([c.instant for c in cands],
                         [U(2024, 10, 27, 0, 30, 0), U(2024, 10, 27, 1, 30, 0)])
        self.assertEqual([c.segment.seg_id for c in cands],
                         ["summer", "winter-after"])

    def test_same_wall_clock_candidates_sorted_by_instant(self):
        # every second of the folded hour must yield the same ordered pair
        for second in range(3600):
            local = L(2024, 10, 27, 1, 0, 0) + second
            cands = local_to_instant(self.table, local)
            self.assertEqual(len(cands), 2)
            self.assertLess(cands[0].instant, cands[1].instant)
            self.assertEqual(cands[1].instant - cands[0].instant, 3600)
            self.assertEqual([c.instant for c in cands],
                             brute_candidates(self.table.segments, local))

    def test_normal_time_has_one_candidate(self):
        cands = local_to_instant(self.table, L(2024, 7, 1, 12, 0, 0))
        self.assertEqual(len(cands), 1)
        self.assertEqual(cands[0].instant, U(2024, 7, 1, 11, 0, 0))

    def test_candidate_evidence_is_verifiable(self):
        from timeline import verify_candidate
        local = L(2024, 10, 27, 1, 15, 0)
        for cand in local_to_instant(self.table, local):
            self.assertTrue(
                verify_candidate(self.table, local, cand.evidence()))
        # tampered evidence must fail
        cands = local_to_instant(self.table, local)
        bad = dict(cands[0].evidence())
        bad["instant"] += 1
        self.assertFalse(verify_candidate(self.table, local, bad))


class HistoricalOffsetTest(unittest.TestCase):
    def setUp(self):
        self.table = historical_table()

    def test_non_whole_hour_offsets(self):
        # +08:05:43 local mean time
        cands = local_to_instant(self.table, L(2023, 6, 1, 8, 5, 43))
        self.assertEqual([c.instant for c in cands], [U(2023, 6, 1, 0, 0, 0)])
        # +05:45 zone: local 2024-07-01T00:30:00 -> 2024-06-30T18:45:00Z
        cands = local_to_instant(self.table, L(2024, 7, 1, 0, 30, 0))
        self.assertEqual(cands[0].segment.seg_id, "plus545")
        self.assertEqual(cands[0].instant, U(2024, 6, 30, 18, 45, 0))

    def test_cross_midnight_transition(self):
        # At 2024-06-30T18:30:00Z the offset jumps +05:30 -> +05:45, which
        # carries the wall clock across midnight: local time leaps from
        # 2024-06-30T23:59:59 straight to 2024-07-01T00:15:00.  The first
        # fifteen minutes of July 1st never happen locally.
        for second in range(15 * 60):
            self.assertEqual(
                local_to_instant(self.table, L(2024, 7, 1, 0, 0, 0) + second),
                [])
        cands = local_to_instant(self.table, L(2024, 7, 1, 0, 15, 0))
        self.assertEqual(len(cands), 1)
        self.assertEqual(cands[0].instant, U(2024, 6, 30, 18, 30, 0))
        self.assertEqual(cands[0].segment.seg_id, "plus545")
        # one wall-clock second earlier belongs to the previous calendar
        # day and the previous segment
        cands = local_to_instant(self.table, L(2024, 6, 30, 23, 59, 59))
        self.assertEqual(cands[0].segment.seg_id, "plus530")
        self.assertEqual(cands[0].instant, U(2024, 6, 30, 18, 29, 59))

    def test_consecutive_offset_changes(self):
        # two transitions 30 minutes apart: +05:30 -> +05:45 -> +06:30.
        # The second jump (45 min forward) opens a local gap
        # [2024-07-01 00:45:00, 01:30:00).
        for second in range(45 * 60):
            local = L(2024, 7, 1, 0, 45, 0) + second
            self.assertEqual(local_to_instant(self.table, local), [])
        before = local_to_instant(self.table, L(2024, 7, 1, 0, 44, 59))
        self.assertEqual(before[0].segment.seg_id, "plus545")
        after = local_to_instant(self.table, L(2024, 7, 1, 1, 30, 0))
        self.assertEqual(after[0].segment.seg_id, "plus630")
        self.assertEqual(after[0].instant, U(2024, 6, 30, 19, 0, 0))

    def test_instant_to_local_roundtrip(self):
        for instant in (U(2024, 3, 31, 0, 59, 59), U(2024, 3, 31, 1, 0, 0),
                        U(2024, 10, 27, 0, 30, 0), U(2024, 10, 27, 1, 30, 0)):
            local, seg = instant_to_local(self.table, instant)
            cands = local_to_instant(self.table, local)
            self.assertIn(instant, [c.instant for c in cands])


if __name__ == "__main__":
    unittest.main()
