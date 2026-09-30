"""Acceptance tests for the wmagg library and CLI.

Runs the real CLI via `python -m wmagg` in subprocesses and compares against
an independent offline reference implementation of the specified semantics.
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from wmagg.core import WindowAggregator, Event, parse_event, InputError  # noqa: E402


def reference(events, window, out_of_order, idle_timeout):
    """Offline reference: processes the given event sequence and returns
    (outputs, lates) per the specified watermark semantics."""
    wm = None
    max_ts = {}
    acc = {}
    outputs = []
    lates = []
    for ev in events:
        if wm is not None and ev["ts"] < wm - out_of_order:
            lates.append(ev)
            continue
        src = ev["src"]
        if src not in max_ts or ev["ts"] > max_ts[src]:
            max_ts[src] = ev["ts"]
        global_max = max(max_ts.values())
        active_min = min(m for m in max_ts.values() if global_max - m <= idle_timeout)
        candidate = max(0, active_min) - out_of_order
        wm = candidate if wm is None else max(wm, candidate)
        start = (ev["ts"] // window) * window
        acc[(start, ev["key"])] = acc.get((start, ev["key"]), 0) + ev["val"]
        for key in sorted(k for k in acc if k[0] + window <= wm):
            outputs.append(
                {
                    "start": key[0],
                    "end": key[0] + window,
                    "key": key[1],
                    "sum": acc.pop(key),
                }
            )
    return outputs, lates


def write_jsonl(path, records):
    with open(path, "w", encoding="utf-8") as fh:
        for rec in records:
            fh.write(json.dumps(rec) + "\n")


def read_jsonl(path):
    with open(path, "r", encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "wmagg", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )


class CliCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.input = self.tmp / "events.jsonl"
        self.out = self.tmp / "out.jsonl"
        self.late = self.tmp / "late.jsonl"

    def tearDown(self):
        self._tmp.cleanup()

    def run_wmagg(self, events, window, out_of_order, idle_timeout):
        write_jsonl(self.input, events)
        proc = run_cli(
            "--input", str(self.input),
            "--out", str(self.out),
            "--late", str(self.late),
            "--window", str(window),
            "--out-of-order", str(out_of_order),
            "--idle-timeout", str(idle_timeout),
        )
        return proc


class TestThreeSourcesIdleRevival(CliCase):
    """Acceptance 1: 3 srcs with idle + revival, compared window-by-window
    against the offline-sorted reference algorithm."""

    W, S, I = 100, 10, 50

    def build_events(self):
        events = []
        keys = ["k1", "k2", "k3"]
        for i, ts in enumerate(range(0, 601, 20)):      # src A: steady
            events.append({"src": "A", "ts": ts, "key": keys[i % 3], "val": i % 5 + 1})
        for i, ts in enumerate(range(7, 601, 20)):      # src B: steady, offset
            events.append({"src": "B", "ts": ts, "key": keys[(i + 1) % 3], "val": i % 4 + 1})
        for i, ts in enumerate([0, 10, 30, 590, 610]):  # src C: goes idle, revives
            events.append({"src": "C", "ts": ts, "key": keys[(i + 2) % 3], "val": 10 + i})
        # Offline sort by event time, then inject bounded disorder (<= S)
        # by swapping a few adjacent pairs; both CLI and reference see the
        # exact same sequence.
        events.sort(key=lambda e: e["ts"])
        for i in (3, 11, 22):
            events[i], events[i + 1] = events[i + 1], events[i]
        return events

    def test_matches_reference_window_by_window(self):
        events = self.build_events()
        proc = self.run_wmagg(events, self.W, self.S, self.I)
        self.assertEqual(proc.returncode, 0, proc.stderr)

        exp_out, exp_late = reference(events, self.W, self.S, self.I)
        got_out = read_jsonl(self.out)
        got_late = read_jsonl(self.late)

        self.assertEqual(got_out, exp_out)
        self.assertEqual(got_late, exp_late)
        self.assertGreater(len(got_out), 0)

        # Scenario really exercised idle + revival of src C.
        c_ts = [e["ts"] for e in events if e["src"] == "C"]
        self.assertGreater(590 - 30, self.I)  # silent gap exceeds idle timeout
        late_ts = {e["ts"] for e in got_late}
        self.assertNotIn(590, late_ts)  # revival events accepted, not late
        self.assertNotIn(610, late_ts)
        self.assertIn(590, c_ts)

        # In-process aggregator agrees with the CLI on the same sequence.
        agg = WindowAggregator(self.W, self.S, self.I)
        for e in events:
            agg.process(Event(e["src"], e["ts"], e["key"], e["val"]))
        self.assertEqual(agg.outputs, got_out)
        self.assertEqual([e.as_dict() for e in agg.lates], got_late)


class TestWatermarkBoundary(CliCase):
    """Acceptance 2: end == WM finalises; end == WM + 1 does not."""

    def test_end_equal_wm_triggers(self):
        agg = WindowAggregator(window=10, out_of_order=0, idle_timeout=1000)
        agg.process(Event("A", 5, "x", 1))
        agg.process(Event("A", 9, "x", 2))
        # WM = 9, window [0, 10) has end = 10 = WM + 1 -> not finalised.
        self.assertEqual(agg.watermark, 9)
        self.assertEqual(agg.outputs, [])
        agg.process(Event("A", 10, "y", 7))
        # WM = 10, end = 10 <= WM -> finalised exactly at the boundary.
        self.assertEqual(agg.watermark, 10)
        self.assertEqual(
            agg.outputs, [{"start": 0, "end": 10, "key": "x", "sum": 3}]
        )
        # Window [10, 20) has end = 20 > WM -> still open.

    def test_boundary_via_cli(self):
        events = [
            {"src": "A", "ts": 5, "key": "x", "val": 1},
            {"src": "A", "ts": 9, "key": "x", "val": 2},
            {"src": "A", "ts": 10, "key": "y", "val": 7},
        ]
        proc = self.run_wmagg(events, 10, 0, 1000)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(
            read_jsonl(self.out), [{"start": 0, "end": 10, "key": "x", "sum": 3}]
        )
        self.assertEqual(read_jsonl(self.late), [])


class TestOutOfOrderAndLate(CliCase):
    """Acceptance 3: same key out-of-order across S, late drops counted."""

    def test_late_drops_and_sums(self):
        events = [
            {"src": "A", "ts": 100, "key": "k", "val": 1},
            {"src": "A", "ts": 103, "key": "k", "val": 2},
            {"src": "A", "ts": 97, "key": "k", "val": 4},    # out of order, accepted
            {"src": "A", "ts": 120, "key": "k", "val": 8},
            {"src": "A", "ts": 90, "key": "k", "val": 16},   # late: 90 < WM(115)-S(5)
            {"src": "A", "ts": 114, "key": "k", "val": 32},  # accepted
            {"src": "A", "ts": 50, "key": "k", "val": 64},   # late
            {"src": "A", "ts": 125, "key": "k", "val": 128},
        ]
        proc = self.run_wmagg(events, 10, 5, 1000)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(
            read_jsonl(self.out),
            [
                {"start": 90, "end": 100, "key": "k", "sum": 4},
                {"start": 100, "end": 110, "key": "k", "sum": 3},
                {"start": 110, "end": 120, "key": "k", "sum": 32},
            ],
        )
        late = read_jsonl(self.late)
        self.assertEqual(len(late), 2)
        self.assertEqual([e["ts"] for e in late], [90, 50])
        # Late events must not correct already-finalised windows.
        self.assertNotIn(
            {"start": 90, "end": 100, "key": "k", "sum": 20}, read_jsonl(self.out)
        )


class TestEmptyAndSingleEvent(CliCase):
    """Acceptance 4: empty input and single-event boundary."""

    def test_empty_input(self):
        proc = self.run_wmagg([], 100, 10, 50)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(read_jsonl(self.out), [])
        self.assertEqual(read_jsonl(self.late), [])

    def test_single_event_no_finalised_window(self):
        events = [{"src": "A", "ts": 0, "key": "k", "val": 5}]
        proc = self.run_wmagg(events, 100, 10, 50)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        # WM = 0 - 10 < 0; window [0, 100) never reaches end <= WM.
        self.assertEqual(read_jsonl(self.out), [])
        self.assertEqual(read_jsonl(self.late), [])

    def test_single_event_larger_ts(self):
        events = [{"src": "A", "ts": 250, "key": "k", "val": 5}]
        proc = self.run_wmagg(events, 100, 10, 50)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        # WM = 240; window [200, 300) end = 300 > 240 -> not finalised.
        self.assertEqual(read_jsonl(self.out), [])
        self.assertEqual(read_jsonl(self.late), [])


class TestInputErrors(CliCase):
    """Bad JSON, missing fields, ts < 0 -> exit 2, stderr, no partial output."""

    def assert_input_error(self, lines, needle):
        with open(self.input, "w", encoding="utf-8") as fh:
            fh.writelines(lines)
        proc = run_cli(
            "--input", str(self.input),
            "--out", str(self.out),
            "--late", str(self.late),
            "--window", "10",
            "--out-of-order", "5",
            "--idle-timeout", "100",
        )
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertIn(needle, proc.stderr)
        self.assertFalse(self.out.exists(), "partial output must not be written")
        self.assertFalse(self.late.exists(), "partial late output must not be written")

    def test_bad_json(self):
        self.assert_input_error(
            ['{"src": "A", "ts": 1, "key": "k", "val": 1}\n', "not json\n"],
            "invalid JSON",
        )

    def test_missing_field(self):
        self.assert_input_error(
            ['{"src": "A", "ts": 1, "key": "k"}\n'], "missing field"
        )

    def test_negative_ts(self):
        self.assert_input_error(
            ['{"src": "A", "ts": -1, "key": "k", "val": 1}\n'], ">= 0"
        )

    def test_no_partial_output_before_error(self):
        self.assert_input_error(
            [
                '{"src": "A", "ts": 1, "key": "k", "val": 1}\n',
                '{"src": "A", "ts": 2, "key": "k", "val": 2}\n',
                '{"src": "A", "ts": "x", "key": "k", "val": 3}\n',
            ],
            "integer",
        )

    def test_missing_input_file(self):
        proc = run_cli(
            "--input", str(self.tmp / "nope.jsonl"),
            "--out", str(self.out),
            "--late", str(self.late),
            "--window", "10",
            "--out-of-order", "5",
            "--idle-timeout", "100",
        )
        self.assertEqual(proc.returncode, 2)
        self.assertTrue(proc.stderr.strip())
        self.assertFalse(self.out.exists())


class TestWatermarkMonotonic(unittest.TestCase):
    """WM must never regress, e.g. when a revived src lowers the min."""

    def test_no_regress_on_revival(self):
        agg = WindowAggregator(window=10, out_of_order=5, idle_timeout=20)
        agg.process(Event("A", 100, "k", 1))
        agg.process(Event("B", 100, "k", 1))
        agg.process(Event("A", 200, "k", 1))  # B goes idle, WM jumps to 195
        self.assertEqual(agg.watermark, 195)
        agg.process(Event("B", 192, "k", 1))  # B revives with lower max ts
        self.assertEqual(agg.watermark, 195)  # WM stays, never moves back


class TestParseEvent(unittest.TestCase):
    def test_valid(self):
        ev = parse_event('{"src": "A", "ts": 3, "key": "k", "val": 1.5}', 1)
        self.assertEqual((ev.src, ev.ts, ev.key, ev.val), ("A", 3, "k", 1.5))

    def test_errors(self):
        for line in (
            "{bad",
            "[1, 2]",
            '{"src": "A", "ts": 1, "key": "k"}',
            '{"src": "A", "ts": -2, "key": "k", "val": 1}',
            '{"src": "A", "ts": true, "key": "k", "val": 1}',
            '{"src": "A", "ts": 1, "key": "k", "val": "x"}',
        ):
            with self.assertRaises(InputError, msg=line):
                parse_event(line, 1)


if __name__ == "__main__":
    unittest.main()
