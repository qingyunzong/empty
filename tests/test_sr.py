import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sr import Frame, Receiver, Sender, Simulator, validate_params


class TestParamValidation(unittest.TestCase):
    """Scenario (d): illegal parameters must raise ValueError."""

    def test_default_params_valid(self):
        validate_params(4, 8)
        Simulator(window_size=4, seq_space=8)

    def test_n5_m8_raises(self):
        with self.assertRaises(ValueError):
            Simulator(window_size=5, seq_space=8)
        with self.assertRaises(ValueError):
            Sender(window_size=5, seq_space=8)
        with self.assertRaises(ValueError):
            Receiver(window_size=5, seq_space=8)
        with self.assertRaises(ValueError):
            validate_params(5, 8)

    def test_boundary_and_other_illegal_params(self):
        validate_params(4, 8)   # N == M/2 is the largest legal window
        validate_params(1, 2)
        for n, m in [(0, 8), (-1, 8), (4, 7), (3, 4), (2, 2), (1, 1)]:
            with self.assertRaises(ValueError, msg=f"N={n}, M={m}"):
                validate_params(n, m)


class TestScenarioAFrameLoss(unittest.TestCase):
    """Scenario (a): only frame 1 is lost; frames 2,3 are buffered; once
    frame 1 is retransmitted, frames 1,2,3 are delivered in one batch.
    Checked against a reference enumeration table of expected states."""

    TRACE = [
        {"op": "send", "data": "f0"},
        {"op": "send", "data": "f1"},
        {"op": "send", "data": "f2"},
        {"op": "send", "data": "f3"},
        {"op": "lose", "seq": 1},
        {"op": "deliver", "seq": 0},
        {"op": "deliver", "seq": 2},
        {"op": "deliver", "seq": 3},
        {"op": "deliver_ack", "seq": 0},
        {"op": "deliver_ack", "seq": 2},
        {"op": "deliver_ack", "seq": 3},
        {"op": "advance", "t": 10},   # only frame 1's timer is still running
        {"op": "deliver", "seq": 1},  # retransmitted copy arrives
    ]

    # Reference enumeration table: (event index, expected delivered so far,
    # expected retransmissions) after executing that event.
    REFERENCE_TABLE = [
        (7,  ["f0"], 0),                       # f2,f3 buffered, not delivered
        (10, ["f0"], 0),                       # ACKs processed, still blocked
        (11, ["f0"], 1),                       # timeout: only f1 retransmitted
        (12, ["f0", "f1", "f2", "f3"], 1),     # one batch: 1,2,3 delivered
    ]

    def test_against_reference_table(self):
        sim = Simulator(window_size=4, seq_space=8, timeout=10)
        for i, event in enumerate(self.TRACE):
            op = event["op"]
            if op == "send":
                sim.send(event["data"])
            elif op == "lose":
                sim.lose(event["seq"])
            elif op == "deliver":
                before = len(sim.delivered)
                sim.deliver(event["seq"])
                if i == 12:
                    # frames 1,2,3 delivered in a single receive call
                    self.assertEqual(sim.delivered[before:], ["f1", "f2", "f3"])
            elif op == "deliver_ack":
                sim.deliver_ack(event["seq"])
            elif op == "advance":
                fired = sim.advance(event["t"])
                if i == 11:
                    self.assertEqual(fired, [1])  # only frame 1 retransmitted
            for idx, exp_delivered, exp_retx in self.REFERENCE_TABLE:
                if idx == i:
                    self.assertEqual(sim.delivered, exp_delivered, f"event {i}")
                    self.assertEqual(sim.retransmissions, exp_retx, f"event {i}")
        self.assertEqual(sim.delivered, ["f0", "f1", "f2", "f3"])
        self.assertEqual(sim.retransmissions, 1)


class TestScenarioBDuplicate(unittest.TestCase):
    """Scenario (b): the same frame arriving twice is ACKed twice but
    delivered exactly once."""

    def test_duplicate_delivery_dedup(self):
        sim = Simulator(window_size=4, seq_space=8, timeout=5)
        sim.send("f0")
        sim.advance(5)                      # timeout -> second copy in channel
        self.assertEqual(sim.retransmissions, 1)
        self.assertEqual(len(sim.channel), 2)
        ack1 = sim.deliver(0)               # first copy
        self.assertEqual(sim.delivered, ["f0"])
        ack2 = sim.deliver(0)               # duplicate copy
        self.assertIsNotNone(ack1)
        self.assertIsNotNone(ack2)          # duplicate re-ACKed
        self.assertEqual(ack1, ack2)
        self.assertEqual(sim.delivered, ["f0"])  # delivered exactly once

    def test_receiver_level_duplicate_after_slide(self):
        rcv = Receiver(window_size=4, seq_space=8)
        for s in range(4):
            self.assertIsNotNone(rcv.receive(Frame(seq=s, data=f"f{s}", abs_seq=s)))
        self.assertEqual(rcv.delivered, ["f0", "f1", "f2", "f3"])
        # old frame 0 (now in the duplicate region) is re-ACKed, not delivered
        ack = rcv.receive(Frame(seq=0, data="f0", abs_seq=0))
        self.assertIsNotNone(ack)
        self.assertEqual(ack.seq, 0)
        self.assertEqual(rcv.delivered, ["f0", "f1", "f2", "f3"])


class TestScenarioCSameTickTimers(unittest.TestCase):
    """Scenario (c): timers expiring at the same tick fire in ascending
    sequence-number order."""

    def test_same_tick_order(self):
        sim = Simulator(window_size=4, seq_space=8, timeout=10)
        for s in range(4):                  # all four timers expire at t=10
            sim.send(f"f{s}")
        fired = sim.advance(10)
        self.assertEqual(fired, [0, 1, 2, 3])
        self.assertEqual(sim.sender.timeout_log, [0, 1, 2, 3])
        self.assertEqual(sim.retransmissions, 4)

    def test_earliest_expiry_first_then_tie_by_seq(self):
        sim = Simulator(window_size=4, seq_space=8, timeout=10)
        sim.send("f0")                      # expires at 10
        sim.send("f1")                      # expires at 10
        sim.advance(5)
        sim.send("f2")                      # expires at 15
        sim.send("f3")                      # expires at 15
        fired = sim.advance(10)             # t: 5 -> 15
        self.assertEqual(fired, [0, 1, 2, 3])
        # interleaved expiries: 0,1 re-armed at 10 fire at 20;
        # 2,3 re-armed at 15 fire together at 25 (tie -> ascending seq)
        fired = sim.advance(10)             # t: 15 -> 25
        self.assertEqual(fired, [0, 1, 2, 3])


class TestReceiverWindowSemantics(unittest.TestCase):
    """Semantic (1): frames outside the receive window are dropped."""

    def test_out_of_window_frame_dropped(self):
        # N=3, M=8: window offsets {0,1,2}, duplicates {5,6,7},
        # offsets {3,4} are outside the window and must be dropped.
        rcv = Receiver(window_size=3, seq_space=8)
        ack = rcv.receive(Frame(seq=4, data="x", abs_seq=4))
        self.assertIsNone(ack)
        self.assertEqual(rcv.buffer, {})
        self.assertEqual(rcv.delivered, [])
        ack = rcv.receive(Frame(seq=3, data="y", abs_seq=3))
        self.assertIsNone(ack)
        self.assertEqual(rcv.delivered, [])

    def test_in_window_buffered_and_delivered_in_order(self):
        rcv = Receiver(window_size=4, seq_space=8)
        rcv.receive(Frame(seq=2, data="f2", abs_seq=2))
        rcv.receive(Frame(seq=1, data="f1", abs_seq=1))
        self.assertEqual(rcv.delivered, [])          # blocked on f0
        rcv.receive(Frame(seq=0, data="f0", abs_seq=0))
        self.assertEqual(rcv.delivered, ["f0", "f1", "f2"])


class TestSenderWindowSemantics(unittest.TestCase):
    """Semantic (3): the send window slides only when its lower edge is
    ACKed; each frame has an independent timer and is retransmitted alone."""

    def test_slides_only_on_base_ack(self):
        snd = Sender(window_size=4, seq_space=8, timeout=10)
        for s in range(4):
            snd.send(f"f{s}", now=0)
        self.assertTrue(snd.window_full())
        snd.receive_ack(1, now=1)           # non-base ACK: no slide
        snd.receive_ack(2, now=1)
        self.assertEqual(snd.base, 0)
        self.assertTrue(snd.window_full())
        snd.receive_ack(0, now=2)           # base ACK: slide past 0,1,2
        self.assertEqual(snd.base, 3)
        self.assertFalse(snd.window_full())
        snd.send("f4", now=3)               # window has room again
        self.assertEqual(snd.next_seq, 5)

    def test_ack_cancels_only_its_own_timer(self):
        sim = Simulator(window_size=4, seq_space=8, timeout=10)
        for s in range(4):
            sim.send(f"f{s}")
        sim.deliver(0)
        sim.deliver(2)
        sim.deliver_ack(0)
        sim.deliver_ack(2)
        fired = sim.advance(10)
        self.assertEqual(fired, [1, 3])     # only un-ACKed frames retransmit
        self.assertEqual(sim.retransmissions, 2)

    def test_stale_ack_ignored(self):
        snd = Sender(window_size=4, seq_space=8, timeout=10)
        snd.send("f0", now=0)
        self.assertFalse(snd.receive_ack(5, now=1))  # not outstanding
        self.assertEqual(snd.base, 0)


class TestCli(unittest.TestCase):
    """CLI: python -m sr run trace.json prints delivery sequence and
    retransmission count."""

    def test_cli_run(self):
        trace = {
            "window_size": 4,
            "seq_space": 8,
            "timeout": 10,
            "events": TestScenarioAFrameLoss.TRACE,
        }
        with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False
        ) as fh:
            json.dump(trace, fh)
            path = fh.name
        try:
            proc = subprocess.run(
                [sys.executable, "-m", "sr", "run", path],
                capture_output=True, text=True,
                cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            )
        finally:
            os.unlink(path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(result["delivered"], ["f0", "f1", "f2", "f3"])
        self.assertEqual(result["retransmissions"], 1)

    def test_cli_rejects_illegal_params(self):
        with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False
        ) as fh:
            json.dump({"window_size": 5, "seq_space": 8, "events": []}, fh)
            path = fh.name
        try:
            proc = subprocess.run(
                [sys.executable, "-m", "sr", "run", path],
                capture_output=True, text=True,
                cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            )
        finally:
            os.unlink(path)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("ValueError", proc.stderr)


if __name__ == "__main__":
    unittest.main()
