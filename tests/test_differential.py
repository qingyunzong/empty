"""Differential testing against an independent minute-grid brute force.

The reference implementation models every single minute in the candidate
window as a boolean availability cell and independently re-implements
parsing, calendar rules and the earliest-segment greedy policy. It shares
no production code with calplan.
"""

import random
import unittest
from datetime import date, datetime, timedelta, timezone

from calplan import plan

DAY = 24 * 60


def minute_to_text(total):
    d = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=total)
    return d.strftime("%Y-%m-%dT%H:%M:00Z")


def text_to_minute(text):
    assert text.endswith("Z")
    return int(datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(
        tzinfo=timezone.utc).timestamp()) // 60


def reference(req):
    """Minute-grid brute force; returns (status, segments, remaining)."""
    start = text_to_minute(req["start"])
    end = text_to_minute(req["end"])
    busy = [(text_to_minute(a), text_to_minute(b)) for a, b in req["busy"]]
    holidays = {datetime.strptime(h, "%Y-%m-%d").date() for h in req["holidays"]}
    week = set(req["week"])
    duration = req["duration_min"]

    free_runs = []
    run_start = None
    for t in range(start, end):
        d = (datetime(1970, 1, 1, tzinfo=timezone.utc)
             + timedelta(minutes=t)).date()
        available = (
            d.isoweekday() in week
            and d not in holidays
            and not any(bs <= t < be for bs, be in busy)
        )
        if available and run_start is None:
            run_start = t
        elif not available and run_start is not None:
            free_runs.append((run_start, t))
            run_start = None
    if run_start is not None:
        free_runs.append((run_start, end))

    segments = []
    remaining = duration
    for rs, re in free_runs:
        if remaining == 0:
            break
        take = min(remaining, re - rs)
        if take:
            segments.append({"start": minute_to_text(rs),
                             "end": minute_to_text(rs + take)})
            remaining -= take

    return ("feasible" if remaining == 0 else "infeasible", segments, remaining)


def generate_case(rng):
    base_day = date(2025, 1, 1) + timedelta(days=rng.randint(0, 700))
    base = int(datetime(base_day.year, base_day.month, base_day.day,
                        tzinfo=timezone.utc).timestamp()) // 60
    start = base + rng.randint(0, 2 * DAY)
    end = start + rng.randint(30, 4 * DAY)

    week = sorted(set(rng.sample(range(1, 8), rng.randint(1, 7))))

    first_date = (datetime(1970, 1, 1, tzinfo=timezone.utc)
                  + timedelta(minutes=start)).date()
    last_date = (datetime(1970, 1, 1, tzinfo=timezone.utc)
                 + timedelta(minutes=end - 1)).date()
    span = (last_date - first_date).days
    holidays = []
    for _ in range(rng.randint(0, 3)):
        holidays.append((first_date + timedelta(days=rng.randint(0, span)))
                        .isoformat())
    holidays = sorted(set(holidays))

    busy = []
    for _ in range(rng.randint(0, 4)):
        bs = rng.randint(start, end - 1)
        be = rng.randint(bs, min(end, bs + rng.randint(1, DAY // 2)))
        busy.append([minute_to_text(bs), minute_to_text(be)])

    duration = rng.choice([
        0,
        rng.randint(1, max(1, end - start)),
        rng.randint(0, end - start + 3 * DAY),
    ])

    return {
        "week": week,
        "holidays": holidays,
        "busy": busy,
        "duration_min": duration,
        "start": minute_to_text(start),
        "end": minute_to_text(end),
    }


class DifferentialTests(unittest.TestCase):
    def test_200_random_cases_against_minute_grid(self):
        rng = random.Random(20260929)
        for case_index in range(200):
            req = generate_case(rng)
            with self.subTest(case=case_index):
                expected = reference(req)
                actual = plan(req)
                self.assertEqual(actual["status"], expected[0])
                self.assertEqual(actual["segments"], expected[1])
                self.assertEqual(actual["remaining_minutes"], expected[2])


if __name__ == "__main__":
    unittest.main()
