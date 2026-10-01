import unittest
from datetime import date

from billcycle import BusinessCalendar, Rule, expand, get_zone
from billcycle.tztable import to_epoch, from_epoch


def utc(y, m, d):
    return to_epoch(from_epoch(0).replace(year=y, month=m, day=d))


def dates_of(exp):
    return [o.local_date for o in exp.occurrences]


class TestShortMonthNoDrift(unittest.TestCase):
    def setUp(self):
        self.cal = BusinessCalendar()
        self.zone = get_zone("UTC")

    def test_jan31_anchor_clamps_but_never_drifts(self):
        rule = Rule(anchor=date(2024, 1, 31), day_of_month=31, adjust="none")
        exp = expand(rule, self.cal, self.zone, utc(2024, 1, 1), utc(2025, 5, 1))
        got = dates_of(exp)
        self.assertIn(date(2024, 2, 29), got)   # leap year clamp
        self.assertIn(date(2024, 4, 30), got)   # short month clamp
        self.assertIn(date(2024, 3, 31), got)   # back to 31 after Feb
        self.assertIn(date(2025, 2, 28), got)   # non-leap clamp
        self.assertIn(date(2025, 3, 31), got)   # still 31, no drift to 28
        self.assertIn(date(2025, 4, 30), got)

    def test_clamp_step_is_recorded(self):
        rule = Rule(anchor=date(2024, 1, 31), day_of_month=31, adjust="none")
        exp = expand(rule, self.cal, self.zone, utc(2024, 1, 1), utc(2025, 1, 1))
        feb = next(o for o in exp.occurrences
                   if o.local_date == date(2024, 2, 29))
        self.assertTrue(any("clamped" in s and "no drift" in s
                            for s in feb.steps))
        mar = next(o for o in exp.occurrences
                   if o.local_date == date(2024, 3, 31))
        self.assertFalse(any("clamped" in s for s in mar.steps))

    def test_leap_day_anchor_interval_12(self):
        rule = Rule(anchor=date(2020, 2, 29), interval_months=12,
                    adjust="none")
        exp = expand(rule, self.cal, self.zone, utc(2020, 1, 1), utc(2025, 1, 1))
        self.assertEqual(dates_of(exp), [date(2020, 2, 29), date(2021, 2, 28),
                                         date(2022, 2, 28), date(2023, 2, 28),
                                         date(2024, 2, 29)])

    def test_rolling_mode_drifts_explicitly(self):
        # rolling anchors each cycle on the last adjusted date, so the
        # February clamp propagates: this is the documented, explicit
        # alternative to anchor_mode=original.
        rule = Rule(anchor=date(2024, 1, 31), anchor_mode="rolling",
                    adjust="none")
        exp = expand(rule, self.cal, self.zone, utc(2024, 1, 1), utc(2024, 6, 1))
        self.assertEqual(dates_of(exp), [date(2024, 1, 31), date(2024, 2, 29),
                                         date(2024, 3, 29), date(2024, 4, 29),
                                         date(2024, 5, 29)])
        mar = next(o for o in exp.occurrences
                   if o.local_date == date(2024, 3, 29))
        self.assertTrue(any("rolling from previous adjusted date 2024-02-29"
                            in s for s in mar.steps))

    def test_every_occurrence_has_steps(self):
        rule = Rule(anchor=date(2024, 1, 31))
        exp = expand(rule, self.cal, self.zone, utc(2024, 1, 1), utc(2025, 1, 1))
        self.assertTrue(exp.occurrences)
        for occ in exp.occurrences:
            self.assertTrue(occ.steps, occ)


class TestDaySpecsAndAdjustment(unittest.TestCase):
    def setUp(self):
        self.cal = BusinessCalendar()
        self.zone = get_zone("UTC")

    def test_last_day_of_month(self):
        rule = Rule(anchor=date(2024, 1, 15), day_of_month="last",
                    adjust="none")
        exp = expand(rule, self.cal, self.zone, utc(2024, 1, 1), utc(2024, 5, 1))
        self.assertEqual(dates_of(exp), [date(2024, 1, 31), date(2024, 2, 29),
                                         date(2024, 3, 31), date(2024, 4, 30)])

    def test_last_business_day(self):
        rule = Rule(anchor=date(2024, 6, 1),
                    day_of_month="last_business_day", adjust="none")
        exp = expand(rule, self.cal, self.zone, utc(2024, 6, 1), utc(2024, 9, 1))
        # 2024-06-30 Sunday -> 28th; 2024-07-31 Wed; 2024-08-31 Sat -> 30th
        self.assertEqual(dates_of(exp), [date(2024, 6, 28), date(2024, 7, 31),
                                         date(2024, 8, 30)])

    def test_following_and_preceding(self):
        sat = date(2024, 6, 15)  # Saturday
        fwd = Rule(anchor=sat, adjust="following")
        bwd = Rule(anchor=sat, adjust="preceding")
        exp_f = expand(fwd, self.cal, self.zone, utc(2024, 6, 1), utc(2024, 7, 1))
        exp_b = expand(bwd, self.cal, self.zone, utc(2024, 6, 1), utc(2024, 7, 1))
        self.assertEqual(dates_of(exp_f), [date(2024, 6, 17)])
        self.assertEqual(dates_of(exp_b), [date(2024, 6, 14)])
        self.assertTrue(any("Saturday" in s for s in
                            exp_f.occurrences[0].steps))

    def test_holiday_streak_crossing_month(self):
        cal = BusinessCalendar(holidays={
            date(2024, 12, 31): "New Year's Eve",
            date(2025, 1, 1): "New Year's Day",
            date(2025, 1, 2): "holiday",
            date(2025, 1, 3): "holiday",
        })
        rule = Rule(anchor=date(2024, 12, 31), adjust="following")
        exp = expand(rule, cal, self.zone, utc(2024, 12, 1), utc(2025, 3, 1))
        # 12-31..01-03 holidays, 01-04/05 weekend -> lands 2025-01-06
        self.assertEqual(dates_of(exp)[0], date(2025, 1, 6))
        steps = exp.occurrences[0].steps
        self.assertTrue(any("2025-01-01" in s and "holiday" in s
                            for s in steps))
        self.assertTrue(any("crossed a month boundary" in s for s in steps))
        # the next cycle is unaffected by the streak
        self.assertIn(date(2025, 1, 31), dates_of(exp))

    def test_preceding_crossing_month_backwards(self):
        cal = BusinessCalendar(holidays={date(2025, 1, 1): "New Year's Day"})
        rule = Rule(anchor=date(2025, 1, 1), adjust="preceding")
        exp = expand(rule, cal, self.zone, utc(2024, 12, 1), utc(2025, 2, 1))
        # Jan 1 holiday, Dec 29/30 weekend -> lands 2024-12-31 (Tuesday)
        self.assertEqual(dates_of(exp)[0], date(2024, 12, 31))


class TestExceptionsAndDedup(unittest.TestCase):
    def setUp(self):
        self.cal = BusinessCalendar()
        self.zone = get_zone("UTC")

    def test_remove_then_add_overrides_recurrence(self):
        rule = Rule(anchor=date(2024, 1, 31), day_of_month=31, adjust="none",
                    remove_dates=(date(2024, 3, 31),),
                    add_dates=(date(2024, 3, 15),))
        exp = expand(rule, self.cal, self.zone, utc(2024, 1, 1), utc(2024, 5, 1))
        got = dates_of(exp)
        self.assertNotIn(date(2024, 3, 31), got)
        self.assertIn(date(2024, 3, 15), got)
        self.assertEqual([r["date"] for r in exp.removed], ["2024-03-31"])

    def test_added_date_merges_sources_when_colliding(self):
        rule = Rule(anchor=date(2024, 1, 31), day_of_month=31, adjust="none",
                    add_dates=(date(2024, 2, 29),))
        exp = expand(rule, self.cal, self.zone, utc(2024, 1, 1), utc(2024, 4, 1))
        feb = [o for o in exp.occurrences if o.local_date == date(2024, 2, 29)]
        self.assertEqual(len(feb), 1)  # deduplicated
        self.assertEqual(sorted(feb[0].sources),
                         ["exception_add", "recurrence[cycle=1]"])
        self.assertTrue(any("merged" in s for s in feb[0].steps))

    def test_output_sorted_by_utc_and_unique(self):
        rule = Rule(anchor=date(2024, 1, 31), day_of_month=31,
                    add_dates=(date(2024, 2, 15), date(2024, 1, 10)))
        exp = expand(rule, self.cal, self.zone, utc(2024, 1, 1), utc(2025, 1, 1))
        utcs = [o.utc for o in exp.occurrences]
        self.assertEqual(utcs, sorted(utcs))
        self.assertEqual(len(utcs), len(set(utcs)))

    def test_add_remove_overlap_rejected(self):
        with self.assertRaises(ValueError):
            Rule(anchor=date(2024, 1, 31),
                 add_dates=(date(2024, 3, 1),),
                 remove_dates=(date(2024, 3, 1),))

    def test_exception_hash_changes_with_exception_set(self):
        base = Rule(anchor=date(2024, 1, 31))
        other = base.updated(remove_dates=(date(2024, 3, 31),))
        self.assertNotEqual(base.exception_hash(), other.exception_hash())
        self.assertEqual(base.exception_hash(),
                         Rule(anchor=date(2024, 1, 31)).exception_hash())


if __name__ == "__main__":
    unittest.main()
