"""Acceptance tests for protocol sessions on top of the core."""

import unittest

from vclock import HeartbeatSession, StopAndWaitARQ, VirtualClock


def make_trace(sink):
    def trace(**fields):
        sink.append(fields)
    return trace


class TestHeartbeat(unittest.TestCase):
    """(c, part 1) Lost PONGs -> DEAD exactly `timeout` ticks after the PING."""

    def test_dead_after_60_ticks_without_pong(self):
        clock = VirtualClock()
        log = []
        hb = HeartbeatSession(clock, "hb", make_trace(log),
                              interval=30, timeout=60, pong_delay=None)
        clock.schedule(0, 0, hb.start)
        clock.run_until(200)

        self.assertEqual(hb.state, HeartbeatSession.DEAD)
        # First PING at tick 0, no PONG -> DEAD at tick 0 + 60.
        self.assertEqual(hb.dead_tick, 60)
        state_events = [e for e in log if e["kind"] == "state"]
        self.assertEqual(len(state_events), 1)
        self.assertEqual(state_events[0]["state"], "DEAD")
        self.assertEqual(state_events[0]["tick"], 60)
        # PINGs at 0 and 30 only; none after DEAD.
        pings = [e["tick"] for e in log if e["kind"] == "ping"]
        self.assertEqual(pings, [0, 30])

    def test_alive_with_pongs(self):
        clock = VirtualClock()
        log = []
        hb = HeartbeatSession(clock, "hb", make_trace(log),
                              interval=30, timeout=60, pong_delay=5)
        clock.schedule(0, 0, hb.start)
        clock.run_until(200)
        self.assertEqual(hb.state, HeartbeatSession.ALIVE)
        pings = [e["tick"] for e in log if e["kind"] == "ping"]
        pongs = [e["tick"] for e in log if e["kind"] == "pong"]
        self.assertEqual(pings, list(range(0, 200, 30)))
        self.assertEqual(pongs, [t + 5 for t in pings])
        self.assertFalse(any(e["kind"] == "state" for e in log))

    def test_late_pong_after_death_is_ignored(self):
        clock = VirtualClock()
        log = []
        # PONG arrives at tick 61 > deadline 60: session must stay DEAD.
        hb = HeartbeatSession(clock, "hb", make_trace(log),
                              interval=30, timeout=60, pong_delay=61)
        clock.schedule(0, 0, hb.start)
        clock.run_until(200)
        self.assertEqual(hb.state, HeartbeatSession.DEAD)
        self.assertEqual(hb.dead_tick, 60)


class TestStopAndWaitARQ(unittest.TestCase):
    def test_completes_all_packets(self):
        clock = VirtualClock()
        log = []
        arq = StopAndWaitARQ(clock, "arq", make_trace(log),
                             num_packets=3, timeout=10, ack_delay=2)
        clock.schedule(0, 0, arq.start)
        clock.run_until(100)
        self.assertEqual(arq.state, StopAndWaitARQ.DONE)
        sends = [(e["packet"], e["tick"]) for e in log if e["kind"] == "send"]
        acks = [(e["packet"], e["tick"]) for e in log if e["kind"] == "ack"]
        self.assertEqual(sends, [(0, 0), (1, 2), (2, 4)])
        self.assertEqual(acks, [(0, 2), (1, 4), (2, 6)])
        self.assertEqual(arq.done_tick, 6)

    def test_retransmits_on_ack_loss(self):
        clock = VirtualClock()
        log = []
        arq = StopAndWaitARQ(clock, "arq", make_trace(log),
                             num_packets=1, timeout=10, max_retries=3,
                             ack_delay=2, ack_loss=2)
        clock.schedule(0, 0, arq.start)
        clock.run_until(100)
        self.assertEqual(arq.state, StopAndWaitARQ.DONE)
        sends = [e["tick"] for e in log if e["kind"] == "send"]
        # t=0 (ACK lost), t=10 (ACK lost), t=20 (ACKed at 22)
        self.assertEqual(sends, [0, 10, 20])
        timeouts = [e["tick"] for e in log if e["kind"] == "timeout"]
        self.assertEqual(timeouts, [10, 20])

    def test_fails_after_max_retries(self):
        clock = VirtualClock()
        log = []
        arq = StopAndWaitARQ(clock, "arq", make_trace(log),
                             num_packets=1, timeout=10, max_retries=2,
                             ack_delay=None)
        clock.schedule(0, 0, arq.start)
        clock.run_until(100)
        self.assertEqual(arq.state, StopAndWaitARQ.FAILED)
        sends = [e["tick"] for e in log if e["kind"] == "send"]
        self.assertEqual(sends, [0, 10, 20])  # 1 initial + 2 retries
        self.assertEqual(arq.failed_tick, 30)


class TestSessionIsolation(unittest.TestCase):
    """(c/e) Heartbeat goes DEAD while ARQ completes; states fully isolated."""

    def test_dead_heartbeat_does_not_affect_arq(self):
        clock = VirtualClock()
        log = []
        hb = HeartbeatSession(clock, "hb", make_trace(log),
                              interval=30, timeout=60, pong_delay=None)
        arq = StopAndWaitARQ(clock, "arq", make_trace(log),
                             num_packets=3, timeout=10, ack_delay=2)
        clock.schedule(0, 0, hb.start)
        clock.schedule(0, 0, arq.start)
        clock.run_until(200)

        self.assertEqual(hb.state, HeartbeatSession.DEAD)
        self.assertEqual(hb.dead_tick, 60)
        self.assertEqual(arq.state, StopAndWaitARQ.DONE)
        self.assertEqual(arq.done_tick, 6)

        hb_events = [e for e in log if e.get("session") == "hb"]
        arq_events = [e for e in log if e.get("session") == "arq"]
        self.assertTrue(all(e["session"] == "hb" for e in hb_events))
        self.assertTrue(all(e["session"] == "arq" for e in arq_events))
        # ARQ completed long before the heartbeat died: no interference.
        self.assertLess(arq.done_tick, hb.dead_tick)

    def test_failed_arq_does_not_affect_heartbeat(self):
        clock = VirtualClock()
        log = []
        hb = HeartbeatSession(clock, "hb", make_trace(log),
                              interval=30, timeout=60, pong_delay=5)
        arq = StopAndWaitARQ(clock, "arq", make_trace(log),
                             num_packets=1, timeout=10, max_retries=1,
                             ack_delay=None)
        clock.schedule(0, 0, hb.start)
        clock.schedule(0, 0, arq.start)
        clock.run_until(200)
        self.assertEqual(arq.state, StopAndWaitARQ.FAILED)
        self.assertEqual(arq.failed_tick, 20)
        self.assertEqual(hb.state, HeartbeatSession.ALIVE)


if __name__ == "__main__":
    unittest.main()
