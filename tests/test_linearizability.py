"""Linearizability by exhaustive serial-history enumeration.

A tiny time domain and two requests keep the space small enough to
enumerate every legal serial history.  Concurrent executions of the same
operations must then produce an outcome identical to at least one
enumerated serial history (op results + final state).
"""

import itertools
import threading
import unittest
from datetime import datetime, timedelta, timezone

from budgetgate import BudgetGate, GateError

UTC = timezone.utc
BASE = datetime(2026, 1, 1, tzinfo=UTC)


def ts(seconds):
    return (BASE + timedelta(seconds=seconds)).isoformat()


def make_gate():
    config = {
        "timezones": {"utc": "UTC"},
        "nodes": {
            "root": {"windows": [
                {"id": "roll", "kind": "rolling",
                 "duration_seconds": 10, "capacity": 10},
            ]},
            "s": {"parents": ["root"]},
        },
    }
    return BudgetGate(config)


# Operation table: fixed times keep histories comparable.
#   A: amount 6, exec t=5, deadline t=8     B: amount 6, exec t=6, deadline t=9
# Capacity 10 over a 10s rolling window => A and B cannot overlap; whoever
# holds first forces the other out unless it releases.
def op_reserve_a(gate):
    return gate.reserve(request_id="A", subject="s", amount=6,
                        execute_at=ts(5), confirm_deadline=ts(8), now=ts(0))


def op_reserve_b(gate):
    return gate.reserve(request_id="B", subject="s", amount=6,
                        execute_at=ts(6), confirm_deadline=ts(9), now=ts(2))


def op_confirm_a(gate):
    return gate.confirm("A", now=ts(1))


def op_confirm_b(gate):
    return gate.confirm("B", now=ts(3))


def op_cancel_a(gate):
    return gate.cancel("A", now=ts(1))


def op_cancel_b(gate):
    return gate.cancel("B", now=ts(3))


OPS = {
    "rA": op_reserve_a, "rB": op_reserve_b,
    "cA": op_confirm_a, "cB": op_confirm_b,
    "xA": op_cancel_a, "xB": op_cancel_b,
}


def final_state(gate):
    status = gate.status()
    holds = tuple(sorted(
        (rid, h["version"], h["state"]) for rid, h in status["holds"].items()
    ))
    entries = tuple(sorted(
        (name, e["hold_id"], e["version"], e["amount"])
        for name, w in status["windows"].items() for e in w["entries"]
    ))
    return holds, entries


def apply_op(gate, name):
    """Apply one op; a client-level error (e.g. confirming a request whose
    reserve was rejected) is itself a legal, deterministic outcome."""
    try:
        return OPS[name](gate)["status"]
    except GateError:
        return "error"


def run_history(order):
    """Execute a serial history; return its outcome signature."""
    gate = make_gate()
    results = {}
    for name in order:
        results[name] = apply_op(gate, name)
        gate.check_invariants()
    return results, final_state(gate)


def serial_signatures(end_a, end_b):
    """All interleavings of rA/endA/rB/endB respecting per-request order."""
    signatures = {}
    for perm in itertools.permutations(["rA", end_a, "rB", end_b]):
        if perm.index("rA") > perm.index(end_a):
            continue
        if perm.index("rB") > perm.index(end_b):
            continue
        results, state = run_history(perm)
        signatures[(tuple(sorted(results.items())), state)] = perm
    return signatures


class SerialEnumerationTest(unittest.TestCase):
    def test_all_serial_histories_satisfy_invariants(self):
        # run_history asserts invariants after every step; here we also
        # sanity-check the outcome lattice across all 24 serial histories.
        signatures = {}
        for end_a in ("cA", "xA"):
            for end_b in ("cB", "xB"):
                signatures.update(serial_signatures(end_a, end_b))
        self.assertTrue(signatures)
        for (results, (holds, entries)) in signatures:
            live = {rid for rid, _v, state in holds if state in ("held", "confirmed")}
            charged = {}
            for _name, hold_id, _v, amount in entries:
                charged[hold_id] = charged.get(hold_id, 0) + amount
            # Every live hold is charged exactly its amount, exactly once.
            for rid in live:
                self.assertEqual(charged.get(rid), 6)
            # Terminal holds hold no quota.
            for rid, _v, state in holds:
                if state in ("cancelled", "expired"):
                    self.assertNotIn(rid, charged)
            # Capacity 10 can never host both 6-unit holds.
            self.assertLessEqual(sum(charged.values()), 10)

    def test_expiry_linearizes_before_late_confirm(self):
        # rA@0 (deadline t=3); expire@5; confirm@2.  Both orders are legal
        # histories; the outcome is determined by the linearization order.
        def op_expire(gate):
            return {"status": "expired" if gate.run_due_timers(now=ts(5)) else "none"}

        outcomes = {}
        for order in (["rA", "exp", "cA"], ["rA", "cA", "exp"]):
            gate = make_gate()
            results = {}
            for name in order:
                if name == "rA":
                    results[name] = gate.reserve(
                        request_id="A", subject="s", amount=6,
                        execute_at=ts(5), confirm_deadline=ts(3), now=ts(0),
                    )["status"]
                elif name == "exp":
                    results[name] = op_expire(gate)["status"]
                else:
                    results[name] = gate.confirm("A", now=ts(2))["status"]
                gate.check_invariants()
            outcomes[tuple(order)] = results
        self.assertEqual(outcomes[("rA", "exp", "cA")],
                         {"rA": "held", "exp": "expired", "cA": "rejected"})
        self.assertEqual(outcomes[("rA", "cA", "exp")],
                         {"rA": "held", "exp": "none", "cA": "confirmed"})


class ConcurrencyTest(unittest.TestCase):
    def test_concurrent_interleavings_match_some_serial_history(self):
        legal = serial_signatures("cA", "cB")
        # 6 interleavings collapse to 2 distinguishable outcomes:
        # whichever reserve linearizes first wins the last quota.
        self.assertEqual(len(legal), 2)
        for _ in range(100):
            gate = make_gate()
            barrier = threading.Barrier(3)
            results = {}
            errors = []

            def worker(names):
                try:
                    barrier.wait(timeout=10)
                    for name in names:
                        results[name] = apply_op(gate, name)
                except Exception as exc:  # pragma: no cover - failure path
                    errors.append(exc)

            threads = [
                threading.Thread(target=worker, args=(["rA", "cA"],)),
                threading.Thread(target=worker, args=(["rB", "cB"],)),
            ]
            for thread in threads:
                thread.start()
            barrier.wait(timeout=10)
            for thread in threads:
                thread.join(timeout=10)
            self.assertFalse(errors)
            gate.check_invariants()
            signature = (tuple(sorted(results.items())), final_state(gate))
            self.assertIn(signature, legal)

    def test_last_unit_contention_has_exactly_one_winner(self):
        for _ in range(50):
            gate = make_gate()
            barrier = threading.Barrier(3)
            outcomes = []

            def worker(rid):
                barrier.wait(timeout=10)
                outcomes.append(gate.reserve(
                    request_id=rid, subject="s", amount=6,
                    execute_at=ts(5), confirm_deadline=ts(8), now=ts(0),
                )["status"])

            threads = [threading.Thread(target=worker, args=(rid,))
                       for rid in ("A", "B")]
            for thread in threads:
                thread.start()
            barrier.wait(timeout=10)
            for thread in threads:
                thread.join(timeout=10)
            self.assertEqual(sorted(outcomes), ["held", "rejected"])
            gate.check_invariants()


if __name__ == "__main__":
    unittest.main()
