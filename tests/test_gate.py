import unittest
from datetime import datetime, timedelta, timezone

from budgetgate import (
    BudgetGate,
    GateInternalError,
    IdempotencyConflict,
    SimulatedCrash,
    UnknownRequest,
)

UTC = timezone.utc
BASE = datetime(2026, 1, 1, tzinfo=UTC)


def ts(seconds):
    return (BASE + timedelta(seconds=seconds)).isoformat()


def make_gate(**kwargs):
    config = {
        "timezones": {"utc": "UTC", "home": "Asia/Shanghai"},
        "nodes": {
            "root": {
                "windows": [
                    {"id": "roll", "kind": "rolling",
                     "duration_seconds": 10, "capacity": 10},
                    {"id": "day", "kind": "day", "tz": "utc", "capacity": 100},
                ]
            },
            "team_a": {"parents": ["root"], "windows": [
                {"id": "day", "kind": "day", "tz": "utc", "capacity": 50},
            ]},
            "team_b": {"parents": ["root"]},
            "svc": {"parents": ["team_a", "team_b"]},  # diamond into root
        },
    }
    return BudgetGate(config, **kwargs)


def reserve(gate, rid="r1", amount=5, exec_at=5, deadline=100, subject="svc"):
    return gate.reserve(
        request_id=rid, subject=subject, amount=amount,
        execute_at=ts(exec_at), confirm_deadline=ts(deadline), now=ts(0),
    )


class HierarchyTest(unittest.TestCase):
    def test_shared_parent_charged_once_through_diamond(self):
        gate = make_gate()
        result = reserve(gate, amount=6)
        self.assertEqual(result["status"], "held")
        charged = {(c["node"], c["window"]) for c in result["charged"]}
        # svc has no own windows; team_a day + team_b (none) + root roll/day.
        self.assertEqual(charged, {
            ("team_a", "day"), ("root", "roll"), ("root", "day"),
        })
        root_roll = gate._windows[("root", "roll")]
        self.assertEqual(sum(e.amount for e in root_roll.all_entries()), 6)
        gate.check_invariants()

    def test_unknown_subject_rejected(self):
        gate = make_gate()
        with self.assertRaises(Exception):
            reserve(gate, subject="ghost")


class AtomicityTest(unittest.TestCase):
    def test_partial_window_failure_rolls_back_everything(self):
        gate = make_gate()
        boom = gate._windows[("root", "day")]
        original_add = boom.add

        def failing_add(entry):
            raise RuntimeError("disk on fire")

        boom.add = failing_add
        try:
            with self.assertRaises(GateInternalError):
                reserve(gate, amount=5)
        finally:
            boom.add = original_add
        # Nothing leaked: no hold, no entries anywhere, log untouched by hold.
        self.assertEqual(gate.status()["holds"], {})
        for name, window in gate.status()["windows"].items():
            self.assertEqual(window["entries"], [], name)
        gate.check_invariants()

    def test_rejection_carries_window_and_occupancy_evidence(self):
        gate = make_gate()
        self.assertEqual(reserve(gate, "r1", amount=8)["status"], "held")
        result = reserve(gate, "r2", amount=8)
        self.assertEqual(result["status"], "rejected")
        self.assertEqual(len(result["violations"]), 1)
        violation = result["violations"][0]
        self.assertEqual(violation["node"], "root")
        self.assertEqual(violation["window"], "roll")
        self.assertEqual(violation["capacity"], 10)
        self.assertEqual(violation["used"], 16)
        self.assertEqual(violation["requested"], 8)
        self.assertEqual(
            [o["hold_id"] for o in violation["occupants"]], ["r1", "r2"]
        )
        gate.check_invariants()


class IdempotencyTest(unittest.TestCase):
    def test_replayed_reserve_returns_stored_result_and_charges_once(self):
        gate = make_gate()
        first = reserve(gate, "r1", amount=5)
        second = reserve(gate, "r1", amount=5)
        self.assertFalse(first.get("replayed", False))
        self.assertTrue(second["replayed"])
        self.assertEqual(second["version"], first["version"])
        root_roll = gate._windows[("root", "roll")]
        self.assertEqual(sum(e.amount for e in root_roll.all_entries()), 5)
        gate.check_invariants()

    def test_conflicting_payload_rejected(self):
        gate = make_gate()
        reserve(gate, "r1", amount=5)
        with self.assertRaises(IdempotencyConflict):
            reserve(gate, "r1", amount=6)

    def test_id_reuse_after_terminal_state_gets_new_version(self):
        gate = make_gate()
        first = reserve(gate, "r1", amount=8)
        gate.cancel("r1", now=ts(1))
        second = reserve(gate, "r1", amount=8)
        self.assertEqual(second["status"], "held")
        self.assertEqual(second["version"], first["version"] + 1)
        gate.check_invariants()


class LateCancelTest(unittest.TestCase):
    def test_stale_cancel_cannot_release_newer_hold(self):
        gate = make_gate()
        first = reserve(gate, "r1", amount=8, deadline=10)
        gate.run_due_timers(now=ts(11))  # v1 expires
        second = reserve(gate, "r1", amount=8, deadline=100)
        self.assertEqual(second["version"], first["version"] + 1)
        # A late cancel aimed at the expired generation must be a no-op.
        stale = gate.cancel("r1", version=first["version"], now=ts(12))
        self.assertEqual(stale["status"], "stale")
        root_roll = gate._windows[("root", "roll")]
        self.assertEqual(sum(e.amount for e in root_roll.all_entries()), 8)
        # The live hold is still confirmable.
        self.assertEqual(gate.confirm("r1", now=ts(13))["status"], "confirmed")
        gate.check_invariants()

    def test_expiry_timer_is_versioned(self):
        gate = make_gate()
        first = reserve(gate, "r1", amount=5, deadline=10)
        expired = gate.run_due_timers(now=ts(11))
        self.assertEqual(
            [(e["request_id"], e["version"]) for e in expired],
            [("r1", first["version"])],
        )
        second = reserve(gate, "r1", amount=5, deadline=100)
        # Re-running timers must not kill the new generation early.
        self.assertEqual(gate.run_due_timers(now=ts(50)), [])
        self.assertEqual(gate.status()["holds"]["r1"]["state"], "held")
        self.assertEqual(second["version"], first["version"] + 1)
        gate.check_invariants()


class ConfirmCancelFlowTest(unittest.TestCase):
    def test_confirm_after_deadline_loses_to_timeout(self):
        gate = make_gate()
        reserve(gate, "r1", amount=5, deadline=10)
        result = gate.confirm("r1", now=ts(11))
        self.assertEqual(result["status"], "rejected")
        self.assertIn("expired", result["reason"])
        gate.check_invariants()

    def test_confirm_and_cancel_are_idempotent(self):
        gate = make_gate()
        reserve(gate, "r1", amount=5)
        self.assertEqual(gate.confirm("r1", now=ts(1))["status"], "confirmed")
        again = gate.confirm("r1", now=ts(2))
        self.assertEqual(again["status"], "confirmed")
        self.assertTrue(again["replayed"])
        # Confirmed holds cannot be cancelled.
        self.assertEqual(gate.cancel("r1", now=ts(3))["status"], "rejected")

        reserve(gate, "r2", amount=5)
        self.assertEqual(gate.cancel("r2", now=ts(1))["status"], "cancelled")
        self.assertTrue(gate.cancel("r2", now=ts(2))["replayed"])
        gate.check_invariants()

    def test_unknown_request(self):
        gate = make_gate()
        with self.assertRaises(UnknownRequest):
            gate.confirm("nope", now=ts(0))


class QuotaUpdateTest(unittest.TestCase):
    def test_quota_decrease_keeps_existing_blocks_new(self):
        gate = make_gate()
        reserve(gate, "r1", amount=8)
        gate.set_capacity("root", "roll", 5, now=ts(1))
        # Existing hold survives, but new reservations see the lower cap.
        result = reserve(gate, "r2", amount=1)
        self.assertEqual(result["status"], "rejected")
        self.assertEqual(result["violations"][0]["capacity"], 5)
        gate.cancel("r1", now=ts(2))
        self.assertEqual(reserve(gate, "r3", amount=5)["status"], "held")
        self.assertEqual(reserve(gate, "r4", amount=1)["status"], "rejected")
        gate.check_invariants()


class CrashRecoveryTest(unittest.TestCase):
    def test_crash_between_confirm_write_and_response(self):
        crashes = {"armed": True}

        def hook(event):
            if crashes["armed"] and event["op"] == "confirm":
                raise SimulatedCrash("crash after durable confirm write")

        gate = make_gate(after_commit=hook)
        reserve(gate, "r1", amount=5)
        with self.assertRaises(SimulatedCrash):
            gate.confirm("r1", now=ts(1))  # response lost, write durable
        crashes["armed"] = False

        # Recover from the persisted snapshot and replay the confirm.
        recovered = BudgetGate.restore(gate.snapshot())
        replay = recovered.confirm("r1", now=ts(2))
        self.assertEqual(replay["status"], "confirmed")
        self.assertTrue(replay["replayed"])
        self.assertEqual(recovered.status()["holds"]["r1"]["state"], "confirmed")
        recovered.check_invariants()

    def test_crash_between_reserve_write_and_response_replays(self):
        crashes = {"armed": True}

        def hook(event):
            if crashes["armed"] and event["op"] == "reserve":
                raise SimulatedCrash("crash after durable reserve write")

        gate = make_gate(after_commit=hook)
        with self.assertRaises(SimulatedCrash):
            reserve(gate, "r1", amount=5)
        crashes["armed"] = False
        recovered = BudgetGate.restore(gate.snapshot())
        replay = reserve(recovered, "r1", amount=5)
        self.assertEqual(replay["status"], "held")
        self.assertTrue(replay["replayed"])
        root_roll = recovered._windows[("root", "roll")]
        self.assertEqual(sum(e.amount for e in root_roll.all_entries()), 5)
        recovered.check_invariants()


class CrossMidnightTest(unittest.TestCase):
    def test_business_day_flips_at_local_midnight(self):
        config = {
            "timezones": {"home": "Asia/Shanghai"},  # UTC+8, no DST
            "nodes": {"n": {"windows": [
                {"id": "bd", "kind": "day", "tz": "home", "capacity": 10},
            ]}},
        }
        gate = BudgetGate(config)
        # 2026-01-01 23:30 local == 15:30 UTC; 2026-01-02 00:30 == 16:30 UTC.
        late = gate.reserve(request_id="a", subject="n", amount=8,
                            execute_at="2026-01-01T15:30:00+00:00",
                            confirm_deadline="2026-01-02T00:00:00+00:00",
                            now="2026-01-01T15:00:00+00:00")
        early = gate.reserve(request_id="b", subject="n", amount=8,
                             execute_at="2026-01-01T16:30:00+00:00",
                             confirm_deadline="2026-01-02T00:00:00+00:00",
                             now="2026-01-01T15:00:00+00:00")
        self.assertEqual(late["status"], "held")
        self.assertEqual(early["status"], "held")  # different local day
        # A third request on the 1st overflows that day's bucket.
        third = gate.reserve(request_id="c", subject="n", amount=3,
                             execute_at="2026-01-01T15:45:00+00:00",
                             confirm_deadline="2026-01-02T00:00:00+00:00",
                             now="2026-01-01T15:00:00+00:00")
        self.assertEqual(third["status"], "rejected")
        self.assertEqual(third["violations"][0]["bucket"], [2026, 1, 1])
        gate.check_invariants()

    def test_rolling_window_spans_midnight(self):
        config = {
            "timezones": {},
            "nodes": {"n": {"windows": [
                {"id": "roll", "kind": "rolling",
                 "duration_seconds": 7200, "capacity": 10},
            ]}},
        }
        gate = BudgetGate(config)
        gate.reserve(request_id="a", subject="n", amount=6,
                     execute_at="2026-01-01T23:30:00+00:00",
                     confirm_deadline="2026-01-02T00:00:00+00:00",
                     now="2026-01-01T23:00:00+00:00")
        across = gate.reserve(request_id="b", subject="n", amount=6,
                              execute_at="2026-01-02T00:30:00+00:00",
                              confirm_deadline="2026-01-02T01:00:00+00:00",
                              now="2026-01-02T00:00:00+00:00")
        self.assertEqual(across["status"], "rejected")
        self.assertEqual(across["violations"][0]["window"], "roll")
        gate.check_invariants()


if __name__ == "__main__":
    unittest.main()
