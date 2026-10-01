import unittest
from datetime import date, datetime, time, timezone

from billcal.engine import expand
from billcal.model import Rule
from billcal.reference import reference_utc_instants

START_YEAR, END_YEAR = 2019, 2031
START = int(datetime(START_YEAR, 1, 1, tzinfo=timezone.utc).timestamp())
END = int(datetime(END_YEAR + 1, 1, 1, tzinfo=timezone.utc).timestamp())

HOLIDAYS = frozenset({
    date(2021, 1, 1), date(2021, 12, 31), date(2022, 1, 3),
    date(2022, 12, 26), date(2025, 1, 1), date(2025, 12, 25),
})

RULES = {
    "jan31_monthly": Rule(anchor=date(2019, 1, 31), tz="UTC"),
    "jan31_quarterly": Rule(anchor=date(2019, 1, 31), interval_months=3,
                            tz="UTC"),
    "day15_following_holidays": Rule(
        anchor=date(2019, 1, 15), adjust="following", holidays=HOLIDAYS,
        tz="Asia/Shanghai"),
    "day1_preceding_holidays": Rule(
        anchor=date(2019, 1, 1), adjust="preceding", holidays=HOLIDAYS,
        tz="UTC"),
    "last_business_day": Rule(anchor=date(2019, 1, 31),
                              day_spec="last_business_day", holidays=HOLIDAYS,
                              tz="UTC"),
    "adjusted_mode_drift": Rule(anchor=date(2019, 1, 31), adjust="preceding",
                                anchor_mode="adjusted", tz="UTC"),
    "ny_gap_next_valid": Rule(anchor=date(2019, 3, 14),
                              time_of_day=time(2, 30),
                              tz="America/New_York", gap_policy="next_valid"),
    "ny_overlap_second": Rule(anchor=date(2019, 11, 7),
                              time_of_day=time(1, 30),
                              tz="America/New_York", overlap_policy="second"),
    "with_exceptions": Rule(
        anchor=date(2019, 1, 15), adjust="following", holidays=HOLIDAYS,
        exceptions_add=frozenset({datetime(2020, 5, 20, 9, 0),
                                  datetime(2021, 2, 15, 9, 0)}),
        exceptions_remove=frozenset({date(2020, 3, 16),
                                     date(2021, 6, 15)}),
        tz="UTC"),
}


class TestReferenceCrossCheck(unittest.TestCase):
    def check(self, rule):
        engine = {o.utc_ts for o in expand(rule, START, END).occurrences}
        reference = {t for t in reference_utc_instants(
            rule, START_YEAR - 1, END_YEAR + 1) if START <= t < END}
        self.assertEqual(engine, reference,
                         f"engine-only: {sorted(engine - reference)[:3]}, "
                         f"reference-only: {sorted(reference - engine)[:3]}")

    def test_all_rules_match_reference(self):
        for name, rule in RULES.items():
            with self.subTest(rule=name):
                self.check(rule)


if __name__ == "__main__":
    unittest.main()
