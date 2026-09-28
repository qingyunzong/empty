import json
import subprocess
import sys
import unittest

from calplan import BadInputError, plan


def base_request(**overrides):
    req = {
        "week": [1, 2, 3, 4, 5],
        "holidays": [],
        "busy": [],
        "duration_min": 60,
        "start": "2026-01-01T00:00:00Z",
        "end": "2026-01-03T00:00:00Z",
    }
    req.update(overrides)
    return req


class TestPlanAcceptance(unittest.TestCase):
    def test_weekend_is_skipped(self):
        # Thu 2026-01-01 through Sat midnight; only Thu is a workday.
        result = plan(base_request(start="2026-01-01T20:00:00Z",
                                   end="2026-01-04T00:00:00Z",
                                   duration_min=300))
        self.assertEqual(result["status"], "feasible")
        self.assertEqual(result["segments"], [
            {"start": "2026-01-01T20:00:00Z", "end": "2026-01-02T01:00:00Z"},
        ])
        self.assertEqual(result["remaining_minutes"], 0)

    def test_segment_split_at_end_of_workday_picks_up_next_workday(self):
        # Need 60 minutes starting Fri 23:30 -> 30 on Fri, 30 on Monday.
        result = plan(base_request(start="2026-01-02T23:30:00Z",
                                   end="2026-01-06T00:00:00Z",
                                   duration_min=60))
        self.assertEqual(result["status"], "feasible")
        self.assertEqual(result["segments"], [
            {"start": "2026-01-02T23:30:00Z", "end": "2026-01-03T00:00:00Z"},
            {"start": "2026-01-05T00:00:00Z", "end": "2026-01-05T00:30:00Z"},
        ])

    def test_holiday_consumes_whole_day(self):
        # Thu is a holiday; Friday must be used.
        result = plan(base_request(holidays=["2026-01-01"],
                                   duration_min=60))
        self.assertEqual(result["status"], "feasible")
        self.assertEqual(result["segments"], [
            {"start": "2026-01-02T00:00:00Z", "end": "2026-01-02T01:00:00Z"},
        ])

    def test_holiday_on_weekend_is_not_double_counted(self):
        # Saturday is already outside week; holiday overlap changes nothing.
        result = plan(base_request(holidays=["2026-01-03"],
                                   start="2026-01-01T00:00:00Z",
                                   end="2026-01-05T00:00:00Z",
                                   duration_min=2880))
        self.assertEqual(result["status"], "feasible")
        self.assertEqual(result["remaining_minutes"], 0)
        self.assertTrue(all(seg["start"] < "2026-01-03" for seg in result["segments"]))

    def test_busy_touching_edge_does_not_conflict(self):
        # busy [09:00,10:00); requesting from 10:00 must start immediately.
        result = plan(base_request(
            busy=[["2026-01-01T09:00:00Z", "2026-01-01T10:00:00Z"]],
            start="2026-01-01T10:00:00Z",
            end="2026-01-01T11:00:00Z",
            duration_min=60,
        ))
        self.assertEqual(result["status"], "feasible")
        self.assertEqual(result["segments"], [
            {"start": "2026-01-01T10:00:00Z", "end": "2026-01-01T11:00:00Z"},
        ])

    def test_busy_crossing_midnight_blocks_those_minutes(self):
        result = plan(base_request(
            busy=[["2026-01-01T23:00:00Z", "2026-01-02T01:00:00Z"]],
            start="2026-01-01T22:00:00Z",
            end="2026-01-02T03:00:00Z",
            duration_min=120,
        ))
        self.assertEqual(result["status"], "feasible")
        self.assertEqual(result["segments"], [
            {"start": "2026-01-01T22:00:00Z", "end": "2026-01-01T23:00:00Z"},
            {"start": "2026-01-02T01:00:00Z", "end": "2026-01-02T02:00:00Z"},
        ])

    def test_infeasible_when_window_has_no_capacity(self):
        result = plan(base_request(start="2026-01-03T00:00:00Z",
                                   end="2026-01-04T00:00:00Z",
                                   duration_min=1))
        self.assertEqual(result["status"], "infeasible")
        self.assertEqual(result["segments"], [])
        self.assertEqual(result["remaining_minutes"], 1)

    def test_infeasible_returns_partial_earliest_segments(self):
        result = plan(base_request(
            busy=[["2026-01-01T01:00:00Z", "2026-01-02T00:00:00Z"]],
            start="2026-01-01T00:00:00Z",
            end="2026-01-02T00:00:00Z",
            duration_min=120,
        ))
        self.assertEqual(result["status"], "infeasible")
        self.assertEqual(result["segments"], [
            {"start": "2026-01-01T00:00:00Z", "end": "2026-01-01T01:00:00Z"},
        ])
        self.assertEqual(result["remaining_minutes"], 60)

    def test_earliest_placement_tiebreak_start_then_end(self):
        # Two identical 60-minute gaps; the earlier one must be selected.
        result = plan(base_request(
            busy=[
                ["2026-01-01T01:00:00Z", "2026-01-01T02:00:00Z"],
                ["2026-01-01T03:00:00Z", "2026-01-01T04:00:00Z"],
            ],
            start="2026-01-01T00:00:00Z",
            end="2026-01-01T05:00:00Z",
            duration_min=60,
        ))
        self.assertEqual(result["segments"], [
            {"start": "2026-01-01T00:00:00Z", "end": "2026-01-01T01:00:00Z"},
        ])

    def test_zero_duration_needs_nothing(self):
        result = plan(base_request(start="2026-01-03T00:00:00Z",
                                   end="2026-01-04T00:00:00Z",
                                   duration_min=0))
        self.assertEqual(result["status"], "feasible")
        self.assertEqual(result["segments"], [])
        self.assertEqual(result["remaining_minutes"], 0)

    def test_accepts_offset_utc_and_naive_inputs_as_utc(self):
        result = plan(base_request(start="2026-01-01T00:00:00+00:00",
                                   end="2026-01-01T01:00:00+00:00"))
        self.assertEqual(result["segments"][0]["start"], "2026-01-01T00:00:00Z")

    def test_missing_field_is_bad_input(self):
        req = base_request()
        del req["holidays"]
        with self.assertRaises(BadInputError):
            plan(req)

    def test_start_ge_end_is_bad_input(self):
        with self.assertRaises(BadInputError):
            plan(base_request(start="2026-01-02T00:00:00Z",
                              end="2026-01-02T00:00:00Z"))

    def test_non_utc_timezone_is_bad_input(self):
        with self.assertRaises(BadInputError):
            plan(base_request(start="2026-01-01T08:00:00+08:00",
                              end="2026-01-01T09:00:00+08:00"))

    def test_subminute_precision_is_bad_input(self):
        with self.assertRaises(BadInputError):
            plan(base_request(start="2026-01-01T00:00:30Z",
                              end="2026-01-01T01:00:00Z"))


class TestCli(unittest.TestCase):
    def run_cli(self, raw):
        proc = subprocess.run(
            [sys.executable, "-m", "calplan.cli"],
            input=raw,
            capture_output=True,
            text=True,
        )
        return proc

    def test_cli_feasible(self):
        proc = self.run_cli(json.dumps(base_request()))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(result["status"], "feasible")
        self.assertEqual(proc.stderr, "")

    def test_cli_infeasible_is_not_parse_error(self):
        proc = self.run_cli(json.dumps(base_request(
            start="2026-01-03T00:00:00Z",
            end="2026-01-04T00:00:00Z",
            duration_min=1,
        )))
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(json.loads(proc.stdout)["status"], "infeasible")

    def test_cli_missing_field_exit_2_stderr_json(self):
        req = base_request()
        del req["duration_min"]
        proc = self.run_cli(json.dumps(req))
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(proc.stdout, "")
        error = json.loads(proc.stderr)
        self.assertEqual(error["code"], "BAD_INPUT")

    def test_cli_start_ge_end_exit_2(self):
        req = base_request()
        req["start"] = req["end"]
        proc = self.run_cli(json.dumps(req))
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(json.loads(proc.stderr)["code"], "BAD_INPUT")

    def test_cli_malformed_json_exit_2(self):
        proc = self.run_cli("{not json")
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(json.loads(proc.stderr)["code"], "BAD_INPUT")


if __name__ == "__main__":
    unittest.main()
