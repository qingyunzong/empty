import unittest

from timeaxis import (
    Instant,
    LocalDateTime,
    TableError,
    TransitionTable,
    format_offset,
    parse_offset,
)

# Table A: classic spring-forward gap / autumn-back fold, whole hours.
TABLE_A = [
    {"utc_start": None, "offset": "+01:00"},
    {"utc_start": "2024-03-31T01:00:00Z", "offset": "+02:00"},
    {"utc_start": "2024-10-27T01:00:00Z", "offset": "+01:00"},
]

# Table B: historical-style non-whole-hour offsets, consecutive changes,
# one of them crossing local midnight.
TABLE_B = [
    {"utc_start": None, "offset": "+05:45"},
    {"utc_start": "2024-01-01T18:30:00Z", "offset": "+06:15"},
    {"utc_start": "2024-01-02T23:15:00Z", "offset": "+05:30"},
    {"utc_start": "2024-01-03T00:00:00Z", "offset": "+06:00"},
]


def local(text):
    return LocalDateTime.from_iso(text)


class OffsetParsingTest(unittest.TestCase):
    def test_non_whole_hour_offsets(self):
        self.assertEqual(parse_offset("+05:45"), 5 * 3600 + 45 * 60)
        self.assertEqual(parse_offset("-03:30"), -(3 * 3600 + 30 * 60))
        self.assertEqual(parse_offset("+08:45:52"), 8 * 3600 + 45 * 60 + 52)
        self.assertEqual(parse_offset(3600), 3600)

    def test_format_roundtrip(self):
        for text in ("+05:45", "-03:30", "+00:00", "+08:45:52"):
            self.assertEqual(format_offset(parse_offset(text)), text)

    def test_invalid_offset(self):
        with self.assertRaises(TableError):
            parse_offset("+5:99")
        with self.assertRaises(TableError):
            parse_offset("soon")


class LocalToInstantTest(unittest.TestCase):
    def setUp(self):
        self.table = TransitionTable.from_spec(TABLE_A)

    def test_gap_returns_zero_candidates(self):
        candidates = self.table.local_to_instant(local("2024-03-31T02:30:00"))
        self.assertEqual(candidates, [])

    def test_fold_returns_two_candidates_with_segments(self):
        candidates = self.table.local_to_instant(local("2024-10-27T02:30:00"))
        self.assertEqual(len(candidates), 2)
        self.assertEqual(candidates[0].instant.to_iso(), "2024-10-27T00:30:00Z")
        self.assertEqual(candidates[0].segment.index, 1)
        self.assertEqual(candidates[1].instant.to_iso(), "2024-10-27T01:30:00Z")
        self.assertEqual(candidates[1].segment.index, 2)

    def test_same_wall_clock_candidates_sorted_chronologically(self):
        candidates = self.table.local_to_instant(local("2024-10-27T02:00:00"))
        self.assertEqual(len(candidates), 2)
        epochs = [c.instant.epoch_seconds for c in candidates]
        self.assertEqual(epochs, sorted(epochs))
        self.assertLess(candidates[0].instant.epoch_seconds,
                        candidates[1].instant.epoch_seconds)

    def test_normal_time_returns_one_candidate(self):
        candidates = self.table.local_to_instant(local("2024-03-31T01:59:59"))
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0].instant.to_iso(), "2024-03-31T00:59:59Z")
        self.assertEqual(candidates[0].segment.index, 0)

    def test_gap_edges(self):
        # 02:00:00 is the first missing reading; 03:00:00 exists again.
        self.assertEqual(self.table.local_to_instant(local("2024-03-31T02:00:00")), [])
        self.assertEqual(self.table.local_to_instant(local("2024-03-31T02:59:59")), [])
        self.assertEqual(
            len(self.table.local_to_instant(local("2024-03-31T03:00:00"))), 1)


class NonWholeHourTest(unittest.TestCase):
    def setUp(self):
        self.table = TransitionTable.from_spec(TABLE_B)

    def test_instant_to_local_crosses_midnight(self):
        # UTC 2024-01-01T19:00:00Z with +06:15 -> next local day 01:15.
        local_dt = self.table.instant_to_local(Instant.from_iso("2024-01-01T19:00:00Z"))
        self.assertEqual(local_dt.to_iso(), "2024-01-02T01:15:00")

    def test_local_to_instant_non_whole_hour(self):
        candidates = self.table.local_to_instant(local("2024-01-01T12:00:00"))
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0].instant.to_iso(), "2024-01-01T06:15:00Z")

    def test_consecutive_offset_changes(self):
        # S1 -> S2 is a 45-minute backward jump: local [04:45, 05:30) repeats.
        candidates = self.table.local_to_instant(local("2024-01-03T05:00:00"))
        self.assertEqual(len(candidates), 2)
        self.assertEqual(candidates[0].instant.to_iso(), "2024-01-02T22:45:00Z")
        self.assertEqual(candidates[1].instant.to_iso(), "2024-01-02T23:30:00Z")
        # S2 -> S3 is a 30-minute forward jump: local [05:30, 06:00) missing.
        self.assertEqual(self.table.local_to_instant(local("2024-01-03T05:45:00")), [])
        self.assertEqual(
            len(self.table.local_to_instant(local("2024-01-03T06:00:00"))), 1)


class TableValidationTest(unittest.TestCase):
    def test_overlapping_explicit_ends_rejected(self):
        with self.assertRaises(TableError):
            TransitionTable.from_spec([
                {"utc_start": None, "utc_end": "2024-06-01T00:00:00Z", "offset": "+01:00"},
                {"utc_start": "2024-05-01T00:00:00Z", "offset": "+02:00"},
            ])

    def test_non_increasing_starts_rejected(self):
        with self.assertRaises(TableError):
            TransitionTable.from_spec([
                {"utc_start": "2024-05-01T00:00:00Z", "offset": "+01:00"},
                {"utc_start": "2024-05-01T00:00:00Z", "offset": "+02:00"},
            ])

    def test_end_before_start_rejected(self):
        with self.assertRaises(TableError):
            TransitionTable.from_spec([
                {"utc_start": "2024-05-01T00:00:00Z",
                 "utc_end": "2024-04-01T00:00:00Z", "offset": "+01:00"},
            ])

    def test_empty_and_missing_offset_rejected(self):
        with self.assertRaises(TableError):
            TransitionTable.from_spec([])
        with self.assertRaises(TableError):
            TransitionTable.from_spec([{"utc_start": None}])

    def test_open_start_only_on_first_segment(self):
        with self.assertRaises(TableError):
            TransitionTable.from_spec([
                {"utc_start": "2024-01-01T00:00:00Z", "offset": "+01:00"},
                {"utc_start": None, "offset": "+02:00"},
            ])


if __name__ == "__main__":
    unittest.main()
