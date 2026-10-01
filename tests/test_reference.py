import unittest
from datetime import date

from billcycle import BusinessCalendar, Rule, get_zone, reference

HOLIDAYS = {
    date(2023, 1, 1): "New Year", date(2023, 1, 2): "New Year (obs)",
    date(2024, 1, 1): "New Year", date(2024, 12, 25): "Christmas",
    date(2024, 12, 26): "Boxing Day", date(2025, 1, 1): "New Year",
    date(2025, 12, 25): "Christmas", date(2025, 12, 26): "Boxing Day",
    date(2026, 1, 1): "New Year", date(2026, 1, 2): "holiday",
}

START = date(2022, 1, 1)
END = date(2026, 12, 31)


class TestReferenceCrossCheck(unittest.TestCase):
    """The main engine must agree with the independent day-by-day
    enumerator over a finite year range for a battery of rules."""

    def setUp(self):
        self.cal = BusinessCalendar(holidays=HOLIDAYS)
        self.ny = get_zone("America/New_York")
        self.utc = get_zone("UTC")

    def check(self, rule, zone=None):
        report = reference.cross_check(rule, self.cal, zone or self.utc,
                                       START, END)
        self.assertTrue(report["ok"],
                        f"mismatch for {rule.to_json()}: {report}")
        self.assertGreater(report["reference_count"], 0)
        return report

    def test_monthly_day31_following_with_holidays(self):
        self.check(Rule(anchor=date(2022, 1, 31), day_of_month=31,
                        adjust="following"))

    def test_monthly_day29_covers_leap_years(self):
        self.check(Rule(anchor=date(2022, 1, 29), day_of_month=29,
                        adjust="none"))

    def test_quarterly_day15_preceding(self):
        self.check(Rule(anchor=date(2022, 1, 15), interval_months=3,
                        adjust="preceding"), zone=self.ny)

    def test_last_business_day(self):
        self.check(Rule(anchor=date(2022, 1, 31),
                        day_of_month="last_business_day", adjust="none"),
                   zone=self.ny)

    def test_last_day_no_adjust(self):
        self.check(Rule(anchor=date(2022, 2, 15), day_of_month="last",
                        adjust="none"))

    def test_every_two_months_with_exceptions(self):
        self.check(Rule(anchor=date(2022, 1, 10), interval_months=2,
                        adjust="following",
                        add_dates=(date(2023, 6, 15), date(2025, 6, 15)),
                        remove_dates=(date(2023, 3, 10),)))

    def test_yearly_from_feb29(self):
        self.check(Rule(anchor=date(2020, 2, 29), interval_months=12,
                        adjust="following"))

    def test_reference_rejects_rolling_mode(self):
        with self.assertRaises(ValueError):
            reference.enumerate_dates(
                Rule(anchor=date(2022, 1, 31), anchor_mode="rolling"),
                self.cal, START, END)

    def test_reference_is_deterministic(self):
        rule = Rule(anchor=date(2022, 1, 31), day_of_month=31,
                    adjust="following")
        first = reference.enumerate_dates(rule, self.cal, START, END)
        second = reference.enumerate_dates(rule, self.cal, START, END)
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
