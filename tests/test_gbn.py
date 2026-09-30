"""Acceptance and unit tests for the GBN implementation."""

import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from gbn import Environment, Sender, Receiver, run_simulation


def make_config(num_messages, timeout=10, script=None, frame_delay=1,
                ack_delay=1):
    return {
        "window": 4,
        "seq_space": 8,
        "timeout": timeout,
        "frame_delay": frame_delay,
        "ack_delay": ack_delay,
        "messages": [{"tick": i, "data": i} for i in range(num_messages)],
        "script": script or {},
    }


def reference_events_no_loss(num_frames, window=4, space=8):
    """Independent brute-force, frame-by-frame expectation, no-loss channel.

    Timing model (1 tick each way, timeout never fires):
      frame i is offered at tick i and sent at tick s_i, where
      s_i = i for i < window, else max(i, s_{i-window} + 2)
      (the window frees when the cumulative ACK for frame i-window returns).
      Frame i arrives at s_i + 1; its ACK arrives at s_i + 2.
    Within one tick the order is: app send, frame arrival, ACK arrival.
    The simulation stops once the last frame is delivered, so events after
    that delivery (the final ACK arrival) are not observed.
    """
    sends = []
    for i in range(num_frames):
        if i < window:
            sends.append(i)
        else:
            sends.append(max(i, sends[i - window] + 2))
    last_tick = sends[-1] + 1  # tick at which the last frame is delivered
    expected = []
    for t in range(last_tick + 1):
        for i, s in enumerate(sends):
            if s == t:
                expected.append((t, "app_send", i, i % space))
                expected.append((t, "tx_frame", i % space))
        for i, s in enumerate(sends):
            if s + 1 == t:
                expected.append((t, "rx_frame", i % space))
                expected.append((t, "deliver", i))
                expected.append((t, "tx_ack", i % space))
        if t < last_tick:  # final ACK arrival is never observed
            for i, s in enumerate(sends):
                if s + 2 == t:
                    expected.append((t, "rx_ack", i % space))
                    expected.append((t, "slide", (i + 1) % space))
    return expected


class TestNoLossMatchesReference(unittest.TestCase):
    """Scenario (a): 12 frames, no loss; event log must equal the
    brute-force frame-by-frame reference exactly."""

    def test_event_sequence_matches_reference(self):
        result = run_simulation(make_config(12))
        self.assertTrue(result["completed"])
        self.assertEqual(result["delivered"], list(range(12)))
        actual = [tuple(event) for event in result["events"]]
        expected = reference_events_no_loss(12)
        self.assertEqual(actual, expected)


class TestFrameLossGoBackN(unittest.TestCase):
    """Scenario (b): frame 2 lost once -> frames 3 and 4 discarded at the
    receiver, timeout retransmits, delivery strictly increasing, no dups."""

    def setUp(self):
        script = {"drop": [{"kind": "frame", "seq": 2, "occurrence": 1}]}
        self.result = run_simulation(make_config(12, timeout=8, script=script))
        self.events = [tuple(event) for event in self.result["events"]]
        self.kinds = [event[1] for event in self.events]

    def test_delivery_strictly_increasing_no_duplicates(self):
        delivered = self.result["delivered"]
        self.assertEqual(delivered, list(range(12)))
        self.assertEqual(len(delivered), len(set(delivered)))
        self.assertTrue(all(a < b for a, b in zip(delivered, delivered[1:])))

    def test_frames_3_and_4_discarded(self):
        discarded = [event[2] for event in self.events
                     if event[1] == "discard_frame"]
        self.assertIn(3, discarded)
        self.assertIn(4, discarded)

    def test_timeout_retransmission_happened(self):
        self.assertIn("drop_frame", self.kinds)
        self.assertIn("timeout", self.kinds)
        timeout_events = [e for e in self.events if e[1] == "timeout"]
        self.assertEqual(timeout_events[0][2], 2)  # oldest unacked = seq 2
        # Retransmission of the whole window after the timeout.
        timeout_tick = timeout_events[0][0]
        rtx = [e[2] for e in self.events
               if e[1] == "tx_frame" and e[0] == timeout_tick]
        self.assertEqual(rtx, [2, 3, 4, 5])

    def test_duplicate_acks_ignored(self):
        self.assertIn("ignore_ack", self.kinds)


class TestWrapAroundNoDeadlock(unittest.TestCase):
    """Scenario (c): 20 frames with a loss; sequence numbers wrap 7 -> 0;
    the run must complete without deadlock."""

    def test_wraparound_completes(self):
        script = {"drop": [{"kind": "frame", "seq": 5, "occurrence": 1}]}
        result = run_simulation(make_config(20, timeout=8, script=script))
        self.assertTrue(result["completed"])
        self.assertEqual(result["delivered"], list(range(20)))
        self.assertLessEqual(result["ticks"], 10000)
        # Wrap-around actually exercised: seq 7 followed by seq 0 in tx log.
        tx_seqs = [e[2] for e in result["events"] if e[1] == "tx_frame"]
        self.assertTrue(any(a == 7 and b == 0
                            for a, b in zip(tx_seqs, tx_seqs[1:])))
        # Window slid across the boundary: base wrapped past 7 back to 0..3.
        slides = [e[2] for e in result["events"] if e[1] == "slide"]
        self.assertIn(0, slides[1:])


class TestCorruptedAck(unittest.TestCase):
    """Scenario (d): a corrupted ACK must not slide the window."""

    def test_corrupted_ack_does_not_slide_window(self):
        script = {"corrupt": [{"kind": "ack", "seq": 0, "occurrence": 1}]}
        result = run_simulation(make_config(6, timeout=8, script=script))
        self.assertTrue(result["completed"])
        self.assertEqual(result["delivered"], list(range(6)))
        events = [tuple(event) for event in result["events"]]
        corrupt = [e for e in events if e[1] == "ignore_corrupt_ack"]
        self.assertEqual(len(corrupt), 1)
        corrupt_tick = corrupt[0][0]
        # No window slide at the tick the corrupted ACK arrived...
        self.assertNotIn("slide",
                         [e[1] for e in events if e[0] == corrupt_tick])
        # ...and the window never slid to base 1 (the corrupted ACK's effect).
        slides = [e[2] for e in events if e[1] == "slide"]
        self.assertNotIn(1, slides)


class TestSenderWindowFull(unittest.TestCase):
    """send() returns False (non-blocking) when the window is full,
    including across the sequence-number wrap boundary."""

    class _NullChannel:
        def send_frame(self, seq, data):
            pass

        def send_ack(self, ack):
            pass

    def make_sender(self):
        env = Environment()
        return Sender(env, self._NullChannel(), window=4, space=8, timeout=10)

    def test_window_full_returns_false(self):
        sender = self.make_sender()
        for i in range(4):
            self.assertTrue(sender.send(i))
        self.assertFalse(sender.send(4))
        self.assertFalse(sender.send(5))

    def test_window_full_after_wraparound(self):
        sender = self.make_sender()
        sender.base, sender.next_seq = 6, 2  # 4 outstanding across wrap
        self.assertFalse(sender.send("x"))
        sender.next_seq = 1  # 3 outstanding across wrap
        self.assertTrue(sender.send("x"))

    def test_cumulative_ack_slides_window_across_wrap(self):
        sender = self.make_sender()
        sender.base, sender.next_seq = 6, 2
        sender.buffer = {6: "a", 7: "b", 0: "c", 1: "d"}
        sender.receive_ack(0)  # cumulative: 6, 7, 0 acked
        self.assertEqual(sender.base, 1)
        self.assertEqual(set(sender.buffer), {1})


class TestCli(unittest.TestCase):
    """CLI: python -m gbn simulate trace.json prints the delivered sequence."""

    def test_cli_outputs_delivered_sequence(self):
        config = make_config(
            12, timeout=8,
            script={"drop": [{"kind": "frame", "seq": 2, "occurrence": 1}]})
        repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        with tempfile.NamedTemporaryFile(
                "w", suffix=".json", delete=False) as fh:
            json.dump(config, fh)
            path = fh.name
        try:
            proc = subprocess.run(
                [sys.executable, "-m", "gbn", "simulate", path],
                cwd=repo_root, capture_output=True, text=True, timeout=60)
        finally:
            os.unlink(path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout), list(range(12)))


if __name__ == "__main__":
    unittest.main()
