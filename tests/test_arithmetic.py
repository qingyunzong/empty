import unittest

from timeaxis import Duration, Instant, LocalDateTime, TransitionTable

TABLE_A = [
    {"utc_start": None, "offset": "+01:00"},
    {"utc_start": "2024-03-31T01:00:00Z", "offset": "+02:00"},
    {"utc_start": "2024-10-27T01:00:00Z", "offset": "+01:00"},
]


def local(text):
    return LocalDateTime.from_iso(text)


class WallClockArithmeticTest(unittest.TestCase):
    def test_add_days_is_calendar_not_86400(self):
        self.assertEqual(
            local("2024-03-31T00:00:00").add_days(1).to_iso(),
            "2024-04-01T00:00:00")

    def test_add_months_clamps_day(self):
        self.assertEqual(
            local("2024-01-31T10:00:00").add_months(1).to_iso(),
            "2024-02-29T10:00:00")  # leap year
        self.assertEqual(
            local("2023-01-31T10:00:00").add_months(1).to_iso(),
            "2023-02-28T10:00:00")
        self.assertEqual(
            local("2024-03-31T10:00:00").add_months(-1).to_iso(),
            "2024-02-29T10:00:00")

    def test_add_months_crosses_year(self):
        self.assertEqual(
            local("2024-12-15T08:00:00").add_months(2).to_iso(),
            "2025-02-15T08:00:00")


class TimelineArithmeticTest(unittest.TestCase):
    def setUp(self):
        self.table = TransitionTable.from_spec(TABLE_A)

    def test_add_seconds_is_elapsed_time(self):
        instant = Instant.from_iso("2024-03-31T00:00:00Z")
        shifted = instant + Duration.from_seconds(86400)
        self.assertEqual(shifted.to_iso(), "2024-04-01T00:00:00Z")

    def test_wall_clock_day_and_timeline_day_differ_across_gap(self):
        # Wall clock: 2024-03-31T00:00 + 1 calendar day -> 2024-04-01T00:00.
        wall = local("2024-03-31T00:00:00").add_days(1)
        # Timeline: same start instant + 86400 elapsed seconds.
        start = self.table.local_to_instant(local("2024-03-31T00:00:00"))[0].instant
        timeline = self.table.instant_to_local(start + Duration.from_seconds(86400))
        # The spring-forward day only has 23 elapsed hours, so the two
        # rules must not be interchanged.
        self.assertEqual(wall.to_iso(), "2024-04-01T00:00:00")
        self.assertEqual(timeline.to_iso(), "2024-04-01T01:00:00")
        self.assertNotEqual(wall, timeline)

    def test_duration_roundtrip_not_equal_calendar_duration(self):
        # Across the fold, 86400 elapsed seconds lands one wall-clock hour
        # earlier than a calendar day.
        start = self.table.local_to_instant(local("2024-10-27T00:00:00"))[0].instant
        timeline = self.table.instant_to_local(start + Duration.from_seconds(86400))
        wall = local("2024-10-27T00:00:00").add_days(1)
        self.assertEqual(timeline.to_iso(), "2024-10-27T23:00:00")
        self.assertEqual(wall.to_iso(), "2024-10-28T00:00:00")
        self.assertNotEqual(timeline, wall)


if __name__ == "__main__":
    unittest.main()
