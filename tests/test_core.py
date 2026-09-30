"""Acceptance tests for the discrete-event core (VirtualClock)."""

import unittest

from vclock import ClockError, Handle, VirtualClock


class TestOrdering(unittest.TestCase):
    """(a) Mixed event sequence must match the paper reference table exactly."""

    def test_mixed_sequence_matches_reference(self):
        clock = VirtualClock()
        fired = []

        def mk(name):
            return lambda: fired.append((clock.now, name))

        # Registration order (deliberately scrambled vs. execution order):
        clock.schedule(5, 1, mk("e1"))
        clock.schedule(5, 0, mk("e2"))
        clock.schedule(5, 1, mk("e3"))
        clock.schedule(3, 9, mk("e0"))
        clock.schedule(5, 0, mk("e4"))
        clock.schedule(2, 0, mk("e-1"))
        clock.schedule(7, 0, mk("e5"))

        clock.run_until(10)

        # Paper reference enumeration:
        #   tick 2: e-1
        #   tick 3: e0
        #   tick 5, prio 0 (registration order): e2, e4
        #   tick 5, prio 1 (registration order): e1, e3
        #   tick 7: e5
        expected = [
            (2, "e-1"),
            (3, "e0"),
            (5, "e2"),
            (5, "e4"),
            (5, "e1"),
            (5, "e3"),
            (7, "e5"),
        ]
        self.assertEqual(fired, expected)
        self.assertEqual(clock.now, 10)

    def test_same_prio_fifo_across_many_events(self):
        clock = VirtualClock()
        fired = []
        for i in range(50):
            clock.schedule(4, 3, lambda i=i: fired.append(i))
        clock.run_until(4)
        self.assertEqual(fired, list(range(50)))


class TestSameTickScheduling(unittest.TestCase):
    """(b) A callback may register same-tick events; they run within the tick."""

    def test_spawned_same_tick_event_runs_in_same_tick(self):
        clock = VirtualClock()
        fired = []

        def parent():
            fired.append(("parent", clock.now))
            # Register a new event for *this* tick from inside a callback.
            clock.schedule(clock.now, 9, child)

        def child():
            fired.append(("child", clock.now))

        clock.schedule(10, 0, parent)
        clock.run_until(10)

        self.assertEqual(fired, [("parent", 10), ("child", 10)])
        self.assertEqual(clock.now, 10)

    def test_spawned_same_tick_respects_prio(self):
        clock = VirtualClock()
        fired = []
        clock.schedule(1, 5, lambda: fired.append("low-prio-existing"))

        def spawner():
            fired.append("spawner")
            clock.schedule(1, 0, lambda: fired.append("spawned-prio0"))

        clock.schedule(1, 2, spawner)
        clock.run_until(1)
        # spawned prio-0 event jumps ahead of the pre-existing prio-5 event
        self.assertEqual(
            fired, ["spawner", "spawned-prio0", "low-prio-existing"])

    def test_spawn_chain_within_one_tick(self):
        clock = VirtualClock()
        fired = []

        def step(n):
            fired.append(n)
            if n < 3:
                clock.schedule(clock.now, 0, lambda: step(n + 1))

        clock.schedule(7, 0, lambda: step(0))
        clock.run_until(7)
        self.assertEqual(fired, [0, 1, 2, 3])


class TestCancel(unittest.TestCase):
    """(c/d) cancel semantics: True for pending, False otherwise, never raises."""

    def test_cancel_pending_returns_true_and_skips(self):
        clock = VirtualClock()
        fired = []
        h = clock.schedule(5, 0, lambda: fired.append("x"))
        self.assertTrue(clock.cancel(h))
        clock.run_until(10)
        self.assertEqual(fired, [])

    def test_cancel_executed_returns_false(self):
        clock = VirtualClock()
        h = clock.schedule(5, 0, lambda: None)
        clock.run_until(5)
        self.assertFalse(clock.cancel(h))  # already executed -> False, no raise

    def test_cancel_unknown_handle_returns_false(self):
        clock = VirtualClock()
        foreign = Handle(id=999999)
        self.assertFalse(clock.cancel(foreign))
        self.assertFalse(clock.cancel(None))
        self.assertFalse(clock.cancel("not-a-handle"))

    def test_double_cancel_returns_false(self):
        clock = VirtualClock()
        h = clock.schedule(5, 0, lambda: None)
        self.assertTrue(clock.cancel(h))
        self.assertFalse(clock.cancel(h))

    def test_cancel_does_not_disturb_other_events(self):
        clock = VirtualClock()
        fired = []
        h1 = clock.schedule(5, 0, lambda: fired.append("a"))
        clock.schedule(5, 0, lambda: fired.append("b"))
        clock.cancel(h1)
        clock.run_until(5)
        self.assertEqual(fired, ["b"])


class TestClockMonotonicity(unittest.TestCase):
    """(4) Clock only increases; scheduling in the past raises ClockError."""

    def test_schedule_past_raises(self):
        clock = VirtualClock()
        clock.run_until(10)
        with self.assertRaises(ClockError):
            clock.schedule(9, 0, lambda: None)

    def test_schedule_now_is_allowed(self):
        clock = VirtualClock()
        clock.run_until(10)
        fired = []
        clock.schedule(10, 0, lambda: fired.append(clock.now))
        clock.run_until(10)
        self.assertEqual(fired, [10])

    def test_run_until_backwards_raises(self):
        clock = VirtualClock()
        clock.run_until(10)
        with self.assertRaises(ClockError):
            clock.run_until(5)

    def test_clock_never_decreases(self):
        clock = VirtualClock()
        seen = []
        for t in (3, 6, 9):
            clock.schedule(t, 0, lambda: seen.append(clock.now))
        clock.run_until(20)
        self.assertEqual(seen, [3, 6, 9])
        self.assertEqual(clock.now, 20)

    def test_invalid_tick_type_raises(self):
        clock = VirtualClock()
        with self.assertRaises(ClockError):
            clock.schedule(1.5, 0, lambda: None)
        with self.assertRaises(ClockError):
            clock.schedule(True, 0, lambda: None)


if __name__ == "__main__":
    unittest.main()
