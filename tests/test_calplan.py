import json
import random
import subprocess
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from calplan.core import BadInput, plan

UTC = timezone.utc
REPO_ROOT = Path(__file__).resolve().parent.parent


def reference_plan(payload):
    """Minute-level brute-force reference implementation.

    Expands the window minute by minute, marks each minute free iff it
    falls on a working weekday, is not a holiday date, and is not covered
    by any busy interval, then greedily fills the earliest free runs.
    """
    start = datetime.fromisoformat(payload["start"].replace("Z", "+00:00"))
    end = datetime.fromisoformat(payload["end"].replace("Z", "+00:00"))
    week = set()
    names = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}
    for item in payload["week"]:
        week.add(names[item[:3].lower()] if isinstance(item, str) else item)
    holidays = set(payload["holidays"])
    busy = [
        (
            datetime.fromisoformat(b[0].replace("Z", "+00:00")),
            datetime.fromisoformat(b[1].replace("Z", "+00:00")),
        )
        for b in payload["busy"]
    ]

    def minute_is_free(t):
        if t.weekday() not in week:
            return False
        if t.date().isoformat() in holidays:
            return False
        nxt = t + timedelta(minutes=1)
        return all(be <= t or bs >= nxt for bs, be in busy)

    remaining = payload["duration_min"]
    segments = []
    t = start
    run_start = None

    def flush(run_end):
        nonlocal remaining, run_start
        if run_start is None or remaining == 0:
            run_start = None
            return
        run_len = int((run_end - run_start).total_seconds() // 60)
        take = min(remaining, run_len)
        if take > 0:
            segments.append({
                "start": run_start.isoformat().replace("+00:00", "Z"),
                "end": (run_start + timedelta(minutes=take)).isoformat().replace("+00:00", "Z"),
            })
            remaining -= take
        run_start = None

    while t < end:
        if remaining == 0:
            break
        # Runs break at UTC midnight: cross-midnight is split by UTC day.
        if run_start is not None and t.time() == datetime.min.time():
            flush(t)
        if minute_is_free(t):
            if run_start is None:
                run_start = t
        else:
            flush(t)
        t += timedelta(minutes=1)
    flush(t)

    return {
        "status": "ok" if remaining == 0 else "infeasible",
        "segments": segments,
        "remaining_min": remaining,
    }


class SemanticsTest(unittest.TestCase):
    def test_weekend_is_skipped(self):
        # 2025-01-03 is a Friday; demand spills over the weekend to Monday.
        result = plan({
            "week": ["Mon", "Tue", "Wed", "Thu", "Fri"],
            "holidays": [],
            "busy": [],
            "duration_min": 24 * 60,
            "start": "2025-01-03T12:00:00Z",
            "end": "2025-01-07T00:00:00Z",
        })
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["remaining_min"], 0)
        self.assertEqual(result["segments"], [
            {"start": "2025-01-03T12:00:00Z", "end": "2025-01-04T00:00:00Z"},
            {"start": "2025-01-06T00:00:00Z", "end": "2025-01-06T12:00:00Z"},
        ])

    def test_holiday_disables_whole_day(self):
        # 2025-01-06 (Mon) and 2025-01-07 (Tue) are holidays; work resumes Wed.
        result = plan({
            "week": ["Mon", "Tue", "Wed"],
            "holidays": ["2025-01-06", "2025-01-07"],
            "busy": [],
            "duration_min": 60,
            "start": "2025-01-06T00:00:00Z",
            "end": "2025-01-09T00:00:00Z",
        })
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["segments"], [
            {"start": "2025-01-08T00:00:00Z", "end": "2025-01-08T01:00:00Z"},
        ])

    def test_holiday_on_weekend_not_double_counted(self):
        # Saturday is both a weekend day and a holiday; only Monday remains.
        result = plan({
            "week": ["Mon", "Sat"],
            "holidays": ["2025-01-04"],  # a Saturday
            "busy": [],
            "duration_min": 60,
            "start": "2025-01-04T00:00:00Z",
            "end": "2025-01-07T00:00:00Z",
        })
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["segments"], [
            {"start": "2025-01-06T00:00:00Z", "end": "2025-01-06T01:00:00Z"},
        ])

    def test_busy_touching_edges_does_not_conflict(self):
        # Busy intervals end exactly at / start exactly at the free slot.
        result = plan({
            "week": ["Mon"],
            "holidays": [],
            "busy": [
                ["2025-01-06T08:00:00Z", "2025-01-06T10:00:00Z"],
                ["2025-01-06T12:00:00Z", "2025-01-06T14:00:00Z"],
            ],
            "duration_min": 120,
            "start": "2025-01-06T10:00:00Z",
            "end": "2025-01-06T12:00:00Z",
        })
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["segments"], [
            {"start": "2025-01-06T10:00:00Z", "end": "2025-01-06T12:00:00Z"},
        ])

    def test_infeasible_when_window_too_small(self):
        result = plan({
            "week": ["Mon"],
            "holidays": [],
            "busy": [["2025-01-06T01:00:00Z", "2025-01-06T23:00:00Z"]],
            "duration_min": 3 * 60,
            "start": "2025-01-06T00:00:00Z",
            "end": "2025-01-07T00:00:00Z",
        })
        self.assertEqual(result["status"], "infeasible")
        self.assertEqual(result["remaining_min"], 60)
        self.assertEqual(result["segments"], [
            {"start": "2025-01-06T00:00:00Z", "end": "2025-01-06T01:00:00Z"},
            {"start": "2025-01-06T23:00:00Z", "end": "2025-01-07T00:00:00Z"},
        ])

    def test_cross_midnight_split_by_utc_day(self):
        result = plan({
            "week": ["Tue", "Wed"],
            "holidays": [],
            "busy": [],
            "duration_min": 90,
            "start": "2025-01-07T23:00:00Z",  # Tuesday 23:00 UTC
            "end": "2025-01-09T00:00:00Z",
        })
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["segments"], [
            {"start": "2025-01-07T23:00:00Z", "end": "2025-01-08T00:00:00Z"},
            {"start": "2025-01-08T00:00:00Z", "end": "2025-01-08T00:30:00Z"},
        ])


class BadInputTest(unittest.TestCase):
    def test_missing_field_raises(self):
        with self.assertRaises(BadInput) as ctx:
            plan({"week": ["Mon"], "holidays": [], "busy": [],
                  "start": "2025-01-06T00:00:00Z", "end": "2025-01-07T00:00:00Z"})
        self.assertEqual(ctx.exception.code, "BAD_INPUT")
        self.assertIn("duration_min", str(ctx.exception))

    def test_start_not_before_end_raises(self):
        base = {"week": ["Mon"], "holidays": [], "busy": [], "duration_min": 10}
        for start, end in [("2025-01-07T00:00:00Z", "2025-01-06T00:00:00Z"),
                           ("2025-01-06T00:00:00Z", "2025-01-06T00:00:00Z")]:
            with self.assertRaises(BadInput):
                plan({**base, "start": start, "end": end})

    def test_negative_duration_raises(self):
        with self.assertRaises(BadInput):
            plan({"week": ["Mon"], "holidays": [], "busy": [],
                  "duration_min": -5,
                  "start": "2025-01-06T00:00:00Z", "end": "2025-01-07T00:00:00Z"})


class CliTest(unittest.TestCase):
    def run_cli(self, stdin_text):
        return subprocess.run(
            [sys.executable, "-m", "calplan.cli"],
            input=stdin_text, capture_output=True, text=True,
            cwd=REPO_ROOT,
        )

    def test_cli_success_writes_json_to_stdout(self):
        payload = {
            "week": ["Mon"], "holidays": [], "busy": [],
            "duration_min": 30,
            "start": "2025-01-06T09:00:00Z", "end": "2025-01-06T17:00:00Z",
        }
        proc = self.run_cli(json.dumps(payload))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["segments"], [
            {"start": "2025-01-06T09:00:00Z", "end": "2025-01-06T09:30:00Z"},
        ])

    def test_cli_missing_field_exits_2_with_json_stderr(self):
        proc = self.run_cli(json.dumps({"week": ["Mon"], "start": "2025-01-06T00:00:00Z"}))
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(proc.stdout, "")
        error = json.loads(proc.stderr)
        self.assertEqual(error["error"]["code"], "BAD_INPUT")

    def test_cli_start_not_before_end_exits_2(self):
        payload = {
            "week": ["Mon"], "holidays": [], "busy": [], "duration_min": 10,
            "start": "2025-01-06T00:00:00Z", "end": "2025-01-06T00:00:00Z",
        }
        proc = self.run_cli(json.dumps(payload))
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(json.loads(proc.stderr)["error"]["code"], "BAD_INPUT")

    def test_cli_invalid_json_exits_2(self):
        proc = self.run_cli("{not json")
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(json.loads(proc.stderr)["error"]["code"], "BAD_INPUT")

    def test_cli_infeasible_is_not_an_error(self):
        payload = {
            "week": ["Mon"], "holidays": ["2025-01-06"], "busy": [],
            "duration_min": 60,
            "start": "2025-01-06T00:00:00Z", "end": "2025-01-07T00:00:00Z",
        }
        proc = self.run_cli(json.dumps(payload))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["status"], "infeasible")


class RandomizedReferenceTest(unittest.TestCase):
    def test_matches_minute_level_reference_on_200_cases(self):
        rng = random.Random(20250930)
        base = datetime(2025, 1, 1, tzinfo=UTC)
        weekday_names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

        for case in range(200):
            start = base + timedelta(
                days=rng.randint(0, 20), minutes=rng.randint(0, 24 * 60 - 1))
            end = start + timedelta(minutes=rng.randint(1, 4 * 24 * 60))
            week = rng.sample(weekday_names, rng.randint(1, 7))
            holidays = list({
                (start.date() + timedelta(days=rng.randint(-1, 5))).isoformat()
                for _ in range(rng.randint(0, 3))
            })
            busy = []
            for _ in range(rng.randint(0, 5)):
                b_start = start + timedelta(
                    minutes=rng.randint(0, int((end - start).total_seconds() // 60)))
                b_end = b_start + timedelta(minutes=rng.randint(1, 12 * 60))
                busy.append([
                    b_start.isoformat().replace("+00:00", "Z"),
                    b_end.isoformat().replace("+00:00", "Z"),
                ])
            payload = {
                "week": week,
                "holidays": holidays,
                "busy": busy,
                "duration_min": rng.randint(0, 3 * 24 * 60),
                "start": start.isoformat().replace("+00:00", "Z"),
                "end": end.isoformat().replace("+00:00", "Z"),
            }
            expected = reference_plan(payload)
            actual = plan(payload)
            self.assertEqual(
                actual, expected,
                f"case {case} mismatch\npayload={json.dumps(payload)}\n"
                f"expected={expected}\nactual={actual}",
            )


if __name__ == "__main__":
    unittest.main()
