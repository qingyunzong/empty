import unittest

from timeaxis import LocalDateTime, TransitionTable

TABLE_A = [
    {"utc_start": None, "offset": "+01:00"},
    {"utc_start": "2024-03-31T01:00:00Z", "offset": "+02:00"},
    {"utc_start": "2024-10-27T01:00:00Z", "offset": "+01:00"},
]

TABLE_B = [
    {"utc_start": None, "offset": "+05:45"},
    {"utc_start": "2024-01-01T18:30:00Z", "offset": "+06:15"},
    {"utc_start": "2024-01-02T23:15:00Z", "offset": "+05:30"},
    {"utc_start": "2024-01-03T00:00:00Z", "offset": "+06:00"},
]


def local(text):
    return LocalDateTime.from_iso(text)


class IntervalConversionTest(unittest.TestCase):
    def setUp(self):
        self.table = TransitionTable.from_spec(TABLE_A)

    def test_interval_inside_one_segment(self):
        pieces = self.table.local_interval_to_utc(
            local("2024-03-30T10:00:00"), local("2024-03-30T12:00:00"))
        self.assertEqual(len(pieces), 1)
        self.assertEqual(pieces[0].start.to_iso(), "2024-03-30T09:00:00Z")
        self.assertEqual(pieces[0].end.to_iso(), "2024-03-30T11:00:00Z")
        self.assertTrue(pieces[0].start_closed)
        self.assertFalse(pieces[0].end_closed)
        self.assertEqual(pieces[0].segment.index, 0)

    def test_interval_spanning_gap_splits_into_union(self):
        pieces = self.table.local_interval_to_utc(
            local("2024-03-31T01:00:00"), local("2024-03-31T04:00:00"))
        self.assertEqual(len(pieces), 2)
        self.assertEqual(pieces[0].start.to_iso(), "2024-03-31T00:00:00Z")
        self.assertEqual(pieces[0].end.to_iso(), "2024-03-31T01:00:00Z")
        self.assertEqual(pieces[0].segment.index, 0)
        self.assertEqual(pieces[1].start.to_iso(), "2024-03-31T01:00:00Z")
        self.assertEqual(pieces[1].end.to_iso(), "2024-03-31T02:00:00Z")
        self.assertEqual(pieces[1].segment.index, 1)

    def test_interval_spanning_fold_keeps_duplicate_sources(self):
        pieces = self.table.local_interval_to_utc(
            local("2024-10-27T02:30:00"), local("2024-10-27T04:00:00"))
        self.assertEqual(len(pieces), 2)
        # Same wall-clock range, two disjoint UTC pieces, sources preserved.
        self.assertEqual(pieces[0].segment.index, 1)
        self.assertEqual(pieces[0].start.to_iso(), "2024-10-27T00:30:00Z")
        self.assertEqual(pieces[0].end.to_iso(), "2024-10-27T01:00:00Z")
        self.assertEqual(pieces[1].segment.index, 2)
        self.assertEqual(pieces[1].start.to_iso(), "2024-10-27T01:30:00Z")
        self.assertEqual(pieces[1].end.to_iso(), "2024-10-27T03:00:00Z")

    def test_endpoint_on_transition_start_closed(self):
        # Start exactly at the first valid reading after the gap.
        pieces = self.table.local_interval_to_utc(
            local("2024-03-31T03:00:00"), local("2024-03-31T05:00:00"))
        self.assertEqual(len(pieces), 1)
        self.assertTrue(pieces[0].start_closed)
        self.assertEqual(pieces[0].start.to_iso(), "2024-03-31T01:00:00Z")

    def test_endpoint_on_transition_end_forced_open(self):
        # End exactly at the last missing reading boundary: the segment's
        # local end is exclusive, so a closed query end still yields open.
        pieces = self.table.local_interval_to_utc(
            local("2024-03-31T00:00:00"), local("2024-03-31T02:00:00"),
            start_closed=True, end_closed=True)
        self.assertEqual(len(pieces), 1)
        self.assertEqual(pieces[0].end.to_iso(), "2024-03-31T01:00:00Z")
        self.assertFalse(pieces[0].end_closed)

    def test_open_start_bound_preserved(self):
        pieces = self.table.local_interval_to_utc(
            local("2024-03-30T10:00:00"), local("2024-03-30T12:00:00"),
            start_closed=False, end_closed=True)
        self.assertFalse(pieces[0].start_closed)
        self.assertTrue(pieces[0].end_closed)

    def test_empty_interval_rejected(self):
        with self.assertRaises(ValueError):
            self.table.local_interval_to_utc(
                local("2024-03-30T12:00:00"), local("2024-03-30T10:00:00"))

    def test_cross_midnight_transition(self):
        table = TransitionTable.from_spec(TABLE_B)
        pieces = table.local_interval_to_utc(
            local("2024-01-01T23:00:00"), local("2024-01-02T02:00:00"))
        self.assertEqual(len(pieces), 2)
        # Segment 0 covers local up to 2024-01-02T00:15 (midnight crossed).
        self.assertEqual(pieces[0].segment.index, 0)
        self.assertEqual(pieces[0].start.to_iso(), "2024-01-01T17:15:00Z")
        self.assertEqual(pieces[0].end.to_iso(), "2024-01-01T18:30:00Z")
        # Gap [00:15, 00:45) skipped; segment 1 resumes after midnight.
        self.assertEqual(pieces[1].segment.index, 1)
        self.assertEqual(pieces[1].start.to_iso(), "2024-01-01T18:30:00Z")
        self.assertEqual(pieces[1].end.to_iso(), "2024-01-01T19:45:00Z")


class EvidenceTest(unittest.TestCase):
    def test_evidence_reports_segmented_mapping(self):
        table = TransitionTable.from_spec(TABLE_A)
        evidence = table.evidence()
        self.assertEqual(len(evidence), 3)
        self.assertIsNone(evidence[0]["utc_start"])
        self.assertEqual(evidence[0]["utc_end"], "2024-03-31T01:00:00Z")
        self.assertEqual(evidence[0]["local_end"], "2024-03-31T02:00:00")
        self.assertEqual(evidence[1]["local_start"], "2024-03-31T03:00:00")
        self.assertEqual(evidence[1]["offset"], "+02:00")
        self.assertEqual(evidence[2]["offset_seconds"], 3600)


if __name__ == "__main__":
    unittest.main()
