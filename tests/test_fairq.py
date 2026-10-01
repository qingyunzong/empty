"""Acceptance tests A (alternation), B (weighted ratio), C (no preemption)."""

import unittest

from fairq import simulate


def submit(t, flow, size, prio):
    return {"type": "submit", "t": t, "flow": flow, "size": size, "prio": prio}


def tick(t):
    return {"type": "tick", "t": t}


def service_sequence(result):
    return [(s["t"], s["flow"], s["units"]) for s in result["service"]]


def finishes(result):
    return {f["flow"]: f["finish_t"] for f in result["flows"]}


class TestAEqualWeightAlternation(unittest.TestCase):
    """Two equal-weight flows must alternate exactly under capacity 1."""

    def test_exact_service_sequence(self):
        events = [submit(0, 1, 3, 1), submit(0, 2, 3, 1)]
        events += [tick(t) for t in range(1, 7)]
        result, _ = simulate(events)
        self.assertEqual(
            service_sequence(result),
            [(1, 1, 1), (2, 2, 1), (3, 1, 1), (4, 2, 1), (5, 1, 1), (6, 2, 1)],
        )
        self.assertEqual(finishes(result), {1: 5, 2: 6})
        self.assertEqual(result["starved"], [])


class TestBWeightedRatio(unittest.TestCase):
    """prio 3 vs prio 1 under capacity 1 must converge to a 3:1 service ratio."""

    @classmethod
    def setUpClass(cls):
        events = [submit(0, 1, 100, 3), submit(0, 2, 100, 1)]
        events += [tick(t) for t in range(1, 21)]
        cls.result, _ = simulate(events)

    def counts(self, lo, hi):
        tally = {1: 0, 2: 0}
        for s in self.result["service"]:
            if lo <= s["t"] <= hi:
                tally[s["flow"]] += s["units"]
        return tally

    def test_first_ten_ticks_best_integer_ratio(self):
        # 10 unit slots cannot express 3:1 exactly (7.5:2.5); weighted DRF
        # yields the deterministic 7:3 approximation.
        self.assertEqual(self.counts(1, 10), {1: 7, 2: 3})

    def test_every_aligned_four_tick_window_is_exactly_3_to_1(self):
        for start in (1, 5, 9, 13, 17):
            self.assertEqual(self.counts(start, start + 3), {1: 3, 2: 1})

    def test_twenty_ticks_exact_ratio(self):
        tally = self.counts(1, 20)
        self.assertEqual(tally, {1: 15, 2: 5})
        self.assertEqual(tally[1] / tally[2], 3.0)


class TestCNoImmediatePreemption(unittest.TestCase):
    """A high-prio arrival does not preempt the current tick, only the next."""

    def test_switch_happens_next_tick(self):
        events = [submit(0, 1, 10, 1)]
        events += [tick(t) for t in range(1, 5)]
        events.append(submit(5, 2, 2, 5))  # same t as the tick at t=5
        events += [tick(t) for t in range(5, 11)]
        result, _ = simulate(events)
        seq = service_sequence(result)
        by_t = {t: flow for t, flow, _ in seq}
        # tick t=5: flow 2 is not eligible yet, flow 1 keeps the tick.
        self.assertEqual(by_t[5], 1)
        # next tick the scheduler switches to the new (deficit-minimal) flow.
        self.assertEqual(by_t[6], 2)
        self.assertEqual(by_t[7], 2)
        self.assertEqual(by_t[8], 1)
        self.assertEqual(finishes(result)[2], 7)


if __name__ == "__main__":
    unittest.main()
