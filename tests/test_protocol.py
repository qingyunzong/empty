import unittest

from nakproto import RANGE_ERR, RETRANSMIT, Receiver, Sender, parse_config, run_simulation


def run(script):
    return run_simulation(parse_config(script))


def delivered_per_tick(result):
    table = {}
    for event in result["trace"]:
        if event["event"] == "DELIVER":
            table.setdefault(event["tick"], []).append(event["seq"])
    return table


class TestScenarioALossAndRecovery(unittest.TestCase):
    """Frame 3 lost: NAK at detection tick, continuous delivery after retx."""

    SCRIPT = {"frames": [1, 2, 3, 4, 5, 6, 7, 8], "loss": [3]}

    # Reference timing table (window=8, debounce=20):
    # tick 0: send 1            -> deliver 1
    # tick 1: send 2            -> deliver 2
    # tick 2: send 3            -> LOST
    # tick 3: send 4, gap found -> buffer 4, NAK(3) -> RETRANSMIT
    # tick 4: send 5, retx 3    -> buffer 5, then deliver 3, 4, 5
    # tick 5: send 6            -> deliver 6
    # tick 6: send 7            -> deliver 7
    # tick 7: send 8            -> deliver 8
    REFERENCE_DELIVERY = {
        0: [1],
        1: [2],
        4: [3, 4, 5],
        5: [6],
        6: [7],
        7: [8],
    }

    def setUp(self):
        self.result = run(self.SCRIPT)

    def test_status_ok_and_full_delivery(self):
        self.assertEqual(self.result["status"], "OK")
        self.assertEqual(self.result["delivered"], [1, 2, 3, 4, 5, 6, 7, 8])

    def test_nak_emitted_at_detection_tick(self):
        self.assertEqual(
            self.result["nak_log"],
            [{"tick": 3, "seq": 3, "response": RETRANSMIT}],
        )

    def test_delivery_matches_reference_timing_table(self):
        self.assertEqual(delivered_per_tick(self.result), self.REFERENCE_DELIVERY)


class TestScenarioBDebounce(unittest.TestCase):
    """Same gap: at most one NAK per 20 ticks."""

    SCRIPT = {"frames": list(range(1, 31)), "loss_permanent": [3]}

    def setUp(self):
        self.result = run(self.SCRIPT)

    def test_single_nak_within_20_ticks(self):
        ticks = [n["tick"] for n in self.result["nak_log"] if n["seq"] == 3]
        self.assertEqual(ticks, [3, 23])
        window = [t for t in ticks if 3 <= t < 23]
        self.assertEqual(len(window), 1)

    def test_nak_spacing_respects_debounce(self):
        ticks = [n["tick"] for n in self.result["nak_log"]]
        for first, second in zip(ticks, ticks[1:]):
            self.assertGreaterEqual(second - first, 20)


class TestScenarioCRangeErr(unittest.TestCase):
    """Lost frame slides out of the window: RANGE_ERR -> FAILED, delivery frozen."""

    SCRIPT = {"frames": list(range(1, 21)), "loss_permanent": [3]}

    def setUp(self):
        self.result = run(self.SCRIPT)

    def test_range_err_then_failed(self):
        self.assertEqual(self.result["status"], "FAILED")
        last = self.result["nak_log"][-1]
        self.assertEqual(last["response"], RANGE_ERR)
        self.assertEqual(last["seq"], 3)
        self.assertEqual(last["tick"], 23)

    def test_delivery_frozen(self):
        self.assertEqual(self.result["delivered"], [1, 2])

    def test_no_delivery_after_failure(self):
        failed_tick = next(
            e["tick"] for e in self.result["trace"] if e["event"] == "FAILED"
        )
        late = [
            e for e in self.result["trace"]
            if e["event"] == "DELIVER" and e["tick"] >= failed_tick
        ]
        self.assertEqual(late, [])


class TestScenarioDReorderNoGap(unittest.TestCase):
    """Out-of-order arrival without a persistent gap: zero NAKs."""

    SCRIPT = {"frames": [1, 2, 3, 4, 5, 6], "delay": {"3": 1}}

    def setUp(self):
        self.result = run(self.SCRIPT)

    def test_zero_naks(self):
        self.assertEqual(self.result["nak_log"], [])

    def test_full_ordered_delivery(self):
        self.assertEqual(self.result["status"], "OK")
        self.assertEqual(self.result["delivered"], [1, 2, 3, 4, 5, 6])

    def test_frame_4_was_buffered_before_3_arrived(self):
        events = [(e["tick"], e["event"], e["seq"]) for e in self.result["trace"]]
        self.assertIn((3, "BUFFER", 4), events)
        self.assertIn((3, "DELIVER", 3), events)
        self.assertIn((3, "DELIVER", 4), events)


class TestSenderSemantics(unittest.TestCase):
    def test_duplicate_nak_does_not_disturb_sender(self):
        sender = Sender(window=8)
        for seq in range(1, 6):
            sender.send(seq)
        snapshot = dict(sender.buffer)
        self.assertEqual(sender.handle_nak(3), RETRANSMIT)
        self.assertEqual(sender.handle_nak(3), RETRANSMIT)
        self.assertEqual(sender.buffer, snapshot)

    def test_ring_buffer_evicts_oldest(self):
        sender = Sender(window=8)
        for seq in range(1, 12):
            sender.send(seq)
        self.assertEqual(sorted(sender.buffer), [4, 5, 6, 7, 8, 9, 10, 11])
        self.assertEqual(sender.handle_nak(3), RANGE_ERR)
        self.assertEqual(sender.handle_nak(4), RETRANSMIT)


class TestReceiverSemantics(unittest.TestCase):
    def test_delivery_strictly_increasing_and_deduplicated(self):
        receiver = Receiver(first_seq=1)
        trace = []
        receiver.on_frame(1, 0, trace)
        receiver.on_frame(1, 0, trace)  # duplicate
        receiver.on_frame(3, 0, trace)  # buffered, gap at 2
        receiver.on_frame(3, 0, trace)  # duplicate of buffered
        receiver.on_frame(2, 0, trace)  # fills gap, drains buffer
        receiver.on_frame(2, 0, trace)  # duplicate
        self.assertEqual(receiver.delivered, [1, 2, 3])

    def test_failed_receiver_ignores_frames(self):
        receiver = Receiver(first_seq=1)
        receiver.failed = True
        receiver.on_frame(1, 0, [])
        self.assertEqual(receiver.delivered, [])


if __name__ == "__main__":
    unittest.main()
