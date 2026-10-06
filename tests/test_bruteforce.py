"""Independent cross-check: enumerate a short timeline second by second.

The oracle in tzhelpers walks every UTC second and finds its segment by a
plain linear scan -- it shares no code with the library's mapping logic.
The library's results must agree with it for every single wall-clock second
of the enumerated window, across gaps, folds, cross-midnight transitions
and non-whole-hour offsets.
"""
import unittest

from timeline import (LocalInterval, convert_interval, local_to_instant)
from tzhelpers import (L, U, brute_candidates, brute_local_map, dst_table,
                       historical_table)


class PerSecondEnumerationTest(unittest.TestCase):
    def check_window(self, table, utc_lo, utc_hi):
        forward = brute_local_map(table.segments, utc_lo, utc_hi)
        local_lo = min(forward)
        local_hi = max(forward)
        checked = 0
        for local in range(local_lo, local_hi + 1):
            expected = forward.get(local, [])
            got = [c.instant for c in
                   local_to_instant(table, local, use_cache=False)]
            self.assertEqual(got, expected,
                             f"mismatch at local second {local}")
            checked += 1
        return checked

    def test_dst_table_second_by_second(self):
        table = dst_table()
        # a 4-day window around each transition
        n = self.check_window(table, U(2024, 3, 30, 12), U(2024, 4, 2, 12))
        self.assertGreater(n, 250_000)
        n = self.check_window(table, U(2024, 10, 26, 12), U(2024, 10, 29, 12))
        self.assertGreater(n, 250_000)

    def test_historical_table_second_by_second(self):
        table = historical_table()
        # window covering the cross-midnight +05:30 -> +05:45 transition
        # and the +05:45 -> +06:30 transition 30 minutes later
        n = self.check_window(table, U(2024, 6, 30, 12), U(2024, 7, 1, 12))
        self.assertGreater(n, 80_000)
        # window over the LMT -> +05:30 boundary (non-whole-hour offsets)
        n = self.check_window(table, U(2023, 12, 31, 12), U(2024, 1, 1, 12))
        self.assertGreater(n, 70_000)

    def test_cache_agrees_with_uncached(self):
        table = dst_table()
        for local in range(L(2024, 3, 31, 0, 0), L(2024, 3, 31, 3, 0)):
            cached = [c.instant for c in local_to_instant(table, local)]
            fresh = [c.instant for c in
                     local_to_instant(table, local, use_cache=False)]
            self.assertEqual(cached, fresh)


class IntervalEnumerationTest(unittest.TestCase):
    """The UTC union produced by convert_interval must equal the set of
    instants the per-second oracle collects for the same local interval."""

    def check_interval(self, table, interval):
        result = convert_interval(table.segments, interval)
        oracle = set()
        for local in range(interval.start, interval.end):
            oracle.update(brute_candidates(table.segments, local))
        union = set()
        for piece in result.pieces:
            union.update(range(piece.start, piece.end))
        self.assertEqual(union, oracle)
        # gap seconds must be exactly the local seconds with no candidate
        gap_seconds = set()
        for gap in result.gaps:
            gap_seconds.update(range(gap.start, gap.end))
        expected_gaps = {l for l in range(interval.start, interval.end)
                         if not brute_candidates(table.segments, l)}
        self.assertEqual(gap_seconds, expected_gaps)

    def test_interval_across_gap(self):
        table = dst_table()
        self.check_interval(table, LocalInterval(
            L(2024, 3, 31, 0, 15), L(2024, 3, 31, 3, 45)))

    def test_interval_across_fold(self):
        table = dst_table()
        self.check_interval(table, LocalInterval(
            L(2024, 10, 27, 0, 15), L(2024, 10, 27, 3, 45)))

    def test_interval_across_consecutive_transitions(self):
        table = historical_table()
        self.check_interval(table, LocalInterval(
            L(2024, 6, 30, 22, 0), L(2024, 7, 1, 3, 0)))


if __name__ == "__main__":
    unittest.main()
