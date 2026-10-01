import unittest
from datetime import date, time

from billcycle import BusinessCalendar, Rule, expand, get_zone
from billcycle.tztable import iso_utc, to_epoch, from_epoch


def utc(y, m, d):
    return to_epoch(from_epoch(0).replace(year=y, month=m, day=d))


class TestDstThroughEngine(unittest.TestCase):
    def setUp(self):
        self.cal = BusinessCalendar()
        self.ny = get_zone("America/New_York")

    def _rule(self, **kw):
        defaults = dict(anchor=date(2024, 10, 3), day_of_month=3,
                        adjust="none", time_of_day=time(1, 30),
                        zone="America/New_York")
        defaults.update(kw)
        return Rule(**defaults)

    def test_repeated_hour_explicit_earlier(self):
        rule = self._rule(repeat_policy="earlier")
        exp = expand(rule, self.cal, self.ny, utc(2024, 10, 1), utc(2024, 12, 1))
        nov = next(o for o in exp.occurrences
                   if o.local_date == date(2024, 11, 3))
        self.assertEqual(iso_utc(nov.utc), "2024-11-03T05:30:00Z")
        self.assertTrue(any("occurs twice" in s for s in nov.steps))

    def test_repeated_hour_explicit_later(self):
        rule = self._rule(repeat_policy="later")
        exp = expand(rule, self.cal, self.ny, utc(2024, 10, 1), utc(2024, 12, 1))
        nov = next(o for o in exp.occurrences
                   if o.local_date == date(2024, 11, 3))
        self.assertEqual(iso_utc(nov.utc), "2024-11-03T06:30:00Z")

    def test_repeated_hour_reject_lands_in_rejected_list(self):
        rule = self._rule(repeat_policy="reject")
        exp = expand(rule, self.cal, self.ny, utc(2024, 10, 1), utc(2024, 12, 1))
        self.assertNotIn(date(2024, 11, 3),
                         [o.local_date for o in exp.occurrences])
        self.assertEqual([r["date"] for r in exp.rejected], ["2024-11-03"])
        self.assertIn("repeat_policy=reject", exp.rejected[0]["reason"])

    def test_gap_shift_forward(self):
        rule = self._rule(anchor=date(2024, 2, 10), day_of_month=10,
                          time_of_day=time(2, 30), gap_policy="shift_forward")
        exp = expand(rule, self.cal, self.ny, utc(2024, 3, 1), utc(2024, 4, 1))
        mar = exp.occurrences[0]
        self.assertEqual(mar.local_date, date(2024, 3, 10))
        self.assertEqual(iso_utc(mar.utc), "2024-03-10T07:00:00Z")  # 03:00 EDT
        self.assertTrue(any("does not exist" in s for s in mar.steps))

    def test_gap_reject(self):
        rule = self._rule(anchor=date(2024, 2, 10), day_of_month=10,
                          time_of_day=time(2, 30), gap_policy="reject")
        exp = expand(rule, self.cal, self.ny, utc(2024, 3, 1), utc(2024, 4, 1))
        self.assertEqual(exp.occurrences, [])
        self.assertEqual([r["date"] for r in exp.rejected], ["2024-03-10"])

    def test_results_are_deterministic(self):
        rule = self._rule()
        a = expand(rule, self.cal, self.ny, utc(2024, 1, 1), utc(2025, 1, 1))
        b = expand(rule, self.cal, self.ny, utc(2024, 1, 1), utc(2025, 1, 1))
        self.assertEqual([(o.utc, o.sources, o.steps) for o in a.occurrences],
                         [(o.utc, o.sources, o.steps) for o in b.occurrences])


if __name__ == "__main__":
    unittest.main()
