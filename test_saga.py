"""Acceptance tests for the supplier selection saga."""

import json
import os
import subprocess
import sys
import tempfile
import unittest

import saga

HERE = os.path.dirname(os.path.abspath(__file__))
SAGA_PY = os.path.join(HERE, "saga.py")


def make_suppliers(**overrides):
    """Three suppliers; C cheapest, A and B tied on price (A < B by id)."""
    base = [
        {"id": "B", "price": 20, "latency": 5,
         "quote_fails": False, "reserve_fails": False},
        {"id": "A", "price": 20, "latency": 1,
         "quote_fails": False, "reserve_fails": False},
        {"id": "C", "price": 10, "latency": 9,
         "quote_fails": False, "reserve_fails": False},
    ]
    for s in base:
        s.update(overrides.get(s["id"], {}))
    return base


def fresh_db(suppliers):
    return saga.new_saga("test-saga", suppliers)


def trace_pairs(db):
    return [(t["event"], t["status"]) for t in db["trace"]]


class CandidateEnumerationTests(unittest.TestCase):
    """Reference candidate enumeration + expected state per event."""

    def test_reference_candidates_and_per_event_states(self):
        db = fresh_db(make_suppliers())
        saga.advance(db)

        # Reference enumeration: usable quotes sorted by (price, id).
        self.assertEqual([s["id"] for s in saga.candidates(db)],
                         ["C", "A", "B"])

        # Expected (event, status) pairs for the whole run.
        self.assertEqual(trace_pairs(db), [
            ("quote:B", "QUOTING"),
            ("quote:A", "QUOTING"),
            ("quote:C", "QUOTING"),
            ("state:RESERVING", "RESERVING"),
            ("reserve:C", "RESERVING"),
            ("state:COMPLETED", "COMPLETED"),
        ])
        self.assertEqual(db["status"], "COMPLETED")
        self.assertEqual(db["final_supplier"], "C")

    def test_tie_price_selects_smallest_id(self):
        suppliers = make_suppliers(C={"quote_fails": True})
        db = fresh_db(suppliers)
        saga.advance(db)
        # A and B tie on price 20; the smaller id wins.
        self.assertEqual([s["id"] for s in saga.candidates(db)], ["A", "B"])
        self.assertEqual(db["status"], "COMPLETED")
        self.assertEqual(db["final_supplier"], "A")
        self.assertNotIn("reserve:B", db["journal"])


class ReservationTests(unittest.TestCase):
    def test_reserve_failure_falls_back_to_next_candidate(self):
        suppliers = make_suppliers(C={"reserve_fails": True})
        db = fresh_db(suppliers)
        saga.advance(db)
        self.assertEqual(db["status"], "COMPLETED")
        self.assertEqual(db["final_supplier"], "A")
        # First candidate attempted, then fallback to the second.
        reserves = [e for e in db["journal"] if e.startswith("reserve:")]
        self.assertEqual(reserves, ["reserve:C", "reserve:A"])
        self.assertEqual(db["reserved"], ["A"])

    def test_all_quotes_fail(self):
        suppliers = make_suppliers(
            A={"quote_fails": True},
            B={"quote_fails": True},
            C={"quote_fails": True},
        )
        db = fresh_db(suppliers)
        saga.advance(db)
        self.assertEqual(db["status"], "FAILED")
        self.assertIsNone(db["final_supplier"])
        self.assertEqual(db["reserved"], [])
        self.assertFalse(any(e.startswith("reserve:") for e in db["journal"]))

    def test_all_reserves_fail(self):
        suppliers = make_suppliers(
            A={"reserve_fails": True},
            B={"reserve_fails": True},
            C={"reserve_fails": True},
        )
        db = fresh_db(suppliers)
        saga.advance(db)
        self.assertEqual(db["status"], "FAILED")
        self.assertEqual(db["reserved"], [])
        reserves = [e for e in db["journal"] if e.startswith("reserve:")]
        self.assertEqual(reserves, ["reserve:C", "reserve:A", "reserve:B"])


class CancellationTests(unittest.TestCase):
    def test_cancel_during_quoting_reserves_nothing(self):
        db = fresh_db(make_suppliers())
        with self.assertRaises(saga.Crash):
            saga.advance(db, crash_at="quote:C")
        db["crashed"] = True
        self.assertEqual(db["status"], "QUOTING")

        db["cancel_requested"] = True
        saga.advance(db)

        self.assertEqual(db["status"], "CANCELED")
        self.assertIsNone(db["final_supplier"])
        self.assertEqual(db["reserved"], [])
        self.assertEqual(db["released"], [])
        # No reservation was ever attempted.
        self.assertFalse(any(e.startswith("reserve:") for e in db["journal"]))
        # Remaining quotes after the cancel point were never issued.
        self.assertNotIn("quote:C", db["journal"])

    def test_cancel_after_reserve_compensates(self):
        db = fresh_db(make_suppliers())
        saga.advance(db)
        self.assertEqual(db["status"], "COMPLETED")
        self.assertEqual(db["reserved"], ["C"])

        db["cancel_requested"] = True
        saga.advance(db)

        self.assertEqual(db["status"], "CANCELED")
        self.assertIsNone(db["final_supplier"])
        self.assertEqual(db["reserved"], [])
        self.assertEqual(db["released"], ["C"])
        self.assertIn("release:C", db["journal"])
        # Trace shows the compensation path.
        self.assertIn(("state:CANCELING", "CANCELING"), trace_pairs(db))
        self.assertIn(("release:C", "CANCELING"), trace_pairs(db))
        self.assertEqual(trace_pairs(db)[-1], ("state:CANCELED", "CANCELED"))


class CrashRecoveryTests(unittest.TestCase):
    def test_crash_after_quote_event_then_recover(self):
        db = fresh_db(make_suppliers())
        with self.assertRaises(saga.Crash) as ctx:
            saga.advance(db, crash_at="quote:B")
        self.assertEqual(ctx.exception.event, "quote:B")
        db["crashed"] = True
        self.assertEqual(db["status"], "QUOTING")
        # Side effect durable, journal commit lost.
        self.assertNotIn("quote:B", db["journal"])
        quote_b_key = "quote:test-saga:B"
        self.assertIn(quote_b_key, db["ledger"])

        saga.advance(db)  # recover
        self.assertEqual(db["status"], "COMPLETED")
        self.assertEqual(db["final_supplier"], "C")
        # Idempotency: every request key executed its side effect exactly once.
        for key, count in db["calls"].items():
            self.assertEqual(count, 1, "duplicate side effect for %s" % key)
        self.assertEqual(db["calls"][quote_b_key], 1)

    def test_crash_after_reserve_event_then_recover(self):
        db = fresh_db(make_suppliers())
        with self.assertRaises(saga.Crash) as ctx:
            saga.advance(db, crash_at="reserve:C")
        self.assertEqual(ctx.exception.event, "reserve:C")
        db["crashed"] = True
        self.assertEqual(db["status"], "RESERVING")
        self.assertNotIn("reserve:C", db["journal"])
        reserve_c_key = "reserve:test-saga:C"
        self.assertIn(reserve_c_key, db["ledger"])

        saga.advance(db)  # recover
        self.assertEqual(db["status"], "COMPLETED")
        self.assertEqual(db["final_supplier"], "C")
        self.assertEqual(db["reserved"], ["C"])
        for key, count in db["calls"].items():
            self.assertEqual(count, 1, "duplicate side effect for %s" % key)
        self.assertEqual(db["calls"][reserve_c_key], 1)

    def test_recover_is_idempotent_when_nothing_crashed(self):
        db = fresh_db(make_suppliers())
        saga.advance(db)
        journal_before = list(db["journal"])
        saga.advance(db)  # recover on a finished saga is a no-op
        self.assertEqual(db["journal"], journal_before)
        self.assertEqual(db["status"], "COMPLETED")


class CliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = os.path.join(self.tmp.name, "state.json")
        self.suppliers_path = os.path.join(self.tmp.name, "suppliers.json")
        with open(self.suppliers_path, "w", encoding="utf-8") as fh:
            json.dump(make_suppliers(C={"reserve_fails": True}), fh)

    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, SAGA_PY, "--db", self.db, *args],
            capture_output=True, text=True)

    def test_run_and_state(self):
        proc = self.run_cli("run", "--suppliers", self.suppliers_path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "COMPLETED")
        self.assertEqual(out["final_supplier"], "A")  # C reserve failed

        proc = self.run_cli("state")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "COMPLETED")
        self.assertEqual(out["candidates"], ["C", "A", "B"])

    def test_crash_recover_cancel_via_cli(self):
        # Crash during quoting.
        proc = self.run_cli("crash", "--at", "quote:A",
                            "--suppliers", self.suppliers_path)
        self.assertEqual(proc.returncode, 1, proc.stderr)
        proc = self.run_cli("state")
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "QUOTING")
        self.assertTrue(out["crashed"])

        # Recover drives to completion with fallback C -> A.
        proc = self.run_cli("recover")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "COMPLETED")
        self.assertEqual(out["final_supplier"], "A")
        # Idempotent side effects across the crash.
        self.assertTrue(all(c == 1 for c in out["calls"].values()))

        # Cancel after completion compensates the reserved supplier.
        proc = self.run_cli("cancel")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "CANCELED")
        self.assertEqual(out["released"], ["A"])
        self.assertEqual(out["reserved"], [])
        self.assertIsNone(out["final_supplier"])


if __name__ == "__main__":
    unittest.main()
