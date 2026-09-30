"""Acceptance tests for the supplier selection saga."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

import supplier_saga


def supplier(sid, price, latency=1, quote_failed=False, reserve_failed=False):
    return {
        "id": sid,
        "price": price,
        "latency": latency,
        "quote_failed": quote_failed,
        "reserve_failed": reserve_failed,
    }


def reference_candidates(suppliers):
    """Independent reference enumeration: usable quotes by (price, id)."""
    usable = [s for s in suppliers if not s["quote_failed"]]
    usable.sort(key=lambda s: (s["price"], s["id"]))
    return [s["id"] for s in usable]


def drive(db, crash_at=None):
    """Advance the db, tolerating a simulated crash."""
    try:
        supplier_saga.advance(db, crash_at)
    except supplier_saga.CrashPointReached:
        pass
    return db


def cancel(db):
    if not supplier_saga.cancel_requested(db):
        supplier_saga.append_event(db, {"type": "cancel_requested"})
    return drive(db)


class SagaTestCase(unittest.TestCase):
    def assert_idempotent(self, db):
        self.assertEqual(
            len(db["requests"]), len(set(db["requests"])),
            "duplicate request keys: %r" % db["requests"])
        quote_events = [e for e in db["events"] if e["type"] == "quote"]
        self.assertEqual(
            len(quote_events), len({e["id"] for e in quote_events}),
            "duplicate quote events journaled")

    def test_tie_price_chooses_smallest_id(self):
        suppliers = [
            supplier("s3", 100),
            supplier("s1", 100),
            supplier("s2", 100),
        ]
        db = drive(supplier_saga.new_db(suppliers))
        self.assertEqual(supplier_saga.candidates(db), reference_candidates(suppliers))
        self.assertEqual(supplier_saga.candidates(db), ["s1", "s2", "s3"])
        self.assertEqual(db["state"], "COMPLETED")
        self.assertEqual(db["chosen"], "s1")

    def test_candidates_sorted_by_price_then_id(self):
        suppliers = [
            supplier("b", 50),
            supplier("a", 50),
            supplier("c", 10),
            supplier("d", 1, quote_failed=True),
        ]
        db = drive(supplier_saga.new_db(suppliers))
        self.assertEqual(supplier_saga.candidates(db), reference_candidates(suppliers))
        self.assertEqual(supplier_saga.candidates(db), ["c", "a", "b"])
        self.assertEqual(db["chosen"], "c")

    def test_reserve_failure_falls_back_to_next_candidate(self):
        suppliers = [
            supplier("s1", 10, reserve_failed=True),
            supplier("s2", 20),
            supplier("s3", 30),
        ]
        db = drive(supplier_saga.new_db(suppliers))
        self.assertEqual(supplier_saga.candidates(db), reference_candidates(suppliers))
        self.assertEqual(db["state"], "COMPLETED")
        self.assertEqual(db["chosen"], "s2")
        keys = [supplier_saga.event_key(e) for e in db["events"]]
        self.assertLess(keys.index("reserve_fail:s1"), keys.index("reserve:s2"))
        self.assertNotIn("reserve:s3", keys)
        self.assertNotIn("reserve_fail:s3", keys)

    def test_all_candidates_reserve_failure_fails(self):
        suppliers = [
            supplier("s1", 10, reserve_failed=True),
            supplier("s2", 20, reserve_failed=True),
        ]
        db = drive(supplier_saga.new_db(suppliers))
        self.assertEqual(db["state"], "FAILED")
        self.assertIsNone(db["chosen"])

    def test_cancel_during_quote_collection_reserves_nothing(self):
        suppliers = [supplier("s1", 10, latency=1), supplier("s2", 20, latency=2)]
        db = drive(supplier_saga.new_db(suppliers), crash_at="quote:s1")
        self.assertEqual(db["state"], "QUOTING")
        cancel(db)
        self.assertEqual(db["state"], "CANCELED")
        self.assertIsNone(db["chosen"])
        self.assertFalse(any(k.startswith("reserve:") for k in db["requests"]))
        self.assertFalse(any(e["type"].startswith("reserve") for e in db["events"]))

    def test_cancel_before_run_reserves_nothing(self):
        suppliers = [supplier("s1", 10), supplier("s2", 20)]
        db = supplier_saga.new_db(suppliers)
        supplier_saga.append_event(db, {"type": "cancel_requested"})
        drive(db)
        self.assertEqual(db["state"], "CANCELED")
        self.assertFalse(any(e["type"].startswith("reserve") for e in db["events"]))

    def test_cancel_after_reservation_compensates(self):
        suppliers = [supplier("s1", 10), supplier("s2", 20)]
        db = drive(supplier_saga.new_db(suppliers))
        self.assertEqual(db["state"], "COMPLETED")
        self.assertEqual(db["chosen"], "s1")
        cancel(db)
        self.assertEqual(db["state"], "CANCELED")
        self.assertIn({"type": "compensated", "id": "s1"}, db["events"])
        self.assertIn("compensate:s1", db["requests"])
        self.assert_idempotent(db)

    def test_all_quotes_fail(self):
        suppliers = [
            supplier("s1", 10, quote_failed=True),
            supplier("s2", 20, quote_failed=True),
        ]
        db = drive(supplier_saga.new_db(suppliers))
        self.assertEqual(db["state"], "FAILED")
        self.assertEqual(supplier_saga.candidates(db), [])
        self.assertIsNone(db["chosen"])
        self.assertFalse(any(e["type"].startswith("reserve") for e in db["events"]))

    def test_crash_after_quote_event_then_recover(self):
        suppliers = [
            supplier("s1", 10, latency=1),
            supplier("s2", 20, latency=2),
            supplier("s3", 30, latency=3),
        ]
        db = drive(supplier_saga.new_db(suppliers), crash_at="quote:s2")
        self.assertEqual(db["state"], "QUOTING")
        quoted = [e["id"] for e in db["events"] if e["type"] == "quote"]
        self.assertEqual(quoted, ["s1", "s2"])
        drive(db)  # recover
        self.assertEqual(db["state"], "COMPLETED")
        self.assertEqual(db["chosen"], "s1")
        self.assertEqual(supplier_saga.candidates(db), reference_candidates(suppliers))
        self.assert_idempotent(db)

    def test_crash_after_reserve_event_then_recover(self):
        suppliers = [supplier("s1", 10), supplier("s2", 20)]
        db = drive(supplier_saga.new_db(suppliers), crash_at="reserve:s1")
        self.assertEqual(db["state"], "COMPLETED")
        self.assertEqual(db["chosen"], "s1")
        drive(db)  # recover: must not re-reserve
        self.assertEqual(db["state"], "COMPLETED")
        self.assertEqual(db["chosen"], "s1")
        reserve_ok = [e for e in db["events"] if e["type"] == "reserve_ok"]
        self.assertEqual(len(reserve_ok), 1)
        self.assert_idempotent(db)

    def test_crash_after_reserve_failure_then_recovers_to_fallback(self):
        suppliers = [
            supplier("s1", 10, reserve_failed=True),
            supplier("s2", 20),
        ]
        db = drive(supplier_saga.new_db(suppliers), crash_at="reserve_fail:s1")
        self.assertEqual(db["state"], "RESERVING")
        drive(db)  # recover: falls back to s2 without re-attempting s1
        self.assertEqual(db["state"], "COMPLETED")
        self.assertEqual(db["chosen"], "s2")
        fails = [e for e in db["events"] if e["type"] == "reserve_fail"]
        self.assertEqual(len(fails), 1)
        self.assert_idempotent(db)

    def test_expected_state_after_every_event(self):
        suppliers = [
            supplier("s1", 10, latency=1),
            supplier("s2", 20, latency=2),
        ]
        expected = [
            ("quote:s1", "QUOTING"),
            ("quote:s2", "QUOTING"),
            ("quotes", "QUOTING"),
            ("reserve:s1", "COMPLETED"),
        ]
        db = supplier_saga.new_db(suppliers)
        for crash_at, expected_state in expected:
            drive(db, crash_at=crash_at)
            self.assertEqual(db["state"], expected_state,
                             "after event %s" % crash_at)
        drive(db)  # final recover: terminal, stable
        self.assertEqual(db["state"], "COMPLETED")
        self.assertEqual(db["chosen"], "s1")
        self.assertEqual(supplier_saga.candidates(db), reference_candidates(suppliers))
        self.assert_idempotent(db)


class CliTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = os.path.join(self.tmp.name, "journal.json")
        self.suppliers_path = os.path.join(self.tmp.name, "suppliers.json")
        with open(self.suppliers_path, "w", encoding="utf-8") as fh:
            json.dump([
                supplier("s1", 10, latency=2),
                supplier("s2", 20, latency=1, reserve_failed=True),
                supplier("s3", 5, latency=3, quote_failed=True),
            ], fh)

    def cli(self, *argv):
        return subprocess.run(
            [sys.executable, "supplier_saga.py", *argv],
            capture_output=True, text=True,
            cwd=os.path.dirname(os.path.abspath(__file__)))

    def state(self):
        proc = self.cli("state", "--db", self.db)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout)

    def test_cli_crash_cancel_recover_flow(self):
        proc = self.cli("crash", "--suppliers", self.suppliers_path,
                        "--db", self.db, "--at", "quote:s2")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self.state()["state"], "QUOTING")

        proc = self.cli("cancel", "--db", self.db)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        snap = self.state()
        self.assertEqual(snap["state"], "CANCELED")
        self.assertFalse(any(k.startswith("reserve:") for k in snap["requests"]))

        proc = self.cli("recover", "--db", self.db)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self.state()["state"], "CANCELED")

    def test_cli_run_and_state(self):
        proc = self.cli("run", "--suppliers", self.suppliers_path, "--db", self.db)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        snap = self.state()
        self.assertEqual(snap["state"], "COMPLETED")
        # s3 failed its quote; s1 is cheapest usable quote.
        self.assertEqual(snap["candidates"], ["s1", "s2"])
        self.assertEqual(snap["chosen"], "s1")

    def test_cli_crash_after_reserve_then_recover(self):
        proc = self.cli("crash", "--suppliers", self.suppliers_path,
                        "--db", self.db, "--at", "reserve:s1")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self.state()["state"], "COMPLETED")
        proc = self.cli("recover", "--db", self.db)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        snap = self.state()
        self.assertEqual(snap["state"], "COMPLETED")
        self.assertEqual(snap["chosen"], "s1")
        self.assertEqual(len(snap["requests"]), len(set(snap["requests"])))

    def test_cli_unknown_crash_point_fails(self):
        proc = self.cli("crash", "--suppliers", self.suppliers_path,
                        "--db", self.db, "--at", "reserve:nope")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("never reached", proc.stderr)


if __name__ == "__main__":
    unittest.main()
