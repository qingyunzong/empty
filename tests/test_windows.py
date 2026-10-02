"""Window semantics: business day (local), calendar, rolling (real time),
shared parent quotas, DAG dedup, atomic rollback, rejection evidence."""
import unittest
from datetime import datetime, timezone

from budget_gate import BudgetGate, WindowSpec

NY = "America/New_York"
SH = "Asia/Shanghai"
NOW = datetime(2023, 10, 1, 0, 0, tzinfo=timezone.utc).timestamp()
FAR = NOW + 10_000_000  # confirm deadline far in the future


def utc(y, mo, d, h, mi=0):
    return datetime(y, mo, d, h, mi, tzinfo=timezone.utc).timestamp()


def reserve(gate, id, subject, amount, execute_at, now=NOW):
    return gate.reserve(id=id, subject=subject, amount=amount,
                        execute_at=execute_at, confirm_by=FAR, now=now)


class TestBusinessDayWindow(unittest.TestCase):
    def setUp(self):
        self.g = BudgetGate()
        self.g.add_subject("s")
        self.g.set_quota("s", "r", [
            WindowSpec(kind="business_day", capacity=5, tz=SH),
        ])

    def test_cross_midnight_reservations_share_local_day(self):
        # Two instants on different UTC dates but the same Shanghai day.
        a = utc(2023, 10, 1, 20)   # Oct 2, 04:00 +08
        b = utc(2023, 10, 2, 3)    # Oct 2, 11:00 +08
        self.assertEqual(reserve(self.g, "a", "s", 3, a)["status"], "reserved")
        self.assertEqual(reserve(self.g, "b", "s", 3, b)["status"], "rejected")
        self.assertEqual(reserve(self.g, "b2", "s", 2, b)["status"], "reserved")

    def test_next_local_day_frees_capacity(self):
        day1 = utc(2023, 10, 1, 12)   # Oct 1, 20:00 +08
        day2 = utc(2023, 10, 2, 12)   # Oct 2, 20:00 +08
        self.assertEqual(reserve(self.g, "a", "s", 5, day1)["status"], "reserved")
        self.assertEqual(reserve(self.g, "b", "s", 5, day2)["status"], "reserved")

    def test_dst_fold_day_counts_both_ambiguous_hours(self):
        g = BudgetGate()
        g.add_subject("s")
        g.set_quota("s", "r", [WindowSpec(kind="business_day", capacity=2, tz=NY)])
        # 01:30 EDT and 01:30 EST on 2023-11-05: same local day, distinct
        # real instants. A fixed-86400s bucket would split them wrongly.
        first = utc(2023, 11, 5, 5, 30)
        second = utc(2023, 11, 5, 6, 30)
        self.assertEqual(reserve(g, "a", "s", 1, first)["status"], "reserved")
        self.assertEqual(reserve(g, "b", "s", 1, second)["status"], "reserved")
        rejected = reserve(g, "c", "s", 1, utc(2023, 11, 5, 12))
        self.assertEqual(rejected["status"], "rejected")
        self.assertEqual(rejected["failures"][0]["bucket"], "2023-11-05")


class TestRollingWindow(unittest.TestCase):
    def setUp(self):
        self.g = BudgetGate()
        self.g.add_subject("s")
        self.g.set_quota("s", "r", [WindowSpec(kind="rolling", capacity=5, seconds=3600)])

    def test_rolling_window_uses_real_instants(self):
        t0 = utc(2023, 10, 1, 12)
        self.assertEqual(reserve(self.g, "a", "s", 3, t0)["status"], "reserved")
        self.assertEqual(reserve(self.g, "b", "s", 3, t0 + 1800)["status"], "rejected")
        # Boundary: (t-3600, t] is half-open; exactly 3600s later frees a.
        self.assertEqual(reserve(self.g, "c", "s", 3, t0 + 3600)["status"], "reserved")
        self.assertEqual(reserve(self.g, "d", "s", 3, t0 + 3601)["status"], "rejected")

    def test_cross_timezone_reservations_cannot_both_pass(self):
        # Subjects in different timezones share one parent rolling quota;
        # each has room in its own local business day, but the shared
        # rolling window (real time) rejects the second one.
        g = BudgetGate()
        g.add_subject("hq")
        g.add_subject("ny_office", ["hq"])
        g.add_subject("sh_office", ["hq"])
        g.set_quota("hq", "shared", [
            WindowSpec(kind="business_day", capacity=100, tz=NY),
            WindowSpec(kind="rolling", capacity=5, seconds=3600),
        ])
        t0 = utc(2023, 10, 1, 12)
        self.assertEqual(reserve(g, "a", "ny_office", 4, t0)["status"], "reserved")
        r = reserve(g, "b", "sh_office", 4, t0 + 600)
        self.assertEqual(r["status"], "rejected")
        self.assertEqual(r["failures"][0]["window_id"], "rolling[3600s]")
        self.assertEqual(r["failures"][0]["occupied"], 4)


class TestCalendarWindow(unittest.TestCase):
    def test_week_window(self):
        g = BudgetGate()
        g.add_subject("s")
        g.set_quota("s", "r", [
            WindowSpec(kind="calendar", unit="week", capacity=4, tz="UTC"),
        ])
        wed = utc(2023, 10, 4, 12)
        sun = utc(2023, 10, 8, 12)   # same ISO week
        mon = utc(2023, 10, 9, 12)   # next ISO week
        self.assertEqual(reserve(g, "a", "s", 3, wed)["status"], "reserved")
        self.assertEqual(reserve(g, "b", "s", 2, sun)["status"], "rejected")
        self.assertEqual(reserve(g, "c", "s", 2, mon)["status"], "reserved")


class TestSharedParentQuotaDAG(unittest.TestCase):
    def test_parent_quota_charged_once_via_multiple_paths(self):
        # Diamond: s -> p1 -> g, s -> p2 -> g. g's quota must be charged
        # exactly once for a reservation by s.
        g = BudgetGate()
        g.add_subject("g")
        g.add_subject("p1", ["g"])
        g.add_subject("p2", ["g"])
        g.add_subject("s", ["p1", "p2"])
        g.set_quota("g", "qg", [WindowSpec(kind="rolling", capacity=10, seconds=3600)])
        t0 = utc(2023, 10, 1, 12)
        self.assertEqual(reserve(g, "a", "s", 4, t0)["status"], "reserved")
        report = g.occupancy_report("s", t0)
        self.assertEqual(len(report), 1)
        self.assertEqual(report[0]["occupied"], 4)  # not 8
        self.assertEqual(reserve(g, "b", "s", 7, t0)["status"], "rejected")
        self.assertEqual(reserve(g, "c", "s", 6, t0)["status"], "reserved")

    def test_cycle_rejected(self):
        g = BudgetGate()
        g.add_subject("a")
        g.add_subject("b", ["a"])
        from budget_gate import GateError
        with self.assertRaises(GateError):
            g.add_subject("a", ["b"])  # duplicate subject
        with self.assertRaises(GateError):
            g.add_subject("c", ["c"])  # self cycle


class TestAtomicRollback(unittest.TestCase):
    def test_partial_window_failure_rolls_back_completely(self):
        g = BudgetGate()
        g.add_subject("s")
        g.set_quota("s", "r", [
            WindowSpec(kind="business_day", capacity=10, tz="UTC"),
            WindowSpec(kind="rolling", capacity=3, seconds=3600),
        ])
        t0 = utc(2023, 10, 1, 12)
        # Fails only the rolling window; the day window must stay untouched.
        r = reserve(g, "a", "s", 4, t0)
        self.assertEqual(r["status"], "rejected")
        self.assertEqual(len(r["failures"]), 1)
        self.assertEqual(r["failures"][0]["window_id"], "rolling[3600s]")
        report = {w["window_id"]: w for w in g.occupancy_report("s", t0)}
        self.assertEqual(report["business_day[UTC]"]["occupied"], 0)
        self.assertEqual(report["rolling[3600s]"]["occupied"], 0)

    def test_multi_rule_failure_leaves_all_rules_untouched(self):
        g = BudgetGate()
        g.add_subject("parent")
        g.add_subject("child", ["parent"])
        g.set_quota("parent", "roomy", [
            WindowSpec(kind="rolling", capacity=100, seconds=3600)])
        g.set_quota("child", "tight", [
            WindowSpec(kind="rolling", capacity=2, seconds=3600)])
        t0 = utc(2023, 10, 1, 12)
        r = reserve(g, "a", "child", 5, t0)
        self.assertEqual(r["status"], "rejected")
        self.assertEqual(r["failures"][0]["rule_id"], "tight")
        report = {w["rule_id"]: w for w in g.occupancy_report("child", t0)}
        self.assertEqual(report["roomy"]["occupied"], 0)
        self.assertEqual(report["tight"]["occupied"], 0)


class TestRejectionEvidence(unittest.TestCase):
    def test_rejection_names_window_and_occupancy(self):
        g = BudgetGate()
        g.add_subject("s")
        g.set_quota("s", "r", [
            WindowSpec(kind="business_day", capacity=6, tz=SH),
        ])
        t0 = utc(2023, 10, 1, 12)
        reserve(g, "a", "s", 5, t0)
        r = reserve(g, "b", "s", 4, t0)
        self.assertEqual(r["status"], "rejected")
        (f,) = r["failures"]
        self.assertEqual(f["rule_id"], "r")
        self.assertEqual(f["window_id"], "business_day[Asia/Shanghai]")
        self.assertEqual(f["capacity"], 6)
        self.assertEqual(f["occupied"], 5)
        self.assertEqual(f["requested"], 4)
        self.assertEqual(f["available"], 1)
        self.assertEqual(f["bucket"], "2023-10-01")


if __name__ == "__main__":
    unittest.main()
