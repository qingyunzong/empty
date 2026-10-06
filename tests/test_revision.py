import unittest

from timeline import OffsetTable, Segment, local_to_instant
from tzhelpers import L, U, dst_table


def revised_summer_table():
    """Revision: shift the autumn transition one hour later and make the
    summer offset +02:30 (non-whole-hour) instead of +01:00."""
    a = U(2024, 3, 31, 1)
    b2 = U(2024, 10, 27, 2)   # one hour later than before
    return [
        Segment("summer-v2", a, b2, 9000),
        Segment("winter-after-v2", b2, None, 0),
    ]


def bounded_summer_revision():
    """Bounded revision: only the summer segment [a, b) changes offset."""
    a = U(2024, 3, 31, 1)
    b = U(2024, 10, 27, 1)
    return [Segment("summer-v2", a, b, 9000)]


class AtomicRejectTest(unittest.TestCase):
    def setUp(self):
        self.table = dst_table()
        self.local = L(2024, 7, 1, 12, 0)
        self.before = local_to_instant(self.table, self.local)

    def test_overlapping_revision_segments_rejected_atomically(self):
        a = U(2024, 3, 31, 1)
        bad = [
            Segment("x", a, U(2024, 9, 1), 3600),
            Segment("y", U(2024, 8, 1), None, 0),  # overlaps x
        ]
        version = self.table.version
        cache_keys = self.table.cache.keys()
        with self.assertRaises(ValueError):
            self.table.revise(bad)
        # nothing changed: version, segments, cache, and answers
        self.assertEqual(self.table.version, version)
        self.assertEqual(self.table.cache.keys(), cache_keys)
        self.assertEqual([s.seg_id for s in self.table.segments],
                         ["winter-before", "summer", "winter-after"])
        self.assertEqual(local_to_instant(self.table, self.local), self.before)

    def test_gapped_revision_rejected_atomically(self):
        a = U(2024, 3, 31, 1)
        bad = [
            Segment("x", a, U(2024, 9, 1), 3600),
            Segment("y", U(2024, 9, 2), None, 0),  # one-day gap
        ]
        with self.assertRaises(ValueError):
            self.table.revise(bad)
        self.assertEqual(self.table.version, 1)

    def test_revision_cutting_existing_segment_rejected(self):
        # span does not align with existing boundaries
        bad = [Segment("x", U(2024, 5, 1), U(2024, 6, 1), 3600)]
        with self.assertRaises(ValueError):
            self.table.revise(bad)
        self.assertEqual(self.table.version, 1)

    def test_overlapping_initial_table_rejected(self):
        with self.assertRaises(ValueError):
            OffsetTable([
                Segment("a", None, U(2024, 6, 1), 0),
                Segment("b", U(2024, 5, 1), None, 3600),
            ])


class IncrementalRevisionTest(unittest.TestCase):
    def test_revision_recomputes_only_affected_cache(self):
        table = dst_table()
        # warm the cache: one local far before the changed span, one inside
        unaffected_local = L(2024, 1, 15, 12, 0)
        affected_local = L(2024, 7, 1, 12, 0)
        local_to_instant(table, unaffected_local)
        local_to_instant(table, affected_local)
        self.assertEqual(table.cache.keys(), {unaffected_local, affected_local})

        table.revise(bounded_summer_revision())
        self.assertEqual(table.version, 2)
        # incremental invalidation: the far-away entry survives, the entry
        # inside the affected wall-clock range is dropped
        self.assertEqual(table.cache.keys(), {unaffected_local})

        # mapping under the new table reflects the new +02:30 offset
        cands = local_to_instant(table, affected_local)
        self.assertEqual(cands[0].segment.seg_id, "summer-v2")
        self.assertEqual(cands[0].instant, U(2024, 7, 1, 9, 30))

    def test_revision_changes_fold_position(self):
        table = dst_table()
        table.revise(revised_summer_table())
        # fold now happens at 02:00Z with a 2.5h backward jump:
        # local [02:00, 04:30) on 2024-10-27 happens twice
        cands = local_to_instant(table, L(2024, 10, 27, 3, 0, 0))
        self.assertEqual(len(cands), 2)
        self.assertEqual([c.segment.seg_id for c in cands],
                         ["summer-v2", "winter-after-v2"])
        self.assertEqual(cands[1].instant - cands[0].instant, 9000)


class SnapshotTest(unittest.TestCase):
    def test_snapshot_keeps_old_interpretation(self):
        table = dst_table()
        snapshot = table.snapshot()
        local = L(2024, 7, 1, 12, 0)
        old_answer = local_to_instant(snapshot, local)

        table.revise(revised_summer_table())
        new_answer = local_to_instant(table, local)

        # same wall clock, different tables -> different instants
        self.assertNotEqual(old_answer[0].instant, new_answer[0].instant)
        # the snapshot still answers with the old table
        again = local_to_instant(snapshot, local)
        self.assertEqual(again[0].instant, old_answer[0].instant)
        self.assertEqual(again[0].segment.seg_id, "summer")
        self.assertEqual(snapshot.version, 1)
        self.assertEqual(table.version, 2)

    def test_snapshot_is_immutable(self):
        table = dst_table()
        snapshot = table.snapshot()
        with self.assertRaises(AttributeError):
            snapshot.revise(revised_summer_table())


class RecoveryTest(unittest.TestCase):
    def test_table_roundtrip_through_json(self):
        table = dst_table()
        table.revise(revised_summer_table())
        restored = OffsetTable.from_json(table.to_json())
        self.assertEqual(restored.version, table.version)
        for local in (L(2024, 3, 31, 1, 30), L(2024, 7, 1, 12, 0),
                      L(2024, 10, 27, 1, 0)):
            self.assertEqual(local_to_instant(restored, local),
                             local_to_instant(table, local))

    def test_cache_recovery_after_loss(self):
        # warm the cache and record answers as the recovery baseline
        table = dst_table()
        locals_ = [L(2024, 3, 31, 0, 30), L(2024, 3, 31, 1, 30),
                   L(2024, 7, 1, 12, 0), L(2024, 10, 27, 1, 30)]
        baseline = {l: local_to_instant(table, l) for l in locals_}
        self.assertGreater(len(table.cache.keys()), 0)
        # simulate a crash: the cache is lost entirely
        table.cache._store.clear()
        # recovery: answers are recomputed from the table and must be
        # identical to the cached baseline
        for l in locals_:
            self.assertEqual(local_to_instant(table, l), baseline[l])
        self.assertEqual(table.cache.keys(), set(locals_))

    def test_evidence_verifies_after_recovery(self):
        from timeline import verify_candidate
        table = dst_table()
        restored = OffsetTable.from_json(table.to_json())
        local = L(2024, 10, 27, 1, 30)
        for cand in local_to_instant(table, local):
            # evidence produced by the original table verifies against the
            # recovered one
            self.assertTrue(verify_candidate(restored, local, cand.evidence()))


if __name__ == "__main__":
    unittest.main()
