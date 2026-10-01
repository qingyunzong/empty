import os
import tempfile
import unittest

from msdeliv.engine import STALE, DeliveryEngine
from msdeliv.frames import message_frames
from msdeliv.log import DurableLog
from msdeliv.receiver import ACCEPTED, CONFLICT, OLD


class EngineCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.log_path = os.path.join(self.dir.name, "engine.jsonl")

    def tearDown(self):
        self.dir.cleanup()

    def engine(self, mod=16, window=4, capacity=None):
        eng = DeliveryEngine(mod=mod, window=window, capacity=capacity,
                             log=DurableLog(self.log_path))
        self.addCleanup(eng.log.close)
        return eng

    def recover(self):
        eng = DeliveryEngine.recover(self.log_path)
        self.addCleanup(eng.log.close)
        return eng


class TestPersistence(EngineCase):
    def test_crash_after_ack_before_delivery_commit(self):
        eng = self.engine()
        (m0,) = message_frames("s", 0, 0, "zero")
        (m1,) = message_frames("s", 0, 1, "one")
        self.assertEqual(eng.offer(m0)["status"], ACCEPTED)  # acked, durable
        self.assertEqual(eng.offer(m1)["status"], ACCEPTED)
        eng.log.close()  # crash: no poll(), no delivered commit

        rec = self.recover()
        self.assertEqual(rec.cursor, 0)
        out = rec.poll()  # acked-but-undelivered data is not lost
        self.assertEqual([r["content"] for r in out], ["zero", "one"])
        self.assertEqual(rec.cursor, 2)

    def test_crash_after_delivery_commit_no_duplicate(self):
        eng = self.engine()
        (m0,) = message_frames("s", 0, 0, "zero")
        eng.offer(m0)
        self.assertEqual(len(eng.poll()), 1)
        eng.log.close()

        rec = self.recover()
        self.assertEqual(rec.cursor, 1)
        self.assertEqual(rec.poll(), [])  # not delivered twice
        self.assertEqual(rec.offer(m0)["status"], OLD)  # retransmit is old

    def test_crash_before_ack_needs_retransmit(self):
        eng = self.engine()
        eng.log.close()  # crash before anything was acknowledged
        rec = self.recover()
        (m0,) = message_frames("s", 0, 0, "zero")
        self.assertEqual(rec.offer(m0)["status"], ACCEPTED)
        self.assertEqual([r["content"] for r in rec.poll()], ["zero"])

    def test_ack_set_and_cursor_consistent_after_recovery(self):
        eng = self.engine()
        frags = message_frames("s", 0, 0, "abcdef", frags=3)
        (m1,) = message_frames("s", 0, 1, "one")
        (m2,) = message_frames("s", 0, 2, "two")
        eng.offer(frags[0])
        eng.offer(m2)
        eng.offer(m1)
        eng.poll()
        before = eng.acks("s", 0)
        cursor_before = eng.cursor
        eng.log.close()

        rec = self.recover()
        self.assertEqual(rec.acks("s", 0), before)
        self.assertEqual(rec.cursor, cursor_before)
        # finishing the message works identically after recovery
        rec.offer(frags[1])
        rec.offer(frags[2])
        self.assertEqual([r["content"] for r in rec.poll()],
                         ["abcdef", "one", "two"])

    def test_conflict_evidence_survives_recovery(self):
        eng = self.engine()
        (good,) = message_frames("s", 0, 0, "good")
        (evil,) = message_frames("s", 0, 0, "evil")
        eng.offer(good)
        self.assertEqual(eng.offer(evil)["status"], CONFLICT)
        eng.log.close()

        rec = self.recover()
        ev = rec.evidence()
        self.assertEqual(len(ev), 1)
        self.assertEqual(ev[0]["kept_hash"], good.hash)
        self.assertEqual(ev[0]["rejected_hash"], evil.hash)
        self.assertEqual([r["content"] for r in rec.poll()], ["good"])

    def test_recovery_detects_corrupt_log(self):
        eng = self.engine()
        (m1,) = message_frames("s", 0, 1, "one")
        eng.offer(m1)  # only seq 1 logged; a delivered event for 0 is corrupt
        eng.log.record("delivered", cursor=0, stream="s", epoch=0, seq=0,
                       content="x", hash="bad", close=False)
        eng.log.close()
        with self.assertRaises(ValueError):
            self.recover()


class TestEpochs(EngineCase):
    def test_late_frame_from_previous_epoch_is_stale(self):
        eng = self.engine()
        (m0,) = message_frames("s", 0, 0, "epoch0-zero")
        (n0,) = message_frames("s", 1, 0, "epoch1-zero")
        eng.offer(m0)
        eng.poll()
        self.assertEqual(eng.offer(n0)["status"], ACCEPTED)  # epoch advances
        late = message_frames("s", 0, 1, "epoch0-one")[0]
        res = eng.offer(late)
        self.assertEqual(res["status"], STALE)
        self.assertEqual(res["active_epoch"], 1)
        # state not corrupted: epoch 1 still delivers in order
        self.assertEqual([r["content"] for r in eng.poll()], ["epoch1-zero"])
        # epoch 0 buffer untouched
        self.assertEqual(eng.acks("s", 0)["delivered"], 1)

    def test_epochs_recover_consistently(self):
        eng = self.engine()
        eng.offer(message_frames("s", 0, 0, "e0")[0])
        eng.offer(message_frames("s", 1, 0, "e1")[0])
        eng.poll()
        eng.log.close()
        rec = self.recover()
        self.assertEqual(rec.cursor, 2)
        late = message_frames("s", 0, 1, "late")[0]
        self.assertEqual(rec.offer(late)["status"], STALE)


if __name__ == "__main__":
    unittest.main()
