import unittest

from msdeliv.frames import message_frames
from msdeliv.receiver import (
    ACCEPTED,
    AMBIGUOUS,
    BUSY,
    CLOSED,
    CONFLICT,
    DUPLICATE,
    OLD,
    ReassemblyBuffer,
)


def buf(mod=16, window=4, capacity=None):
    return ReassemblyBuffer("s", 0, mod, window, capacity)


class TestReceiver(unittest.TestCase):
    def test_in_order_delivery(self):
        b = buf()
        for f in message_frames("s", 0, 0, "hello", frags=2):
            self.assertEqual(b.accept(f).status, ACCEPTED)
        out = b.poll_ready()
        self.assertEqual([(s, c) for s, c, _, _ in out], [(0, "hello")])
        self.assertEqual(b.next_seq, 1)

    def test_out_of_order_then_gap_fill_cascades(self):
        b = buf()
        (m1,) = message_frames("s", 0, 1, "one")
        (m2,) = message_frames("s", 0, 2, "two")
        (m0,) = message_frames("s", 0, 0, "zero")
        b.accept(m2)
        b.accept(m1)
        self.assertEqual(b.poll_ready(), [])
        b.accept(m0)
        out = b.poll_ready()
        self.assertEqual([c for _, c, _, _ in out], ["zero", "one", "two"])

    def test_duplicate_is_idempotent(self):
        b = buf()
        (m,) = message_frames("s", 0, 0, "x")
        self.assertEqual(b.accept(m).status, ACCEPTED)
        self.assertEqual(b.accept(m).status, DUPLICATE)
        self.assertEqual(len(b.poll_ready()), 1)

    def test_missing_last_fragment_blocks_and_requests_gap(self):
        b = buf()
        frags = message_frames("s", 0, 0, "abcdef", frags=3)
        (m1,) = message_frames("s", 0, 1, "next")
        b.accept(frags[0])
        b.accept(frags[1])
        b.accept(m1)
        self.assertEqual(b.poll_ready(), [])
        acks = b.acks()
        self.assertEqual(acks["retransmit"], [0])
        self.assertEqual(acks["ack_ranges"], [[1, 1]])
        b.accept(frags[2])
        out = b.poll_ready()
        self.assertEqual([c for _, c, _, _ in out], ["abcdef", "next"])

    def test_conflicting_retransmit_rejected_atomically_with_evidence(self):
        b = buf()
        (good,) = message_frames("s", 0, 0, "good")
        (evil,) = message_frames("s", 0, 0, "evil")
        b.accept(good)
        res = b.accept(evil)
        self.assertEqual(res.status, CONFLICT)
        self.assertEqual(len(b.evidence), 1)
        ev = b.evidence[0]
        self.assertEqual(ev["kept_hash"], good.hash)
        self.assertEqual(ev["rejected_hash"], evil.hash)
        self.assertEqual(ev["rejected_payload"], "evil")
        out = b.poll_ready()
        self.assertEqual([c for _, c, _, _ in out], ["good"])

    def test_conflict_after_delivery_still_recorded(self):
        b = buf()
        (good,) = message_frames("s", 0, 0, "good")
        (evil,) = message_frames("s", 0, 0, "evil")
        b.accept(good)
        b.poll_ready()
        res = b.accept(evil)
        self.assertEqual(res.status, CONFLICT)
        self.assertEqual(len(b.evidence), 1)

    def test_close_and_duplicate_close(self):
        b = buf()
        (fin,) = message_frames("s", 0, 0, "bye", close=True)
        self.assertEqual(b.accept(fin).status, ACCEPTED)
        self.assertEqual(b.accept(fin).status, DUPLICATE)
        out = b.poll_ready()
        self.assertTrue(out[0][3])
        self.assertTrue(b.closed)
        self.assertEqual(b.accept(fin).status, CLOSED)
        (m1,) = message_frames("s", 0, 1, "late")
        self.assertEqual(b.accept(m1).status, CLOSED)

    def test_backpressure_window_full_then_gap_fill(self):
        b = buf(mod=16, window=4, capacity=2)
        (m1,) = message_frames("s", 0, 1, "one")
        (m2,) = message_frames("s", 0, 2, "two")
        (m3,) = message_frames("s", 0, 3, "three")
        (m0,) = message_frames("s", 0, 0, "zero")
        b.accept(m1)
        b.accept(m2)
        res = b.accept(m3)
        self.assertEqual(res.status, BUSY)
        self.assertEqual(b.accept(m3).status, BUSY)
        self.assertEqual(sorted(b.slots), [1, 2])
        self.assertEqual(b.accept(m0).status, ACCEPTED)
        out = b.poll_ready()
        self.assertEqual([c for _, c, _, _ in out], ["zero", "one", "two"])
        self.assertEqual(b.accept(m3).status, ACCEPTED)

    def test_ambiguous_and_old_classification(self):
        b = buf(mod=16, window=4)
        for seq in range(6):
            (m,) = message_frames("s", 0, seq, f"m{seq}")
            b.accept(m)
            b.poll_ready()
        (far_future,) = message_frames("s", 0, (6 + 6) % 16, "future")
        self.assertEqual(b.accept(far_future).status, AMBIGUOUS)
        (old,) = message_frames("s", 0, 4, "m4")  # exact retransmit: old
        self.assertEqual(b.accept(old).status, OLD)
        (changed,) = message_frames("s", 0, 4, "changed")  # conflict: evidence
        self.assertEqual(b.accept(changed).status, CONFLICT)

    def test_wraparound_delivery(self):
        b = buf(mod=8, window=3)
        delivered = []
        for i in range(12):
            seq = i % 8
            (m,) = message_frames("s", 0, seq, f"m{i}")
            self.assertEqual(b.accept(m).status, ACCEPTED, i)
            delivered.extend(b.poll_ready())
        self.assertEqual(len(delivered), 12)
        self.assertEqual(b.next_seq, 4)
        self.assertEqual(b.delivered_count, 12)
        # exact retransmit of the most recent seq-2 message ("m10"): old
        (stale,) = message_frames("s", 0, 2, "m10")
        self.assertEqual(b.accept(stale).status, OLD)
        # same seq, different content: conflict with retained evidence
        (forged,) = message_frames("s", 0, 2, "m2")
        self.assertEqual(b.accept(forged).status, CONFLICT)


if __name__ == "__main__":
    unittest.main()
