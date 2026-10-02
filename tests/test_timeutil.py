"""Timezone table, local day boundaries, DST fold/gap behaviour."""
import unittest
from datetime import datetime, timezone

from budget_gate import timeutil

NY = "America/New_York"
SH = "Asia/Shanghai"


def utc(y, mo, d, h, mi=0):
    return datetime(y, mo, d, h, mi, tzinfo=timezone.utc).timestamp()


class TestLocalDayBounds(unittest.TestCase):
    def test_fall_back_day_is_25_hours_not_86400(self):
        # 2023-11-05: US Eastern falls back 02:00 EDT -> 01:00 EST.
        self.assertEqual(timeutil.local_day_length_seconds(utc(2023, 11, 5, 12), NY),
                         25 * 3600)

    def test_spring_forward_day_is_23_hours_not_86400(self):
        # 2024-03-10: US Eastern springs forward 02:00 -> 03:00.
        self.assertEqual(timeutil.local_day_length_seconds(utc(2024, 3, 10, 12), NY),
                         23 * 3600)

    def test_normal_day_is_24_hours(self):
        self.assertEqual(timeutil.local_day_length_seconds(utc(2023, 10, 1, 12), NY),
                         24 * 3600)

    def test_shanghai_has_no_dst(self):
        self.assertEqual(timeutil.local_day_length_seconds(utc(2023, 11, 5, 12), SH),
                         24 * 3600)

    def test_day_bounds_are_true_instants(self):
        start, end = timeutil.local_day_bounds(utc(2023, 11, 5, 12), NY)
        # The day begins at midnight EDT (UTC-4) = 04:00 UTC and ends at
        # midnight EST (UTC-5) = 05:00 UTC the next day: 25 true hours.
        self.assertEqual(start.timestamp(), utc(2023, 11, 5, 4))
        self.assertEqual(end.timestamp(), utc(2023, 11, 6, 5))


class TestFoldedTime(unittest.TestCase):
    def test_ambiguous_wall_clock_instants_share_one_day(self):
        # Both map to local 01:30 on 2023-11-05 (fold 0 EDT, fold 1 EST).
        first = utc(2023, 11, 5, 5, 30)
        second = utc(2023, 11, 5, 6, 30)
        self.assertEqual(timeutil.to_local(first, NY).fold, 0)
        self.assertEqual(timeutil.to_local(second, NY).fold, 1)
        self.assertEqual(timeutil.day_key(first, NY), "2023-11-05")
        self.assertEqual(timeutil.day_key(second, NY), "2023-11-05")
        # They remain distinct real instants one true hour apart.
        self.assertEqual(second - first, 3600)


class TestLocalDayKeys(unittest.TestCase):
    def test_business_day_follows_local_midnight_not_utc(self):
        # UTC 2023-10-01 17:00 is already 2023-10-02 01:00 in Shanghai.
        self.assertEqual(timeutil.day_key(utc(2023, 10, 1, 17), SH), "2023-10-02")
        self.assertEqual(timeutil.day_key(utc(2023, 10, 1, 17), "UTC"), "2023-10-01")

    def test_same_local_day_across_utc_midnight(self):
        a = utc(2023, 10, 1, 20)   # 2023-10-02 04:00 Shanghai
        b = utc(2023, 10, 2, 3)    # 2023-10-02 11:00 Shanghai
        self.assertEqual(timeutil.day_key(a, SH), timeutil.day_key(b, SH))

    def test_week_and_month_keys(self):
        ts = utc(2023, 10, 4, 12)  # a Wednesday
        self.assertEqual(timeutil.week_key(ts, "UTC"), "2023-W40")
        self.assertEqual(timeutil.month_key(ts, "UTC"), "2023-10")
        # ISO week boundary: 2023-01-01 belongs to ISO week 52 of 2022.
        self.assertEqual(timeutil.week_key(utc(2023, 1, 1, 12), "UTC"), "2022-W52")

    def test_invalid_timezone_rejected(self):
        with self.assertRaises(Exception):
            timeutil.load_timezone("Not/AZone")


if __name__ == "__main__":
    unittest.main()
