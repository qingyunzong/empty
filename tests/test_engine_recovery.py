import os
import tempfile
import unittest

from reorder.engine import Engine
from reorder.journal import CorruptionError
from reorder.messages import make_close_frame, make_message_frames


class TestEngineRecovery(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.wal = os.path.join(self.tmp.name, "wal.jsonl")
        self.engine = Engine(modulus=8, window=3, journal_path=self.wal,
                             sync=False)

    def tearDown(self):
        self.engine.close()
        self.tmp.cleanup()

    def test_multi_stream_routing(self):
        self.engine.receive(make_message_frames("a", 0, 0, "A")[0])
        self.engine.receive(make_message_frames("b", 0, 0, "B")[0])
        out = self.engine.poll()
        self.assertEqual([(r["stream_id"], r["content"]) for r in out],
                         [("a", "A"), ("b", "B")])

    def test_crash_before_ack_retransmit_accepted(self):
        frame = make_message_frames("s", 0, 0, "hello", frag_count=2)[0]
        self.engine.receive(frame)          # recv journaled, not yet acked
        self.engine.crash()
        self.engine.recover()
        status = self.engine.status()["s:0"]
        self.assertEqual(status["acked"], [])   # not in the persistent ack set
        # Peer retransmits both fragments; delivery proceeds exactly once.
        for f in make_message_frames("s", 0, 0, "hello", frag_count=2):
            self.engine.receive(f)
        out = self.engine.poll()
        self.assertEqual([r["content"] for r in out], ["hello"])

    def test_crash_after_ack_before_deliver(self):
        frame = make_message_frames("s", 0, 0, "hello")[0]
        self.engine.receive(frame)              # assembled commit written
        self.engine.crash()                     # ...but never delivered
        self.engine.recover()
        status = self.engine.status()["s:0"]
        self.assertEqual(status["acked"], [0])  # ack set survived
        self.assertEqual(status["delivered"], [])
        # Retransmission dedups against the persistent ack set...
        result = self.engine.receive(frame)
        self.assertEqual(result["status"], "dup")
        # ...and the acked-but-undelivered data is still delivered.
        out = self.engine.poll()
        self.assertEqual([r["content"] for r in out], ["hello"])
        # After delivery + recovery the cursor and ack set stay consistent.
        self.engine.crash()
        self.engine.recover()
        status = self.engine.status()["s:0"]
        self.assertEqual(status["delivered"], [0])
        self.assertEqual(status["next_expected"], 1)
        self.assertEqual(self.engine.poll(), [])

    def test_crash_after_deliver_no_duplicate_output(self):
        for seq in range(3):
            self.engine.receive(make_message_frames("s", 0, seq, f"m{seq}")[0])
        self.assertEqual(len(self.engine.poll()), 3)
        self.engine.crash()
        self.engine.recover()
        self.assertEqual(self.engine.poll(), [])
        self.assertEqual(self.engine.status()["s:0"]["next_expected"], 3)

    def test_cross_epoch_late_frame(self):
        # Epoch 0 closes; a late epoch-0 frame arrives after epoch 1 starts.
        self.engine.receive(make_close_frame("s", 0, 0))
        self.assertEqual(self.engine.poll()[0]["kind"], "close")
        late = make_message_frames("s", 0, 1, "late")[0]
        self.assertEqual(self.engine.receive(late)["status"], "closed")
        # Same seq on epoch 1 is a fresh, independent channel.
        fresh = make_message_frames("s", 1, 1, "late")[0]
        self.assertEqual(self.engine.receive(fresh)["status"], "complete")
        self.engine.receive(make_message_frames("s", 1, 0, "first")[0])
        out = self.engine.poll()
        self.assertEqual([r["content"] for r in out], ["first", "late"])
        # Crash/recover keeps the two epochs' ack sets separate.
        self.engine.crash()
        self.engine.recover()
        status = self.engine.status()
        self.assertTrue(status["s:0"]["done"])
        self.assertEqual(status["s:1"]["delivered"], [0, 1])

    def test_conflict_evidence_survives_recovery(self):
        good = make_message_frames("s", 0, 0, "good", frag_count=2)
        evil = make_message_frames("s", 0, 0, "evil", frag_count=2)
        self.engine.receive(good[0])
        result = self.engine.receive(evil[1])
        self.assertEqual(result["status"], "conflict")
        self.engine.crash()
        self.engine.recover()
        conflicts = self.engine.conflicts()
        self.assertEqual(len(conflicts), 1)
        self.assertEqual(conflicts[0]["rejected_frame"]["payload"],
                         evil[1].payload)

    def test_corrupted_journal_detected(self):
        self.engine.receive(make_message_frames("s", 0, 0, "x")[0])
        self.engine.poll()
        self.engine.close()
        # Forge a delivered record for a seq that was never acked.
        with open(self.wal, "a", encoding="utf-8") as fh:
            fh.write('{"t":"delivered","stream_id":"s","epoch":0,"seq":1,'
                     '"kind":"data","content":"forged"}\n')
        engine2 = Engine(modulus=8, window=3, journal_path=self.wal, sync=False)
        with self.assertRaises(CorruptionError):
            engine2.recover()
        engine2.close()


if __name__ == "__main__":
    unittest.main()
