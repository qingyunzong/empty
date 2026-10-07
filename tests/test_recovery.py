"""Recovery, checkpoint, fault-injection and log-integrity tests."""

import unittest

from wal_kv import CrashError, Database, InMemoryFileAdapter, LogCorruptionError
from wal_kv.db import LockError
from wal_kv.logrec import scan_log


def make_db(num_pages=16):
    adapter = InMemoryFileAdapter()
    return adapter, Database(adapter, num_pages=num_pages)


def same_page_keys(db, count=2):
    """Find `count` keys that hash to the same page."""
    buckets = {}
    for i in range(500):
        key = f"key{i}"
        buckets.setdefault(db.page_for(key), []).append(key)
    for keys in buckets.values():
        if len(keys) >= count:
            return keys[:count]
    raise AssertionError("no colliding keys found")


class SamePageTxnTests(unittest.TestCase):
    def test_conflicting_key_write_is_rejected(self):
        adapter, db = make_db()
        db.begin("T1")
        db.begin("T2")
        db.put("T1", "hot", "1")
        with self.assertRaises(LockError):
            db.put("T2", "hot", "2")
        db.commit("T1")
        db.put("T2", "hot", "2")  # lock released after commit
        db.commit("T2")
        self.assertEqual(db.dump(), {"hot": "2"})

    def test_two_txns_same_page_one_commits_one_aborts(self):
        adapter, db = make_db()
        k1, k2 = same_page_keys(db)
        self.assertEqual(db.page_for(k1), db.page_for(k2))
        db.begin("T1")
        db.begin("T2")
        db.put("T1", k1, "committed")
        db.put("T2", k2, "aborted")
        db.commit("T1")
        db.abort("T2")
        self.assertEqual(db.dump(), {k1: "committed"})
        # Crash (losing nothing committed) and recover: same outcome.
        adapter.crash()
        db2 = Database(adapter)
        db2.recover()
        self.assertEqual(db2.dump(), {k1: "committed"})

    def test_uncommitted_same_page_change_undone_after_crash(self):
        adapter, db = make_db()
        k1, k2 = same_page_keys(db)
        db.begin("T1")
        db.begin("T2")
        db.put("T1", k1, "winner")
        db.put("T2", k2, "loser")
        db.commit("T1")  # forces the whole log, including T2's record
        adapter.crash()
        db2 = Database(adapter)
        db2.recover()
        self.assertEqual(db2.dump(), {k1: "winner"})
        actions = [t["action"] for t in db2.trace]
        self.assertIn("compensate", actions)


class CrashDuringUndoTests(unittest.TestCase):
    def test_crash_mid_undo_does_not_undo_twice(self):
        adapter, db = make_db()
        db.begin("T1")
        db.put("T1", "a", "1")
        db.put("T1", "b", "2")
        db.put("T1", "c", "3")
        adapter.sync_log()  # make the updates durable, then crash
        adapter.crash()

        # First recovery attempt crashes while writing the second CLR.
        adapter.arm("clr_write", at_call=2)
        db2 = Database(adapter)
        with self.assertRaises(CrashError):
            db2.recover()
        adapter.crash()

        # Second recovery must finish the undo exactly once.
        db3 = Database(adapter)
        db3.recover()
        self.assertEqual(db3.dump(), {})
        self.assertIn(
            "skip-clr",
            [t["action"] for t in db3.trace],
            "recovery must follow undoNextLSN past the durable CLR",
        )

    def test_crash_during_runtime_abort(self):
        adapter, db = make_db()
        db.begin("T1")
        db.put("T1", "x", "1")
        db.put("T1", "y", "2")
        adapter.arm("clr_write", at_call=1)
        with self.assertRaises(CrashError):
            db.abort("T1")
        adapter.crash()
        db2 = Database(adapter)
        db2.recover()
        self.assertEqual(db2.dump(), {})


class CheckpointTests(unittest.TestCase):
    def test_checkpoint_interleaved_with_commit(self):
        adapter, db = make_db()
        db.begin("T1")
        db.begin("T2")
        db.put("T1", "k1", "v1")
        db.put("T2", "k2", "v2")
        db.checkpoint()  # fuzzy: both txns still active
        db.commit("T1")
        db.put("T2", "k3", "v3")
        adapter.sync_log()
        adapter.crash()
        db2 = Database(adapter)
        db2.recover()
        self.assertEqual(db2.dump(), {"k1": "v1"})
        phases = {t["phase"] for t in db2.trace}
        self.assertIn("analysis", phases)
        self.assertIn("undo", phases)

    def test_log_recycled_after_checkpoint_and_recovery_still_works(self):
        adapter, db = make_db()
        db.begin("T1")
        db.put("T1", "old", "value")
        db.commit("T1")
        db.checkpoint()  # flushes dirty pages
        db.checkpoint()  # clean DPT + no active txns: prefix recycled
        # Prefix below the checkpoint must be gone.
        records, _ = scan_log(adapter.read_log())
        self.assertGreater(records[0]["lsn"], 1)
        self.assertEqual(records[0]["type"], "begin_ckpt")
        # More history after the checkpoint, then crash and recover.
        db.begin("T2")
        db.put("T2", "new", "value2")
        db.commit("T2")
        adapter.crash()
        db2 = Database(adapter)
        db2.recover()
        self.assertEqual(db2.dump(), {"old": "value", "new": "value2"})

    def test_recycle_keeps_log_needed_by_active_txn(self):
        adapter, db = make_db()
        db.begin("T1")
        db.put("T1", "k", "v")
        db.checkpoint()  # T1 active: its first LSN bounds recycling
        records, _ = scan_log(adapter.read_log())
        types = [r["type"] for r in records]
        self.assertIn("update", types)  # T1's update retained for undo
        db.abort("T1")
        self.assertEqual(db.dump(), {})


class DoubleRecoverTests(unittest.TestCase):
    def test_two_consecutive_recovers_are_idempotent(self):
        adapter, db = make_db()
        db.begin("T1")
        db.put("T1", "a", "1")
        db.commit("T1")
        db.begin("T2")
        db.put("T2", "b", "2")
        adapter.sync_log()
        adapter.crash()
        db2 = Database(adapter)
        db2.recover()
        first = db2.dump()
        db3 = Database(adapter)
        db3.recover()
        second = db3.dump()
        self.assertEqual(first, {"a": "1"})
        self.assertEqual(first, second)


class LogIntegrityTests(unittest.TestCase):
    def test_incomplete_tail_record_is_truncated(self):
        adapter, db = make_db()
        db.begin("T1")
        db.put("T1", "a", "1")
        db.commit("T1")
        durable = adapter.read_log()
        # Simulate a torn write: partial frame appended to the durable log.
        adapter.rewrite_log(durable + b"\x20\x00\x00\x00partial-payload")
        db2 = Database(adapter)
        db2.recover()
        self.assertEqual(db2.dump(), {"a": "1"})
        self.assertEqual(adapter.read_log(), durable)
        self.assertIn("truncate-tail", [t["action"] for t in db2.trace])

    def test_mid_log_corruption_reported_and_file_preserved(self):
        adapter, db = make_db()
        db.begin("T1")
        db.put("T1", "a", "1")
        db.put("T1", "b", "2")
        db.commit("T1")
        durable = bytearray(adapter.read_log())
        # Corrupt a payload byte of the first record (valid frames follow).
        durable[10] ^= 0xFF
        adapter.rewrite_log(bytes(durable))
        db2 = Database(adapter)
        with self.assertRaises(LogCorruptionError):
            db2.recover()
        self.assertEqual(adapter.read_log(), bytes(durable))


class FaultInjectionBoundaryTests(unittest.TestCase):
    def _scenario(self, boundary, at_call, expected):
        adapter, db = make_db()
        db.begin("T1")
        db.put("T1", "a", "1")
        db.commit("T1")
        db.begin("T2")
        adapter.arm(boundary, at_call=at_call)
        crashed = False
        try:
            if boundary in ("clr_write",):
                db.put("T2", "b", "2")
                adapter.sync_log()
                db.abort("T2")
            elif boundary == "ckpt_publish":
                db.put("T2", "b", "2")
                db.checkpoint()
            elif boundary == "page_write":
                db.put("T2", "b", "2")
                db.flush_all()
            elif boundary == "log_sync":
                db.put("T2", "b", "2")
                db.commit("T2")
            else:  # log_write
                db.put("T2", "b", "2")
        except CrashError:
            crashed = True
        self.assertTrue(crashed, f"no crash injected at {boundary}")
        adapter.crash()
        db2 = Database(adapter)
        db2.recover()
        self.assertEqual(db2.dump(), expected)

    def test_crash_at_log_write_boundary(self):
        self._scenario("log_write", 3, {"a": "1"})  # T2's second put lost

    def test_crash_at_log_sync_boundary(self):
        self._scenario("log_sync", 2, {"a": "1"})  # T2 commit not durable

    def test_crash_at_page_write_boundary(self):
        self._scenario("page_write", 1, {"a": "1"})  # flush fails, redo fixes

    def test_crash_at_clr_write_boundary(self):
        self._scenario("clr_write", 1, {"a": "1"})  # abort interrupted

    def test_crash_at_checkpoint_publish_boundary(self):
        self._scenario("ckpt_publish", 1, {"a": "1"})  # end_ckpt not published


if __name__ == "__main__":
    unittest.main()
