"""Independent cross-check: enumerate a short timeline second by second.

The enumeration below derives every expectation by brute force (walk each
UTC second, add the segment offset) and is deliberately independent of the
library's local->instant logic, so the two implementations check each other.
"""
import unittest
from datetime import datetime, timedelta

from timeaxis import Instant, LocalDateTime, TransitionTable

# Gap, then fold with a non-whole-hour offset, then another gap:
# consecutive offset changes within a single local day.
TABLE_C = [
    {"utc_start": None, "offset": "+01:00"},
    {"utc_start": "2024-03-31T00:00:00Z", "offset": "+02:00"},
    {"utc_start": "2024-03-31T02:00:00Z", "offset": "+00:45"},
    {"utc_start": "2024-03-31T05:30:00Z", "offset": "+01:30"},
]

WINDOW_START = "2024-03-30T22:00:00Z"
WINDOW_END = "2024-03-31T08:00:00Z"


def local_of_epoch(epoch):
    return LocalDateTime(datetime(1970, 1, 1) + timedelta(seconds=epoch))


class EnumerationCrossCheckTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.table = TransitionTable.from_spec(TABLE_C)
        cls.win_start = Instant.from_iso(WINDOW_START).epoch_seconds
        cls.win_end = Instant.from_iso(WINDOW_END).epoch_seconds
        # Brute-force inverse map: local epoch -> [(utc epoch, segment index)]
        cls.inverse = {}
        cls.forward = {}
        for utc_epoch in range(cls.win_start, cls.win_end):
            seg = cls.table.segment_at(Instant(utc_epoch))
            local_epoch = utc_epoch + seg.offset
            cls.forward[utc_epoch] = (local_epoch, seg.index)
            cls.inverse.setdefault(local_epoch, []).append((utc_epoch, seg.index))

    def test_local_to_instant_matches_enumeration(self):
        checked = 0
        for local_epoch, expected in self.inverse.items():
            candidates = self.table.local_to_instant(local_of_epoch(local_epoch))
            got = [(c.instant.epoch_seconds, c.segment.index) for c in candidates]
            if all(self.win_start <= u < self.win_end for u, _ in got):
                self.assertEqual(sorted(got), sorted(expected),
                                 f"local epoch {local_epoch}")
                checked += 1
        self.assertGreater(checked, 30000)

    def test_instant_to_local_matches_enumeration(self):
        for utc_epoch, (local_epoch, _seg) in self.forward.items():
            result = self.table.instant_to_local(Instant(utc_epoch))
            expected = datetime(1970, 1, 1) + timedelta(seconds=local_epoch)
            self.assertEqual(result.dt, expected)

    def test_gap_seconds_have_no_candidates(self):
        # Forward jumps: local [01:00, 02:00) and [06:15, 07:00) missing.
        for start_text, end_text in (
            ("2024-03-31T01:00:00", "2024-03-31T02:00:00"),
            ("2024-03-31T06:15:00", "2024-03-31T07:00:00"),
        ):
            start = LocalDateTime.from_iso(start_text)
            end = LocalDateTime.from_iso(end_text)
            epoch = int((start.dt - datetime(1970, 1, 1)).total_seconds())
            stop = int((end.dt - datetime(1970, 1, 1)).total_seconds())
            while epoch < stop:
                self.assertNotIn(epoch, self.inverse)
                self.assertEqual(
                    self.table.local_to_instant(local_of_epoch(epoch)), [])
                epoch += 1

    def test_fold_seconds_have_two_sorted_candidates(self):
        # Backward jump: local [02:45, 04:00) happens twice.
        start = LocalDateTime.from_iso("2024-03-31T02:45:00")
        stop = LocalDateTime.from_iso("2024-03-31T04:00:00")
        epoch = int((start.dt - datetime(1970, 1, 1)).total_seconds())
        end = int((stop.dt - datetime(1970, 1, 1)).total_seconds())
        while epoch < end:
            candidates = self.table.local_to_instant(local_of_epoch(epoch))
            self.assertEqual(len(candidates), 2)
            self.assertLess(candidates[0].instant.epoch_seconds,
                            candidates[1].instant.epoch_seconds)
            self.assertEqual(len(self.inverse[epoch]), 2)
            epoch += 1

    def test_interval_union_matches_enumeration(self):
        start = LocalDateTime.from_iso("2024-03-31T00:30:00")
        end = LocalDateTime.from_iso("2024-03-31T08:30:00")
        start_epoch = int((start.dt - datetime(1970, 1, 1)).total_seconds())
        end_epoch = int((end.dt - datetime(1970, 1, 1)).total_seconds())
        expected = {u for u, (l, _s) in self.forward.items()
                    if start_epoch <= l < end_epoch}
        pieces = self.table.local_interval_to_utc(start, end)
        got = set()
        for piece in pieces:
            self.assertTrue(piece.start_closed)
            self.assertFalse(piece.end_closed)
            got.update(range(piece.start.epoch_seconds, piece.end.epoch_seconds))
        self.assertEqual(got, expected)
        # The fold makes one local hour appear in two segments.
        self.assertEqual(len(pieces), 4)
        self.assertEqual([p.segment.index for p in pieces], [0, 1, 2, 3])

    def test_evidence_consistent_with_enumeration(self):
        evidence = {row["index"]: row for row in self.table.evidence()}
        for utc_epoch, (local_epoch, seg_index) in self.forward.items():
            row = evidence[seg_index]
            offset = local_epoch - utc_epoch
            self.assertEqual(offset, row["offset_seconds"])
            if row["local_start"] is not None:
                self.assertGreaterEqual(
                    local_epoch,
                    int((datetime.fromisoformat(row["local_start"])
                         - datetime(1970, 1, 1)).total_seconds()))
            if row["local_end"] is not None:
                self.assertLess(
                    local_epoch,
                    int((datetime.fromisoformat(row["local_end"])
                         - datetime(1970, 1, 1)).total_seconds()))


if __name__ == "__main__":
    unittest.main()
