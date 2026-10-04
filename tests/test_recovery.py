"""Recovery: crash during undo, checkpoint/commit interleaving, double
recovery, log prefix reclamation."""

import unittest

from kvstore.errors import CrashError
from kvstore.wal import CLR

from helpers import TempDB


class CrashDuringUndoTest(unittest.TestCase):
    def _seed_loser(self, db, n=3):
        eng = db.open()
        t = eng.begin()
        for i in range(n):
            eng.put(t, f"k{i}", f"v{i}")
        # a second txn commits, forcing the loser's log records to disk
        t0 = eng.begin()
        eng.put(t0, "committed", "yes")
        eng.commit(t0)
        del eng  # crash with an uncommitted txn holding n updates

    def test_crash_after_clrs_before_end_no_duplicate_undo(self):
        with TempDB() as db:
            self._seed_loser(db, 3)
            db.faults.arm("undo_complete")  # crash after CLRs, before END
            with self.assertRaises(CrashError):
                db.open()
            db.faults.disarm()
            eng = db.open()  # second recovery must finish the undo
            self.assertEqual(eng.dump(), {"committed": "yes"})
            clrs = [r for r in eng.log.records.values() if r.rtype == CLR]
            self.assertEqual(len(clrs), 3,
                             "already-compensated updates must not be "
                             "undone again after a crash during recovery")
            skips = [e for e in eng.trace if e["action"] == "skip_via_clr"]
            self.assertTrue(skips, "expected undoNextLSN chain to be used")

    def test_crash_mid_clr_flush_still_consistent(self):
        with TempDB() as db:
            self._seed_loser(db, 3)
            db.faults.arm("clr_flush", after=2)  # crash on 2nd CLR flush
            with self.assertRaises(CrashError):
                db.open()
            db.faults.disarm()
            eng = db.open()
            self.assertEqual(eng.dump(), {"committed": "yes"})

    def test_crash_during_runtime_abort(self):
        with TempDB() as db:
            eng = db.open()
            t = eng.begin()
            eng.put(t, "a", "1")
            eng.commit(t)
            t2 = eng.begin()
            eng.put(t2, "a", "2")
            eng.put(t2, "b", "3")
            db.faults.arm("clr_flush", after=1)
            with self.assertRaises(CrashError):
                eng.abort(t2)
            db.faults.disarm()
            eng2 = db.open()
            self.assertEqual(eng2.dump(), {"a": "1"})


class CheckpointInterleaveTest(unittest.TestCase):
    def test_checkpoint_while_txns_active_then_commit_and_crash(self):
        with TempDB() as db:
            eng = db.open()
            t0 = eng.begin()
            eng.put(t0, "old", "0")
            eng.commit(t0)
            t1 = eng.begin()
            eng.put(t1, "a", "1")
            t2 = eng.begin()
            eng.put(t2, "b", "2")
            eng.checkpoint()  # fuzzy: t1 and t2 stay active throughout
            eng.put(t1, "c", "3")  # writes allowed during/after checkpoint
            eng.commit(t1)
            del eng  # crash: t2 is a loser
            eng2 = db.open()
            self.assertEqual(eng2.dump(), {"old": "0", "a": "1", "c": "3"})

    def test_reclaim_keeps_log_needed_by_active_txn(self):
        with TempDB() as db:
            eng = db.open()
            t1 = eng.begin()
            eng.put(t1, "a", "1")
            eng.checkpoint()  # t1 active: prefix kept from t1.first_lsn
            eng.put(t1, "b", "2")
            del eng
            eng2 = db.open()
            self.assertEqual(eng2.dump(), {})  # t1 fully undone


class DoubleRecoveryTest(unittest.TestCase):
    def test_recover_twice_is_idempotent(self):
        with TempDB() as db:
            eng = db.open()
            t = eng.begin()
            eng.put(t, "a", "1")
            eng.commit(t)
            t2 = eng.begin()
            eng.put(t2, "b", "2")
            del eng
            eng1 = db.open()
            self.assertEqual(eng1.dump(), {"a": "1"})
            del eng1
            eng2 = db.open()  # second recovery: no losers, no new CLRs
            self.assertEqual(eng2.dump(), {"a": "1"})
            clrs = [e for e in eng2.trace if e["action"] == "clr"]
            self.assertEqual(clrs, [])


class LogReclaimTest(unittest.TestCase):
    def test_prefix_reclaimed_and_recovery_still_works(self):
        with TempDB() as db:
            eng = db.open()
            for i in range(5):
                t = eng.begin()
                eng.put(t, f"k{i}", f"v{i}")
                eng.commit(t)
            eng.checkpoint()  # no active txns: prefix up to checkpoint LSN
            self.assertGreater(eng.log.base, 0, "expected log reclamation")
            t = eng.begin()
            eng.put(t, "k0", "updated")
            eng.commit(t)
            t2 = eng.begin()
            eng.put(t2, "k1", "dirty")
            del eng  # crash after reclamation
            eng2 = db.open()
            expected = {f"k{i}": f"v{i}" for i in range(5)}
            expected["k0"] = "updated"
            self.assertEqual(eng2.dump(), expected)


if __name__ == "__main__":
    unittest.main()
