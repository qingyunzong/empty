import unittest

from reorder.messages import (hash_content, make_close_frame,
                              make_message_frames)
from reorder.stream import Status, StreamReceiver


def recv_all(st, frames):
    return [st.receive(f).status for f in frames]


class TestStreamReceiver(unittest.TestCase):
    def setUp(self):
        self.st = StreamReceiver("s", 0, modulus=8, window=3)

    def test_in_order_delivery(self):
        frames = make_message_frames("s", 0, 0, "hello")
        self.assertEqual(recv_all(self.st, frames), [Status.COMPLETE])
        out, _ = self.st.poll()
        self.assertEqual([r["content"] for r in out], ["hello"])
        self.assertEqual(self.st.next_expected, 1)

    def test_out_of_order_buffered_until_gap_filled(self):
        f0 = make_message_frames("s", 0, 0, "a")[0]
        f1 = make_message_frames("s", 0, 1, "b")[0]
        self.assertEqual(self.st.receive(f1).status, Status.COMPLETE)
        self.assertEqual(self.st.poll()[0], [])  # gap at 0: nothing delivered
        self.assertEqual(self.st.receive(f0).status, Status.COMPLETE)
        out, _ = self.st.poll()
        self.assertEqual([r["content"] for r in out], ["a", "b"])

    def test_duplicate_frame_is_idempotent(self):
        f = make_message_frames("s", 0, 0, "x")[0]
        self.assertEqual(self.st.receive(f).status, Status.COMPLETE)
        self.assertEqual(self.st.receive(f).status, Status.DUP)
        out, _ = self.st.poll()
        self.assertEqual(len(out), 1)
        # After delivery the seq falls behind the window: OLD, not an error.
        self.assertEqual(self.st.receive(f).status, Status.OLD)

    def test_missing_last_fragment_blocks_assembly(self):
        frags = make_message_frames("s", 0, 0, "abcdef", frag_count=3)
        self.assertEqual(self.st.receive(frags[0]).status, Status.ACK)
        self.assertEqual(self.st.receive(frags[1]).status, Status.ACK)
        self.assertEqual(self.st.poll()[0], [])  # last fragment missing
        self.assertEqual(self.st.receive(frags[2]).status, Status.COMPLETE)
        out, _ = self.st.poll()
        self.assertEqual(out[0]["content"], "abcdef")

    def test_conflicting_retransmit_rejected_atomically_with_evidence(self):
        good = make_message_frames("s", 0, 0, "good", frag_count=2)
        evil = make_message_frames("s", 0, 0, "evil", frag_count=2)
        self.assertEqual(self.st.receive(good[0]).status, Status.ACK)
        result = self.st.receive(evil[1])
        self.assertEqual(result.status, Status.CONFLICT)
        self.assertIsNotNone(result.evidence)
        self.assertEqual(result.evidence["kept_hash"], hash_content("good"))
        self.assertEqual(result.evidence["rejected_hash"], hash_content("evil"))
        # Atomic: the original partial is untouched and still completes.
        self.assertEqual(self.st.receive(good[1]).status, Status.COMPLETE)
        out, _ = self.st.poll()
        self.assertEqual([r["content"] for r in out], ["good"])
        self.assertEqual(len(self.st.conflicts), 1)

    def test_close_and_duplicate_close(self):
        close = make_close_frame("s", 0, 0)
        self.assertEqual(self.st.receive(close).status, Status.COMPLETE)
        self.assertEqual(self.st.receive(close).status, Status.DUP)
        out, _ = self.st.poll()
        self.assertEqual(out[0]["kind"], "close")
        self.assertTrue(self.st.done)
        self.assertEqual(self.st.receive(close).status, Status.CLOSED)

    def test_wraparound_delivery(self):
        # Deliver 10 messages on a modulus-8 cycle: seqs wrap 6,7,0,1,...
        for seq in range(10):
            frame = make_message_frames("s", 0, seq % 8, f"m{seq}")[0]
            self.assertEqual(self.st.receive(frame).status, Status.COMPLETE)
            out, _ = self.st.poll()
            self.assertEqual(out[0]["content"], f"m{seq}")
        self.assertEqual(self.st.next_expected, 10 % 8)

    def test_window_full_backpressure_and_gap_fill(self):
        # Window 3 at base 0. Occupy every slot while a gap fragment of
        # message 0 is still missing: partial(0) + ready(1) + ready(2).
        g0 = make_message_frames("s", 0, 0, "g0", frag_count=2)
        f1 = make_message_frames("s", 0, 1, "g1")[0]
        f2 = make_message_frames("s", 0, 2, "g2")[0]
        self.st.receive(g0[0])
        self.st.receive(f1)
        self.st.receive(f2)
        self.assertTrue(self.st.window_full())
        # Far-future frame: deterministic backpressure, nothing dropped.
        future = make_message_frames("s", 0, 4, "future")[0]
        self.assertEqual(self.st.receive(future).status, Status.BACKPRESSURE)
        self.assertEqual(self.st.receive(future).status, Status.BACKPRESSURE)
        # The missing gap fragment is in-window and must still be accepted.
        self.assertEqual(self.st.receive(g0[1]).status, Status.COMPLETE)
        out, _ = self.st.poll()
        self.assertEqual([r["content"] for r in out], ["g0", "g1", "g2"])
        self.assertFalse(self.st.window_full())
        # Window advanced: seq 4 is now in-window, accepted on retransmit.
        self.assertEqual(self.st.receive(future).status, Status.COMPLETE)

    def test_future_vs_old_distinction(self):
        st = StreamReceiver("s", 0, modulus=8, window=3, base=6)
        old = make_message_frames("s", 0, 5, "old")[0]
        future = make_message_frames("s", 0, 2, "future")[0]
        self.assertEqual(st.receive(old).status, Status.OLD)
        self.assertEqual(st.receive(future).status, Status.FUTURE)

    def test_selective_ack_ranges_and_gap_requests(self):
        st = StreamReceiver("s", 0, modulus=8, window=4)
        for seq in (1, 3):
            st.receive(make_message_frames("s", 0, seq, f"m{seq}")[0])
        self.assertEqual(st.ack_ranges(), [(1, 1), (3, 3)])
        self.assertEqual(st.gap_requests(), [0, 2])

    def test_corrupt_fragment_hash_rejected_and_retriable(self):
        frags = make_message_frames("s", 0, 0, "abc", frag_count=2)
        bad = make_message_frames("s", 0, 0, "abc", frag_count=2)[1]
        bad = type(bad)(**{**bad.to_dict(), "payload": "ZZ"})
        self.assertEqual(self.st.receive(frags[0]).status, Status.ACK)
        self.assertEqual(self.st.receive(bad).status, Status.CONFLICT)
        # Partial was discarded atomically: a clean retransmit succeeds.
        self.assertEqual(self.st.receive(frags[0]).status, Status.ACK)
        self.assertEqual(self.st.receive(frags[1]).status, Status.COMPLETE)


if __name__ == "__main__":
    unittest.main()
