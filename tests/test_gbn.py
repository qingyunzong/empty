"""Tests for the GBN simulator (window N=4, sequence space 8)."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from gbn.channel import InjectionRule
from gbn.protocol import Receiver, Sender, in_window, seq_distance
from gbn.simulator import Simulator

REPO_ROOT = Path(__file__).resolve().parent.parent


def run(frames, rules=None, timeout=10, max_ticks=10000):
    return Simulator(
        list(frames), timeout=timeout, rules=rules or [], max_ticks=max_ticks
    ).run()


def reference_clean_events(nframes, window=4, space=8):
    """Brute-force reference: enumerate the expected event sequence for a
    clean channel frame by frame.

    Timing model: a data frame sent at tick t is received at t+1, its ACK
    arrives back at t+2. The first ``window`` frames are sent at tick 0;
    frame i (i >= window) is sent when the ACK for frame i-window arrives.
    """
    send_tick = {}
    for i in range(nframes):
        send_tick[i] = 0 if i < window else send_tick[i - window] + 2
    events = []
    last_tick = send_tick[nframes - 1] + 1  # last delivery tick
    for tick in range(last_tick + 1):
        for i in range(nframes):  # data frames arriving this tick
            if send_tick[i] == tick - 1:
                seq = i % space
                events += [
                    ("recv-data", seq),
                    ("deliver", seq),
                    ("send-ack", seq),
                    ("transmit", "ack", seq),
                ]
        for i in range(nframes):  # ACKs arriving this tick
            if send_tick[i] == tick - 2:
                seq = i % space
                events += [("recv-ack", seq), ("window-slide", (seq + 1) % space)]
        for i in range(nframes):  # new frames sent this tick
            if send_tick[i] == tick:
                seq = i % space
                events += [("send", seq), ("transmit", "data", seq)]
    return events


class TestSequenceArithmetic(unittest.TestCase):
    def test_wrap_around_comparison(self):
        # Window [6, 7, 0, 1] with base=6, size=4, space=8.
        self.assertTrue(in_window(6, 6, 4, 8))
        self.assertTrue(in_window(7, 6, 4, 8))
        self.assertTrue(in_window(0, 6, 4, 8))
        self.assertTrue(in_window(1, 6, 4, 8))
        self.assertFalse(in_window(2, 6, 4, 8))
        self.assertFalse(in_window(5, 6, 4, 8))

    def test_seq_distance(self):
        self.assertEqual(seq_distance(0, 6, 8), 2)
        self.assertEqual(seq_distance(7, 0, 8), 7)
        self.assertEqual(seq_distance(3, 3, 8), 0)


class TestSenderUnit(unittest.TestCase):
    def test_send_returns_false_when_window_full(self):
        sender = Sender()
        for i in range(4):
            self.assertTrue(sender.send(i, now=0))
        self.assertFalse(sender.send(4, now=0))
        self.assertFalse(sender.send(5, now=0))

    def test_cumulative_ack_slides_window_across_wrap(self):
        sender = Sender()
        sender.base = 6
        sender.next_seq = 6
        for i in range(4):  # seqs 6, 7, 0, 1
            self.assertTrue(sender.send(i, now=0))
        events = sender.on_ack(0, now=1)  # cumulatively acks 6, 7, 0
        self.assertEqual(events, [("window-slide", 1)])
        self.assertEqual(sender.base, 1)
        self.assertEqual(sender.outstanding(), 1)
        self.assertTrue(sender.send("x", now=1))  # window has room again

    def test_stale_ack_ignored(self):
        sender = Sender()
        sender.send("a", now=0)
        self.assertEqual(sender.on_ack(7, now=1), [])
        self.assertEqual(sender.base, 0)

    def test_timeout_retransmits_whole_window(self):
        sender = Sender()
        for i in range(3):
            sender.send(i, now=0)
        sender.drain_pending()
        sender.on_timeout(now=10)
        retransmitted = [f.seq for f in sender.drain_pending()]
        self.assertEqual(retransmitted, [0, 1, 2])


class TestReceiverUnit(unittest.TestCase):
    def test_accepts_only_expected_sequence(self):
        receiver = Receiver()
        self.assertEqual(receiver.on_data(1, "x"), (None, None))
        self.assertEqual(receiver.on_data(0, "a"), ("a", 0))
        self.assertEqual(receiver.on_data(5, "y"), (None, 0))  # resend last ACK
        self.assertEqual(receiver.on_data(1, "b"), ("b", 1))
        self.assertEqual(receiver.delivered, ["a", "b"])

    def test_corrupt_frame_discarded(self):
        receiver = Receiver()
        self.assertEqual(receiver.on_data(0, "a", corrupt=True), (None, None))
        self.assertEqual(receiver.delivered, [])


class TestCleanChannel(unittest.TestCase):
    """Scenario (a): 12 frames, no loss, events match brute-force reference."""

    def test_events_match_bruteforce_reference(self):
        result = run(range(12))
        self.assertEqual(result.events, reference_clean_events(12))
        self.assertEqual(result.delivered, list(range(12)))


class TestFrameLoss(unittest.TestCase):
    """Scenario (b): frame 2 lost -> 3, 4 discarded -> timeout retransmit."""

    def test_lost_frame_triggers_go_back_n(self):
        rules = [InjectionRule("drop", "data", 2, occurrence=1)]
        result = run(range(12), rules)
        events = result.events
        # Receiver discards frames 3 and 4 (it is waiting for 2).
        self.assertIn(("discard", 3), events)
        self.assertIn(("discard", 4), events)
        # Receiver re-sends the last cumulative ACK (ACK 1).
        self.assertGreater(events.count(("send-ack", 1)), 1)
        # Sender times out on the oldest unacked frame and goes back N.
        self.assertIn(("timeout", 2), events)
        for seq in (2, 3, 4, 5):
            self.assertIn(("retransmit", seq), events)
        # Delivered sequence is strictly increasing, no duplicates.
        delivered = result.delivered
        self.assertEqual(delivered, list(range(12)))
        self.assertEqual(len(delivered), len(set(delivered)))
        self.assertTrue(
            all(a < b for a, b in zip(delivered, delivered[1:]))
        )


class TestWrapAround(unittest.TestCase):
    """Scenario (c): 20 frames wrap the sequence space twice; no deadlock."""

    def test_twenty_frames_no_deadlock(self):
        result = run(range(20), max_ticks=1000)
        self.assertEqual(result.delivered, list(range(20)))
        # Sequence numbers actually wrapped: seq 0 is sent three times.
        sends_of_zero = result.events.count(("send", 0))
        self.assertEqual(sends_of_zero, 3)  # frames 0, 8, 16

    def test_loss_across_wrap_boundary(self):
        # Second transmission of seq 7 (frame 15) is lost.
        rules = [InjectionRule("drop", "data", 7, occurrence=2)]
        result = run(range(20), rules)
        self.assertEqual(result.delivered, list(range(20)))
        self.assertIn(("retransmit", 7), result.events)


class TestCorruptAck(unittest.TestCase):
    """Scenario (d): a corrupt ACK must not slide the sender window."""

    def test_corrupt_ack_does_not_slide_window(self):
        rules = [InjectionRule("corrupt", "ack", 0, occurrence=1)]
        rules += [InjectionRule("drop", "ack", s, occurrence=1) for s in (1, 2, 3)]
        result = run(range(8), rules)
        events = result.events
        self.assertIn(("corrupt-ack", 0), events)
        timeout_idx = events.index(("timeout", 0))
        slides_before_timeout = [
            e for e in events[:timeout_idx] if e[0] == "window-slide"
        ]
        self.assertEqual(slides_before_timeout, [])
        # Recovery via timeout retransmission still delivers everything.
        self.assertEqual(result.delivered, list(range(8)))


class TestReorder(unittest.TestCase):
    def test_delayed_frame_causes_reorder_and_recovery(self):
        # Data frame 1 is delayed so frames 2, 3 arrive first.
        rules = [InjectionRule("delay", "data", 1, occurrence=1, by=3)]
        result = run(range(8), rules)
        self.assertIn(("discard", 2), result.events)
        self.assertEqual(result.delivered, list(range(8)))


class TestCli(unittest.TestCase):
    def test_simulate_command_outputs_delivered_sequence(self):
        trace = {
            "frames": 12,
            "events": [{"action": "drop", "kind": "data", "seq": 2}],
        }
        with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False
        ) as fh:
            json.dump(trace, fh)
            path = fh.name
        proc = subprocess.run(
            [sys.executable, "-m", "gbn", "simulate", path],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertEqual(json.loads(proc.stdout), list(range(12)))


if __name__ == "__main__":
    unittest.main()
