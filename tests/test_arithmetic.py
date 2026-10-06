import unittest

from timeline import (Duration, Instant, LocalDateTime, add_days_wallclock,
                      add_duration, add_months_wallclock,
                      add_seconds_timeline, local_to_instant)
from tzhelpers import L, dst_table


class WallClockArithmeticTest(unittest.TestCase):
    def test_add_days_is_calendar_based(self):
        ldt = LocalDateTime.from_iso("2024-03-30T12:00:00")
        self.assertEqual(add_days_wallclock(ldt, 1).to_iso(),
                         "2024-03-31T12:00:00")
        self.assertEqual(add_days_wallclock(ldt, -1).to_iso(),
                         "2024-03-29T12:00:00")

    def test_add_months_clamps_day(self):
        ldt = LocalDateTime.from_iso("2024-01-31T10:00:00")
        self.assertEqual(add_months_wallclock(ldt, 1).to_iso(),
                         "2024-02-29T10:00:00")  # 2024 is a leap year
        ldt = LocalDateTime.from_iso("2023-01-31T10:00:00")
        self.assertEqual(add_months_wallclock(ldt, 1).to_iso(),
                         "2023-02-28T10:00:00")
        ldt = LocalDateTime.from_iso("2024-03-31T10:00:00")
        self.assertEqual(add_months_wallclock(ldt, -1).to_iso(),
                         "2024-02-29T10:00:00")
        ldt = LocalDateTime.from_iso("2024-12-15T10:00:00")
        self.assertEqual(add_months_wallclock(ldt, 2).to_iso(),
                         "2025-02-15T10:00:00")

    def test_wallclock_result_may_land_in_gap_or_fold(self):
        table = dst_table()
        # +1 wall-clock day lands inside the spring-forward gap
        ldt = LocalDateTime.from_iso("2024-03-30T01:30:00")
        shifted = add_days_wallclock(ldt, 1)
        self.assertEqual(local_to_instant(table, shifted.local_seconds()), [])
        # +1 wall-clock day lands inside the autumn fold
        ldt = LocalDateTime.from_iso("2024-10-26T01:30:00")
        shifted = add_days_wallclock(ldt, 1)
        self.assertEqual(len(local_to_instant(table, shifted.local_seconds())), 2)


class TimelineArithmeticTest(unittest.TestCase):
    def test_add_seconds_is_exact(self):
        instant = Instant(1_700_000_000)
        self.assertEqual(add_seconds_timeline(instant, 86400).epoch_seconds,
                         1_700_000_000 + 86400)
        self.assertEqual(add_duration(instant, Duration(-5)).epoch_seconds,
                         1_700_000_000 - 5)


class RegimesMustNotBeInterchangedTest(unittest.TestCase):
    def setUp(self):
        self.table = dst_table()

    def test_wallclock_day_across_gap_is_23_timeline_hours(self):
        # local 2024-03-30T12:00 + 1 wall-clock day = 2024-03-31T12:00,
        # which is only 82800 timeline seconds later (spring forward).
        start = local_to_instant(self.table, L(2024, 3, 30, 12, 0))[0].instant
        end_local = add_days_wallclock(
            LocalDateTime.from_iso("2024-03-30T12:00:00"), 1)
        end = local_to_instant(self.table, end_local.local_seconds())[0].instant
        self.assertEqual(end - start, 82800)
        self.assertNotEqual(end - start, 86400)

    def test_wallclock_day_across_fold_is_25_timeline_hours(self):
        start = local_to_instant(self.table, L(2024, 10, 26, 12, 0))[0].instant
        end_local = add_days_wallclock(
            LocalDateTime.from_iso("2024-10-26T12:00:00"), 1)
        end = local_to_instant(self.table, end_local.local_seconds())[0].instant
        self.assertEqual(end - start, 90000)

    def test_duration_roundtrip_differs_from_calendar_duration(self):
        # Adding 86400 timeline seconds and adding 1 wall-clock day give
        # different wall-clock readings across a jump.
        start_instant = local_to_instant(
            self.table, L(2024, 3, 30, 12, 0))[0].instant
        timeline_end = add_seconds_timeline(Instant(start_instant), 86400)
        from timeline import instant_to_local
        timeline_local, _ = instant_to_local(self.table,
                                             timeline_end.epoch_seconds)
        wallclock_end = add_days_wallclock(
            LocalDateTime.from_iso("2024-03-30T12:00:00"), 1)
        self.assertNotEqual(timeline_local, wallclock_end.local_seconds())
        # the timeline result reads 13:00 on the wall clock, not 12:00
        self.assertEqual(
            LocalDateTime.from_local_seconds(timeline_local).to_iso(),
            "2024-03-31T13:00:00")
        self.assertEqual(wallclock_end.to_iso(), "2024-03-31T12:00:00")

    def test_no_jump_regimes_agree(self):
        # away from transitions both regimes coincide -- the discrepancy is
        # caused by the jump, not by the arithmetic itself
        start = local_to_instant(self.table, L(2024, 7, 1, 12, 0))[0].instant
        end_local = add_days_wallclock(
            LocalDateTime.from_iso("2024-07-01T12:00:00"), 1)
        end = local_to_instant(self.table, end_local.local_seconds())[0].instant
        self.assertEqual(end - start, 86400)


if __name__ == "__main__":
    unittest.main()
