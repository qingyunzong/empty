import unittest

from timeaxis import LocalDateTime, TableError, Timeline, TransitionTable

TABLE_V1 = [
    {"utc_start": None, "offset": "+01:00"},
    {"utc_start": "2024-03-31T01:00:00Z", "offset": "+02:00"},
    {"utc_start": "2024-10-27T01:00:00Z", "offset": "+01:00"},
]

# Revision: the summer offset becomes +02:30 instead of +02:00.
TABLE_V2 = [
    {"utc_start": None, "offset": "+01:00"},
    {"utc_start": "2024-03-31T01:00:00Z", "offset": "+02:30"},
    {"utc_start": "2024-10-27T01:00:00Z", "offset": "+01:00"},
]

# Illegal revision: the middle segment overlaps its successor.
TABLE_BAD = [
    {"utc_start": None, "offset": "+01:00"},
    {"utc_start": "2024-03-31T01:00:00Z",
     "utc_end": "2024-11-01T00:00:00Z", "offset": "+02:00"},
    {"utc_start": "2024-10-27T01:00:00Z", "offset": "+01:00"},
]


def local(text):
    return LocalDateTime.from_iso(text)


class RevisionTest(unittest.TestCase):
    def setUp(self):
        self.timeline = Timeline(TransitionTable.from_spec(TABLE_V1))

    def test_incremental_revision_recomputes_only_affected_cache(self):
        affected = local("2024-06-01T12:00:00")   # inside the revised segment
        unaffected = local("2024-01-15T12:00:00")  # segment 0, unchanged
        before_affected = self.timeline.local_to_instant(affected)
        before_unaffected = self.timeline.local_to_instant(unaffected)
        self.assertEqual(len(self.timeline.cache_keys()), 2)

        self.timeline.revise(TABLE_V2)

        # Unaffected entry survives; affected entry was evicted.
        self.assertEqual(len(self.timeline.cache_keys()), 1)
        after_unaffected = self.timeline.local_to_instant(unaffected)
        self.assertEqual(
            [c.instant for c in after_unaffected],
            [c.instant for c in before_unaffected])
        # Affected mapping is recomputed under the new offset.
        after_affected = self.timeline.local_to_instant(affected)
        self.assertNotEqual(
            [c.instant for c in after_affected],
            [c.instant for c in before_affected])
        self.assertEqual(after_affected[0].instant.to_iso(),
                         "2024-06-01T09:30:00Z")

    def test_snapshot_keeps_old_table_interpretation(self):
        snapshot = self.timeline.snapshot()
        self.timeline.revise(TABLE_V2)
        reading = local("2024-06-01T12:00:00")
        old_view = snapshot.local_to_instant(reading)
        new_view = self.timeline.local_to_instant(reading)
        self.assertEqual(old_view[0].instant.to_iso(), "2024-06-01T10:00:00Z")
        self.assertEqual(new_view[0].instant.to_iso(), "2024-06-01T09:30:00Z")
        self.assertEqual(snapshot.revision, 0)
        self.assertEqual(self.timeline.revision, 1)

    def test_illegal_revision_rejected_atomically(self):
        self.timeline.local_to_instant(local("2024-06-01T12:00:00"))
        cache_before = self.timeline.cache_keys()
        table_before = self.timeline.table
        with self.assertRaises(TableError):
            self.timeline.revise(TABLE_BAD)
        # Nothing changed: same table object, same revision, same cache.
        self.assertIs(self.timeline.table, table_before)
        self.assertEqual(self.timeline.revision, 0)
        self.assertEqual(self.timeline.cache_keys(), cache_before)

    def test_timeline_recovers_after_failed_revision(self):
        with self.assertRaises(TableError):
            self.timeline.revise(TABLE_BAD)
        # The timeline is still fully functional afterwards.
        candidates = self.timeline.local_to_instant(local("2024-10-27T02:30:00"))
        self.assertEqual(len(candidates), 2)
        # And a valid revision still applies cleanly.
        self.timeline.revise(TABLE_V2)
        self.assertEqual(self.timeline.revision, 1)

    def test_recovery_via_json_roundtrip(self):
        table = TransitionTable.from_spec(TABLE_V2)
        restored = TransitionTable.from_json(table.to_json())
        self.assertEqual(restored.evidence(), table.evidence())
        reading = local("2024-06-01T12:00:00")
        self.assertEqual(
            [c.instant for c in restored.local_to_instant(reading)],
            [c.instant for c in table.local_to_instant(reading)])


if __name__ == "__main__":
    unittest.main()
