"""Linearizability: enumerate every legal serial history for a small time
domain and a few requests, then check that concurrent interleavings only
ever produce outcomes contained in that serial specification."""
import itertools
import json
import threading
import unittest
from datetime import datetime, timezone

from budget_gate import BudgetGate, GateError, WindowSpec

T0 = int(datetime(2023, 10, 1, 12, 0, tzinfo=timezone.utc).timestamp())
FAR = T0 + 10_000


def make_gate():
    g = BudgetGate()
    g.add_subject("s")
    g.set_quota("s", "r", [WindowSpec(kind="rolling", capacity=5, seconds=3600)])
    return g


def op_reserve_a(g):
    return g.reserve(id="a", subject="s", amount=3, execute_at=T0,
                     confirm_by=FAR, now=T0)


def op_reserve_b(g):
    return g.reserve(id="b", subject="s", amount=3, execute_at=T0,
                     confirm_by=FAR, now=T0)


def op_cancel_a(g):
    return g.cancel(id="a", version=1, now=T0 + 1)


def op_confirm_b(g):
    return g.confirm(id="b", version=1, now=T0 + 1)


# (name, fn, predecessors) -- all four ops are launched concurrently with
# no happens-before edge, so every permutation is a legal serial history
# and the precedence lists are empty.
OPS = [
    ("reserve_a", op_reserve_a, ()),
    ("reserve_b", op_reserve_b, ()),
    ("cancel_a", op_cancel_a, ()),
    ("confirm_b", op_confirm_b, ()),
]


def run_op(fn, g):
    try:
        return ("ok", json.dumps(fn(g), sort_keys=True))
    except GateError as exc:
        return ("error", exc.code)


def snapshot(g):
    res = g.state.reservations
    return (
        g.occupancy_report("s", T0)[0]["occupied"],
        tuple(sorted((i, r.status) for i, r in res.items())),
    )


def serial_outcomes():
    """All (results, final snapshot) pairs reachable by legal serial
    histories of OPS."""
    outcomes = set()
    names = [n for n, _, _ in OPS]
    fns = {n: f for n, f, _ in OPS}
    preds = {n: set(p) for n, _, p in OPS}
    for perm in itertools.permutations(names):
        pos = {n: i for i, n in enumerate(perm)}
        if any(pos[p] > pos[n] for n in names for p in preds[n]):
            continue
        g = make_gate()
        results = tuple(run_op(fns[n], g) for n in perm)
        # Re-index results by op name for order-independent comparison.
        by_name = tuple(sorted(zip(perm, results)))
        outcomes.add((by_name, snapshot(g)))
    return outcomes


class TestSerialEnumeration(unittest.TestCase):
    def test_last_quota_contention_in_every_serial_history(self):
        """Capacity 5, two reserves of 3: exactly one wins in every legal
        serial history, and occupancy never exceeds capacity."""
        for by_name, (occupied, _) in serial_outcomes():
            results = dict(by_name)
            wins = sum(1 for n in ("reserve_a", "reserve_b")
                       if json.loads(results[n][1])["status"] == "reserved")
            # At least one reserve always fits; both fit only when a's hold
            # was cancelled before b reserved.
            self.assertGreaterEqual(wins, 1)
            if wins == 2:
                self.assertEqual(results["cancel_a"][0], "ok")
                self.assertEqual(json.loads(results["cancel_a"][1])["status"],
                                 "cancelled")
            self.assertLessEqual(occupied, 5)
            # Occupancy always equals the sum of active holds.
            active = 0
            if json.loads(results["reserve_a"][1])["status"] == "reserved" \
                    and results["cancel_a"][0] == "error":
                active += 3
            if json.loads(results["reserve_b"][1])["status"] == "reserved":
                active += 3
            self.assertEqual(occupied, active)

    def test_enumeration_is_nontrivial(self):
        # Sanity: the spec contains several distinct outcomes.
        self.assertGreaterEqual(len(serial_outcomes()), 3)


class TestConcurrentInterleavings(unittest.TestCase):
    def test_concurrent_outcomes_are_serializable(self):
        expected = serial_outcomes()
        for _ in range(60):
            g = make_gate()
            barrier = threading.Barrier(len(OPS))
            results = {}

            def worker(name, fn):
                barrier.wait()
                results[name] = run_op(fn, g)

            threads = [threading.Thread(target=worker, args=(n, f))
                       for n, f, _ in OPS]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            by_name = tuple(sorted(results.items()))
            self.assertIn((by_name, snapshot(g)), expected)

    def test_contention_stress_exactly_one_winner(self):
        for _ in range(60):
            g = make_gate()
            barrier = threading.Barrier(2)
            outcomes = []

            def worker(id):
                barrier.wait()
                outcomes.append(g.reserve(id=id, subject="s", amount=3,
                                          execute_at=T0, confirm_by=FAR, now=T0))

            threads = [threading.Thread(target=worker, args=(i,))
                       for i in ("x", "y")]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            wins = [o for o in outcomes if o["status"] == "reserved"]
            losses = [o for o in outcomes if o["status"] == "rejected"]
            self.assertEqual(len(wins), 1)
            self.assertEqual(len(losses), 1)
            self.assertEqual(losses[0]["failures"][0]["occupied"], 3)
            self.assertEqual(g.occupancy_report("s", T0)[0]["occupied"], 3)


if __name__ == "__main__":
    unittest.main()
