import unittest
from datetime import date, datetime, time, timezone

from billcal.model import Rule
from billcal.engine import expand


def ts(iso):
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())


def locals_of(rule, start, end):
    exp = expand(rule, ts(start), ts(end))
    return [o.local.strftime("%Y-%m-%d") for o in exp.occurrences], exp


Y2021 = ("2021-01-01T00:00:00Z", "2022-01-01T00:00:00Z")


class TestShortMonthNoDrift(unittest.TestCase):
    def test_jan31_anchored_to_original_day(self):
        rule = Rule(anchor=date(2021, 1, 31), tz="UTC")
        got, _ = locals_of(rule, *Y2021)
        self.assertEqual(got, [
            "2021-01-31", "2021-02-28", "2021-03-31", "2021-04-30",
            "2021-05-31", "2021-06-30", "2021-07-31", "2021-08-31",
            "2021-09-30", "2021-10-31", "2021-11-30", "2021-12-31",
        ])  # February clamps, March returns to 31: no silent drift.

    def test_leap_year_feb29(self):
        rule = Rule(anchor=date(2020, 1, 31), tz="UTC")
        got, _ = locals_of(rule, "2020-01-01T00:00:00Z", "2021-01-01T00:00:00Z")
        self.assertEqual(got[1], "2020-02-29")
        self.assertEqual(got[2], "2020-03-31")

    def test_every_three_months(self):
        rule = Rule(anchor=date(2021, 1, 31), interval_months=3, tz="UTC")
        got, _ = locals_of(rule, *Y2021)
        self.assertEqual(got, ["2021-01-31", "2021-04-30",
                               "2021-07-31", "2021-10-31"])

    def test_adjusted_anchor_mode_drifts_by_design(self):
        rule = Rule(anchor=date(2021, 1, 31), adjust="preceding",
                    anchor_mode="adjusted", tz="UTC")
        got, _ = locals_of(rule, *Y2021)
        # Jan 31 is a Sunday -> Jan 29; the next base carries day 29.
        self.assertEqual(got[:3], ["2021-01-29", "2021-02-26", "2021-03-26"])
        original = Rule(anchor=date(2021, 1, 31), adjust="preceding",
                        anchor_mode="original", tz="UTC")
        got_orig, _ = locals_of(original, *Y2021)
        self.assertEqual(got_orig[:3], ["2021-01-29", "2021-02-26", "2021-03-31"])


class TestBusinessDayAdjust(unittest.TestCase):
    def test_following_over_consecutive_holidays(self):
        rule = Rule(anchor=date(2021, 12, 1), day=1, adjust="following",
                    holidays=frozenset({date(2022, 1, 3), date(2022, 1, 4)}),
                    tz="UTC")
        got, exp = locals_of(rule, Y2021[0], "2022-02-01T00:00:00Z")
        # 2022-01-01 Sat, 01-02 Sun, 01-03/04 holidays -> 2022-01-05.
        self.assertEqual(got, ["2021-12-01", "2022-01-05"])
        jan = exp.occurrences[-1]
        self.assertTrue(any("holiday" in s for s in jan.steps))
        self.assertTrue(any("weekend" in s for s in jan.steps))

    def test_preceding_across_month_boundary(self):
        rule = Rule(anchor=date(2021, 12, 1), day=1, adjust="preceding",
                    holidays=frozenset({date(2021, 12, 30),
                                        date(2021, 12, 31)}),
                    tz="UTC")
        got, _ = locals_of(rule, Y2021[0], "2022-02-01T00:00:00Z")
        # 2022-01-01 Sat -> 12-31 holiday -> 12-30 holiday -> 12-29 Wed.
        self.assertEqual(got, ["2021-12-01", "2021-12-29"])

    def test_following_across_year_boundary(self):
        rule = Rule(anchor=date(2021, 12, 31), day=31, adjust="following",
                    holidays=frozenset({date(2021, 12, 31),
                                        date(2022, 1, 3)}),
                    tz="UTC")
        got, _ = locals_of(rule, Y2021[0], "2022-02-01T00:00:00Z")
        # 12-31 holiday -> 01-01 Sat -> 01-02 Sun -> 01-03 holiday -> 01-04.
        self.assertEqual(got, ["2022-01-04", "2022-01-31"])

    def test_last_business_day(self):
        rule = Rule(anchor=date(2021, 1, 31), day_spec="last_business_day",
                    tz="UTC")
        got, _ = locals_of(rule, *Y2021)
        self.assertEqual(got[:4], ["2021-01-29", "2021-02-26",
                                   "2021-03-31", "2021-04-30"])


class TestExceptions(unittest.TestCase):
    def test_remove_drops_occurrence_with_reason(self):
        rule = Rule(anchor=date(2021, 1, 15),
                    exceptions_remove=frozenset({date(2021, 3, 15)}), tz="UTC")
        got, exp = locals_of(rule, *Y2021)
        self.assertNotIn("2021-03-15", got)
        self.assertEqual(len(exp.rejected), 1)
        self.assertIn("exception_remove", exp.rejected[0].reason)

    def test_add_extra_occurrence(self):
        rule = Rule(anchor=date(2021, 1, 15),
                    exceptions_add=frozenset({datetime(2021, 3, 20, 9, 0)}),
                    tz="UTC")
        got, exp = locals_of(rule, *Y2021)
        self.assertIn("2021-03-20", got)
        extra = [o for o in exp.occurrences
                 if o.local == datetime(2021, 3, 20, 9, 0)][0]
        self.assertEqual(extra.sources, ("exception_add",))

    def test_add_coinciding_merges_sources(self):
        rule = Rule(anchor=date(2021, 1, 15),
                    exceptions_add=frozenset({datetime(2021, 2, 15, 9, 0)}),
                    tz="UTC")
        _, exp = locals_of(rule, *Y2021)
        merged = [o for o in exp.occurrences
                  if o.local == datetime(2021, 2, 15, 9, 0)]
        self.assertEqual(len(merged), 1)  # deduplicated by UTC instant
        self.assertEqual(merged[0].sources, ("exception_add", "recurrence"))


class TestDSTThroughRules(unittest.TestCase):
    BASE = dict(anchor=date(2021, 10, 7), time_of_day=time(1, 30),
                tz="America/New_York")

    def test_repeated_hour_explicit_choice(self):
        first = Rule(**self.BASE, overlap_policy="first")
        second = Rule(**self.BASE, overlap_policy="second")
        exp1 = expand(first, ts("2021-11-01T00:00:00Z"), ts("2021-12-01T00:00:00Z"))
        exp2 = expand(second, ts("2021-11-01T00:00:00Z"), ts("2021-12-01T00:00:00Z"))
        self.assertEqual(exp1.occurrences[0].utc_ts, 1636263000)  # 05:30Z
        self.assertEqual(exp2.occurrences[0].utc_ts, 1636266600)  # 06:30Z

    def test_gap_reject_reports(self):
        rule = Rule(anchor=date(2021, 2, 14), time_of_day=time(2, 30),
                    tz="America/New_York", gap_policy="reject")
        exp = expand(rule, ts("2021-03-01T00:00:00Z"), ts("2021-04-01T00:00:00Z"))
        self.assertEqual(exp.occurrences, [])
        self.assertEqual(len(exp.rejected), 1)
        self.assertIn("DST gap", exp.rejected[0].reason)

    def test_gap_next_valid(self):
        rule = Rule(anchor=date(2021, 2, 14), time_of_day=time(2, 30),
                    tz="America/New_York", gap_policy="next_valid")
        exp = expand(rule, ts("2021-03-01T00:00:00Z"), ts("2021-04-01T00:00:00Z"))
        self.assertEqual(exp.occurrences[0].utc_ts, 1615705200)  # 07:00Z
        self.assertTrue(any("next_valid" in s
                            for s in exp.occurrences[0].steps))


class TestDeterminismAndSorting(unittest.TestCase):
    def test_sorted_deduped_deterministic(self):
        rule = Rule(anchor=date(2021, 1, 31), adjust="following",
                    exceptions_add=frozenset({datetime(2021, 2, 15, 9, 0),
                                              datetime(2021, 1, 31, 9, 0)}),
                    tz="UTC")
        a = expand(rule, ts(*Y2021[:1]) if False else ts(Y2021[0]), ts(Y2021[1]))
        b = expand(rule, ts(Y2021[0]), ts(Y2021[1]))
        self.assertEqual(a.to_dict(), b.to_dict())
        utcs = [o.utc_ts for o in a.occurrences]
        self.assertEqual(utcs, sorted(utcs))
        self.assertEqual(len(utcs), len(set(utcs)))

    def test_steps_explain_adjustment(self):
        rule = Rule(anchor=date(2021, 1, 31), tz="UTC")
        exp = expand(rule, ts(Y2021[0]), ts(Y2021[1]))
        feb = exp.occurrences[1]
        self.assertTrue(any("clamp" in s and "28" in s for s in feb.steps),
                        feb.steps)


if __name__ == "__main__":
    unittest.main()
