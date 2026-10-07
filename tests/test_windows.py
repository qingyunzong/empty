import unittest
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from budgetgate.timeutil import local_day_bounds, parse_ts
from budgetgate.windows import CalendarWindow, RollingWindow, UsageEntry

UTC = timezone.utc
NY = ZoneInfo("America/New_York")


def entry(amount, at, hold_id="h", version=1):
    return UsageEntry(hold_id=hold_id, version=version, amount=amount, at=parse_ts(at))


class BusinessDayDstTest(unittest.TestCase):
    """Business-day boundaries come from local midnights, never 86400s."""

    def test_spring_forward_day_is_23_hours(self):
        start, end = local_day_bounds(NY, date(2026, 3, 8))
        self.assertEqual((end - start).total_seconds(), 23 * 3600)
        self.assertNotEqual((end - start).total_seconds(), 86400)

    def test_fall_back_day_is_25_hours(self):
        start, end = local_day_bounds(NY, date(2026, 11, 1))
        self.assertEqual((end - start).total_seconds(), 25 * 3600)

    def test_bucket_around_spring_forward(self):
        window = CalendarWindow("bd", 100, "day", NY, "ny")
        # 2026-03-09 03:30 UTC is still 23:30 EDT on the 8th; 04:30 UTC is
        # 00:30 EDT on the 9th.  A naive boundary of midnight + 86400s
        # (05:00 UTC -> 05:00 UTC) would misfile both instants.
        self.assertEqual(
            window.bucket_key(parse_ts("2026-03-09T03:30:00+00:00")), (2026, 3, 8)
        )
        self.assertEqual(
            window.bucket_key(parse_ts("2026-03-09T04:30:00+00:00")), (2026, 3, 9)
        )

    def test_fold_instants_share_one_business_day(self):
        # 2026-11-01 01:30 happens twice in New York.
        first = datetime(2026, 11, 1, 1, 30, tzinfo=NY, fold=0)   # EDT, 05:30Z
        second = datetime(2026, 11, 1, 1, 30, tzinfo=NY, fold=1)  # EST, 06:30Z
        self.assertNotEqual(first.astimezone(UTC), second.astimezone(UTC))
        window = CalendarWindow("bd", 100, "day", NY, "ny")
        self.assertEqual(
            window.bucket_key(first.astimezone(UTC)),
            window.bucket_key(second.astimezone(UTC)),
        )
        # The duplicated hour means capacity is charged by instant, and
        # both folds land in the same bucket.
        window.add(entry(60, first))
        violation = window.check(entry(50, second))
        self.assertIsNotNone(violation)
        self.assertEqual(violation["used"], 60)

    def test_hour_and_month_grains(self):
        window = CalendarWindow("h", 10, "hour", NY, "ny")
        self.assertEqual(
            window.bucket_key(parse_ts("2026-07-01T04:30:00+00:00")), (2026, 7, 1, 0)
        )
        month = CalendarWindow("m", 10, "month", NY, "ny")
        self.assertEqual(
            month.bucket_key(parse_ts("2026-07-31T23:00:00+00:00")), (2026, 7)
        )


class RollingWindowTest(unittest.TestCase):
    def test_trailing_window_uses_real_instants(self):
        window = RollingWindow("r", 10, timedelta(seconds=60))
        self.assertIsNone(window.check(entry(6, "2026-01-01T00:00:10+00:00", "a")))
        window.add(entry(6, "2026-01-01T00:00:10+00:00", "a"))
        # 61 seconds later the first entry has aged out.
        self.assertIsNone(window.check(entry(6, "2026-01-01T00:01:11+00:00", "b")))
        # 59 seconds later it has not.
        violation = window.check(entry(6, "2026-01-01T00:01:09+00:00", "b"))
        self.assertIsNotNone(violation)
        self.assertEqual(violation["used"], 12)
        self.assertEqual(violation["capacity"], 10)
        self.assertEqual([o["hold_id"] for o in violation["occupants"]], ["a", "b"])

    def test_out_of_order_execution_time_cannot_overflow_future_point(self):
        window = RollingWindow("r", 10, timedelta(seconds=60))
        window.add(entry(10, "2026-01-01T00:01:40+00:00", "future"))
        # A back-dated request is inside the existing entry's trailing
        # window, so admitting it would overflow at t=100.
        violation = window.check(entry(1, "2026-01-01T00:00:50+00:00", "past"))
        self.assertIsNotNone(violation)
        self.assertEqual(violation["at"], "2026-01-01T00:01:40+00:00")

    def test_remove_returns_amount(self):
        window = RollingWindow("r", 10, timedelta(seconds=60))
        window.add(entry(4, "2026-01-01T00:00:01+00:00", "x", version=2))
        self.assertEqual(window.remove("x", 1), 0)  # wrong version: no-op
        self.assertEqual(window.remove("x", 2), 4)
        self.assertEqual(window.all_entries(), [])


if __name__ == "__main__":
    unittest.main()
