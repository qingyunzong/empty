"""Torn tail vs mid-log corruption handling."""

import os
import unittest

from kvstore.errors import CorruptLogError

from helpers import TempDB


class TornTailTest(unittest.TestCase):
    def test_torn_tail_is_truncated(self):
        with TempDB() as db:
            eng = db.open()
            t = eng.begin()
            eng.put(t, "a", "1")
            eng.commit(t)
            good_len = len(db.wal_bytes())
            # crash in the middle of flushing t2's commit: torn append
            t2 = eng.begin()
            eng.put(t2, "b", "2")
            db.faults.arm_torn_append()
            from kvstore.errors import CrashError
            with self.assertRaises(CrashError):
                eng.commit(t2)
            del eng
            eng2 = db.open()
            self.assertEqual(eng2.dump(), {"a": "1"})
            self.assertEqual(len(db.wal_bytes()), good_len,
                             "torn tail must be truncated away")
            truncs = [e for e in eng2.trace if e["action"] == "truncate_tail"]
            self.assertTrue(truncs)


class MidCorruptionTest(unittest.TestCase):
    def test_mid_log_crc_corruption_is_reported_and_file_kept(self):
        with TempDB() as db:
            eng = db.open()
            for i in range(3):
                t = eng.begin()
                eng.put(t, f"k{i}", f"v{i}")
                eng.commit(t)
            before = db.wal_bytes()
            recs = sorted(eng.log.records)
            victim = recs[1]  # corrupt a record in the middle of the log
            off = victim - eng.log.base + 10
            data = bytearray(before)
            data[off] ^= 0xFF
            with open(os.path.join(db.dir, "wal.log"), "wb") as fh:
                fh.write(bytes(data))
            with self.assertRaises(CorruptLogError):
                db.open()
            after = db.wal_bytes()
            self.assertEqual(bytes(data), after,
                             "corrupted log file must be left untouched")


if __name__ == "__main__":
    unittest.main()
