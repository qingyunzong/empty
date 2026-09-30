import unittest

from vclock import ClockError, Handle, VirtualClock
from vclock.protocols import HeartbeatSession, StopWaitARQ


class TestOrdering(unittest.TestCase):
    """Acceptance (a): hand-built mixed event sequence matches the
    paper-enumerated priority table exactly."""

    def test_mixed_sequence_matches_reference(self):
        clock = VirtualClock()
        executed = []

        def make(name):
            return lambda: executed.append((clock.now, name))

        # Registration order is deliberately scrambled vs. execution order.
        clock.schedule(10, 5, make("e7"), name="e7")
        clock.schedule(5, 2, make("e3"), name="e3")
        clock.schedule(5, 1, make("e2"), name="e2")
        clock.schedule(0, 0, make("e1"), name="e1")
        clock.schedule(5, 2, make("e4"), name="e4")  # same tick+prio as e3, later reg
        clock.schedule(10, 1, make("e6"), name="e6")
        clock.schedule(5, 2, make("e5"), name="e5")  # same tick+prio, latest reg

        clock.run_until(20)

        # Reference table (paper enumeration):
        # tick 0: e1 (prio 0)
        # tick 5: prio 1 -> e2; prio 2 -> e3, e4, e5 (registration order)
        # tick 10: prio 1 -> e6; prio 5 -> e7
        expected = [
            (0, "e1"),
            (5, "e2"),
            (5, "e3"),
            (5, "e4"),
            (5, "e5"),
            (10, "e6"),
            (10, "e7"),
        ]
        self.assertEqual(executed, expected)
        self.assertEqual(clock.now, 20)


class TestSameTickSpawn(unittest.TestCase):
    """Acceptance (b): a callback registering a same-tick event sees it
    executed within the current tick."""

    def test_spawn_same_tick_runs_in_tick(self):
        clock = VirtualClock()
        executed = []

        def parent():
            executed.append(("parent", clock.now))
            clock.schedule(7, 0, child, name="child")
            clock.schedule(7, 9, late_child, name="late_child")

        def child():
            executed.append(("child", clock.now))

        def late_child():
            executed.append(("late_child", clock.now))

        clock.schedule(7, 5, parent, name="parent")
        clock.schedule(8, 0, lambda: executed.append(("next", clock.now)))
        clock.run_until(100)

        # Both children ran at tick 7, before the tick-8 event; the child
        # with lower prio ran first despite being registered second.
        self.assertEqual(
            executed,
            [("parent", 7), ("child", 7), ("late_child", 7), ("next", 8)],
        )

    def test_spawn_chain_same_tick(self):
        clock = VirtualClock()
        executed = []

        def spawn(depth):
            def cb():
                executed.append((depth, clock.now))
                if depth < 3:
                    clock.schedule(3, 0, spawn(depth + 1))
            return cb

        clock.schedule(3, 0, spawn(0))
        clock.run_until(10)
        self.assertEqual(executed, [(0, 3), (1, 3), (2, 3), (3, 3)])


class TestCancel(unittest.TestCase):
    """Acceptance (d): cancel of an already-fired handle returns False."""

    def test_cancel_pending_event(self):
        clock = VirtualClock()
        fired = []
        handle = clock.schedule(5, 0, lambda: fired.append("x"))
        self.assertTrue(clock.cancel(handle))
        clock.run_until(10)
        self.assertEqual(fired, [])

    def test_cancel_executed_event_returns_false(self):
        clock = VirtualClock()
        fired = []
        handle = clock.schedule(5, 0, lambda: fired.append("x"))
        clock.run_until(10)
        self.assertEqual(fired, ["x"])
        self.assertFalse(clock.cancel(handle))

    def test_cancel_unknown_handle_returns_false_no_raise(self):
        clock = VirtualClock()
        self.assertFalse(clock.cancel(Handle(9999)))
        other = VirtualClock()
        foreign = other.schedule(1, 0, lambda: None)
        self.assertFalse(clock.cancel(foreign))

    def test_cancel_inside_callback(self):
        clock = VirtualClock()
        fired = []
        victim = clock.schedule(5, 1, lambda: fired.append("victim"))
        clock.schedule(5, 0, lambda: fired.append(clock.cancel(victim)))
        clock.run_until(10)
        self.assertEqual(fired, [True])


class TestClockMonotonic(unittest.TestCase):
    def test_schedule_past_raises_clock_error(self):
        clock = VirtualClock()
        clock.run_until(10)
        with self.assertRaises(ClockError):
            clock.schedule(9, 0, lambda: None)

    def test_schedule_now_allowed(self):
        clock = VirtualClock()
        clock.run_until(10)
        fired = []
        clock.schedule(10, 0, lambda: fired.append(clock.now))
        clock.run_until(10)
        self.assertEqual(fired, [10])

    def test_run_until_past_raises_clock_error(self):
        clock = VirtualClock()
        clock.run_until(10)
        with self.assertRaises(ClockError):
            clock.run_until(5)

    def test_clock_only_increases(self):
        clock = VirtualClock()
        clock.run_until(5)
        self.assertEqual(clock.now, 5)
        clock.run_until(5)
        self.assertEqual(clock.now, 5)
        clock.run_until(42)
        self.assertEqual(clock.now, 42)


class TestHeartbeatAndARQ(unittest.TestCase):
    """Acceptance (c): heartbeat losing PONGs goes DEAD at tick 60 while
    the ARQ session on the same clock completes normally."""

    def test_heartbeat_dead_arq_done(self):
        clock = VirtualClock()
        hb = HeartbeatSession(clock, name="hb", peer_responds=False)
        arq = StopWaitARQ(clock, name="arq", ack_delay=4, timeout=10)

        clock.schedule(0, 0, hb.start, name="hb:start")
        clock.schedule(0, 0, lambda: [arq.send(m) for m in ("m1", "m2", "m3")],
                       name="arq:start")
        clock.run_until(200)

        self.assertEqual(hb.state, HeartbeatSession.DEAD)
        self.assertEqual(arq.state, StopWaitARQ.DONE)

        dead_entries = [e for e in clock.trace if e.get("kind") == "DEAD"]
        self.assertEqual(len(dead_entries), 1)
        self.assertEqual(dead_entries[0]["tick"], 60)

        done_entries = [e for e in clock.trace
                        if e.get("kind") == "DONE" and e.get("session") == "arq"]
        self.assertEqual(len(done_entries), 1)
        # 3 packets, ack_delay 4 -> DONE at tick 12.
        self.assertEqual(done_entries[0]["tick"], 12)

    def test_heartbeat_alive_when_pongs_arrive(self):
        clock = VirtualClock()
        hb = HeartbeatSession(clock, name="hb", peer_responds=True)
        clock.schedule(0, 0, hb.start, name="hb:start")
        clock.run_until(200)
        self.assertEqual(hb.state, HeartbeatSession.ALIVE)
        pings = [e for e in clock.trace if e.get("kind") == "PING"]
        self.assertEqual([e["tick"] for e in pings],
                         [0, 30, 60, 90, 120, 150, 180])

    def test_arq_retransmits_on_loss(self):
        clock = VirtualClock()
        arq = StopWaitARQ(clock, name="arq", ack_delay=4, timeout=10,
                          max_retries=2, loss={1})
        clock.schedule(0, 0, lambda: arq.send("m1"), name="arq:start")
        clock.run_until(100)
        self.assertEqual(arq.state, StopWaitARQ.DONE)
        kinds = [e["kind"] for e in clock.trace if e.get("session") == "arq"]
        self.assertEqual(kinds, ["SEND", "RETRANSMIT", "SEND", "ACK", "DONE"])

    def test_arq_failed_does_not_affect_heartbeat(self):
        clock = VirtualClock()
        arq = StopWaitARQ(clock, name="arq", ack_delay=4, timeout=10,
                          max_retries=1, loss={1, 2})
        hb = HeartbeatSession(clock, name="hb", peer_responds=True)
        clock.schedule(0, 0, lambda: arq.send("m1"), name="arq:start")
        clock.schedule(0, 0, hb.start, name="hb:start")
        clock.run_until(200)
        self.assertEqual(arq.state, StopWaitARQ.FAILED)
        self.assertEqual(hb.state, HeartbeatSession.ALIVE)


if __name__ == "__main__":
    unittest.main()
