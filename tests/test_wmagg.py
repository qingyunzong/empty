import json
import os
import subprocess
import sys
import tempfile
import unittest

from wmagg import Aggregator, run

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def write_jsonl(path, events):
    with open(path, "w", encoding="utf-8") as fh:
        for ev in events:
            fh.write(json.dumps(ev) + "\n")


def read_jsonl(path):
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def run_cli(tmpdir, events_or_raw, *extra_args):
    """Run  in a temp dir; returns (proc, out_path, late_path)."""
    input_path = os.path.join(tmpdir, "events.jsonl")
    out_path = os.path.join(tmpdir, "out.jsonl")
    late_path = os.path.join(tmpdir, "late.jsonl")
    if isinstance(events_or_raw, str):
        with open(input_path, "w", encoding="utf-8") as fh:
            fh.write(events_or_raw)
    else:
        write_jsonl(input_path, events_or_raw)
    cmd = [
        sys.executable,
        "-m",
        "wmagg",
        "--input",
        input_path,
        "--out",
        out_path,
        "--late",
        late_path,
        *extra_args,
    ]
    proc = subprocess.run(
        cmd, cwd=REPO_ROOT, capture_output=True, text=True
    )
    return proc, out_path, late_path


def reference_sorted(events, window, lateness, idle_timeout):
    """Independent offline reference.

    Sorts events by ts, replays the watermark rule to find the final
    watermark, then groups every event into its tumbling window. With
    ts-sorted input no event can be late, and every window finalised by
    the streaming run has seen all of its events, so the two must agree.
    """
    evs = sorted(events, key=lambda e: (e["ts"], e["src"], e["key"]))
    src_max = {}
    global_max = 0
    wm = 0
    for ev in evs:
        global_max = max(global_max, ev["ts"])
        src_max[ev["src"]] = max(src_max.get(ev["src"], 0), ev["ts"])
        active = [m for m in src_max.values() if global_max - m <= idle_timeout]
        if active:
            wm = max(wm, max(0, min(active) - lateness))
    sums = {}
    for ev in evs:
        start = (ev["ts"] // window) * window
        if start + window <= wm:
            sums.setdefault((start, ev["key"]), 0)
            sums[(start, ev["key"])] += ev["val"]
    return sums


class TestThreeSourcesIdleRevive(unittest.TestCase):
    """Acceptance 1: 3 sources with idle + revive, vs offline reference."""

    W, S, I = 100, 20, 150

    def _events(self):
        events = []
        keys = ["k1", "k2"]

        def emit(src, t, n=1):
            for j in range(n):
                events.append(
                    {"src": src, "ts": t, "key": keys[(t // 30 + j) % 2], "val": (t + j) % 7 + 1}
                )

        # Phase 1: all three sources active together.
        for t in range(0, 301, 30):
            for src in ("A", "B", "C"):
                emit(src, t)
        # Phase 2: A goes silent; B and C keep advancing event time so A
        # becomes idle (gap > I) and stops pinning the watermark.
        for t in range(330, 601, 30):
            for src in ("B", "C"):
                emit(src, t)
        # Phase 3: A revives; all three active again.
        for t in range(630, 901, 30):
            for src in ("A", "B", "C"):
                emit(src, t)
        return events

    def test_matches_offline_sorted_reference(self):
        events = self._events()
        srcs = {e["src"] for e in events}
        self.assertEqual(srcs, {"A", "B", "C"})
        events.sort(key=lambda e: (e["ts"], e["src"], e["key"]))

        agg = Aggregator(self.W, self.S, self.I)
        for ev in events:
            agg.add(ev["src"], ev["ts"], ev["key"], ev["val"])

        # Sanity: idleness actually engaged. While A is silent the watermark
        # must advance past A's last ts (300) - impossible if A stayed active.
        self.assertGreater(agg.watermark, 300 - self.S)
        # Sanity: revival actually happened (A emits again after the gap).
        a_ts = [e["ts"] for e in events if e["src"] == "A"]
        self.assertGreater(max(a_ts) - min(a_ts), self.I)

        expected = reference_sorted(events, self.W, self.S, self.I)
        got = {}
        for rec in agg.outputs:
            got[(rec["start"], rec["key"])] = rec["sum"]
        self.assertEqual(got, expected)
        self.assertEqual(agg.late_count, 0)
        # Every finalised window satisfies end <= watermark.
        for rec in agg.outputs:
            self.assertLessEqual(rec["end"], agg.watermark)


class TestFinaliseBoundary(unittest.TestCase):
    """Acceptance 2: end == WM finalises, end == WM + 1 does not."""

    def test_end_equal_wm_triggers(self):
        agg = Aggregator(window=10, lateness=0, idle_timeout=10**9)
        agg.add("A", 5, "k", 1)
        self.assertEqual(agg.outputs, [])
        agg.add("A", 19, "k", 2)
        # WM = 19: window [10, 20) has end == WM + 1 -> not finalised.
        self.assertEqual(agg.watermark, 19)
        self.assertEqual(
            agg.outputs, [{"start": 0, "end": 10, "key": "k", "sum": 1}]
        )
        agg.add("A", 20, "k", 4)
        # WM = 20: window [10, 20) has end == WM -> finalised.
        self.assertEqual(agg.watermark, 20)
        self.assertEqual(
            agg.outputs,
            [
                {"start": 0, "end": 10, "key": "k", "sum": 1},
                {"start": 10, "end": 20, "key": "k", "sum": 2},
            ],
        )

    def test_watermark_never_regresses(self):
        agg = Aggregator(window=10, lateness=5, idle_timeout=10**9)
        agg.add("A", 100, "k", 1)
        self.assertEqual(agg.watermark, 95)
        agg.add("B", 10, "k", 1)  # new active source with tiny ts
        self.assertEqual(agg.watermark, 95)


class TestOutOfOrderAndLate(unittest.TestCase):
    """Acceptance 3: in-S reordering counted, late events dropped+counted."""

    def test_reorder_and_late(self):
        agg = Aggregator(window=100, lateness=10, idle_timeout=10**9)
        agg.add("A", 150, "k", 1)   # WM = 140, window [100,200)
        agg.add("A", 145, "k", 2)   # out of order within S -> counted
        agg.add("A", 250, "k", 4)   # WM = 240 -> [100,200) finalises, sum 3
        agg.add("A", 100, "k", 8)   # 100 < WM - S = 230 -> late
        agg.add("A", 260, "k", 16)  # in [200,300), still open -> counted
        agg.add("A", 400, "k", 32)  # WM = 390 -> [200,300) finalises

        self.assertEqual(
            agg.outputs,
            [
                {"start": 100, "end": 200, "key": "k", "sum": 3},
                {"start": 200, "end": 300, "key": "k", "sum": 20},
            ],
        )
        self.assertEqual(agg.late_count, 1)
        self.assertEqual(agg.late[0]["ts"], 100)
        self.assertEqual(agg.late[0]["val"], 8)

    def test_late_file_via_cli(self):
        events = [
            {"src": "A", "ts": 150, "key": "k", "val": 1},
            {"src": "A", "ts": 145, "key": "k", "val": 2},
            {"src": "A", "ts": 250, "key": "k", "val": 4},
            {"src": "A", "ts": 100, "key": "k", "val": 8},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            proc, out_path, late_path = run_cli(
                tmp, events, "--window", "100", "--lateness", "10",
                "--idle-timeout", "1000000",
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            out = read_jsonl(out_path)
            self.assertEqual(
                out, [{"start": 100, "end": 200, "key": "k", "sum": 3}]
            )
            late = read_jsonl(late_path)
            self.assertEqual(len(late), 1)
            self.assertEqual(late[0]["ts"], 100)


class TestEmptyAndSingleEvent(unittest.TestCase):
    """Acceptance 4: empty input and single-event boundaries."""

    def test_empty_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc, out_path, late_path = run_cli(
                tmp, [], "--window", "10", "--lateness", "0",
                "--idle-timeout", "1000",
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(read_jsonl(out_path), [])
            self.assertEqual(read_jsonl(late_path), [])

    def test_single_event_no_finalise(self):
        agg = Aggregator(window=10, lateness=0, idle_timeout=1000)
        agg.add("A", 0, "k", 5)
        self.assertEqual(agg.watermark, 0)
        self.assertEqual(agg.outputs, [])
        self.assertEqual(agg.late_count, 0)

    def test_single_event_on_window_boundary(self):
        # ts = 10 lands in [10, 20); WM = 10 finalises [0, 10) which is empty.
        agg = Aggregator(window=10, lateness=0, idle_timeout=1000)
        agg.add("A", 10, "k", 5)
        self.assertEqual(agg.watermark, 10)
        self.assertEqual(agg.outputs, [])
        self.assertEqual(agg.late_count, 0)
        # A later event finalises the window containing the first one.
        agg.add("A", 20, "k", 1)
        self.assertEqual(
            agg.outputs, [{"start": 10, "end": 20, "key": "k", "sum": 5}]
        )

    def test_single_event_left_closed_right_open(self):
        # ts exactly at end of [0,10) belongs to [10,20), not [0,10).
        agg = Aggregator(window=10, lateness=0, idle_timeout=1000)
        agg.add("A", 9, "k", 1)
        agg.add("A", 10, "k", 2)
        agg.add("A", 25, "k", 3)
        self.assertEqual(
            agg.outputs,
            [
                {"start": 0, "end": 10, "key": "k", "sum": 1},
                {"start": 10, "end": 20, "key": "k", "sum": 2},
            ],
        )


class TestInputErrors(unittest.TestCase):
    """Bad input -> exit 2, stderr message, no partial output files."""

    ARGS = ("--window", "10", "--lateness", "0", "--idle-timeout", "1000")

    def _check_error(self, raw):
        with tempfile.TemporaryDirectory() as tmp:
            proc, out_path, late_path = run_cli(tmp, raw, *self.ARGS)
            self.assertEqual(proc.returncode, 2, proc.stderr)
            self.assertNotEqual(proc.stderr.strip(), "")
            self.assertFalse(os.path.exists(out_path), "partial out.jsonl written")
            self.assertFalse(os.path.exists(late_path), "partial late.jsonl written")

    def test_bad_json(self):
        self._check_error('{"src": "A", "ts": 1, "key": "k", "val": 1}\n{bad json}\n')

    def test_missing_field(self):
        self._check_error('{"src": "A", "ts": 1, "key": "k"}\n')

    def test_negative_ts(self):
        self._check_error('{"src": "A", "ts": -1, "key": "k", "val": 1}\n')

    def test_partial_results_not_written(self):
        raw = (
            '{"src": "A", "ts": 5, "key": "k", "val": 1}\n'
            '{"src": "A", "ts": 20, "key": "k", "val": 2}\n'
            '{"src": "A", "ts": -3, "key": "k", "val": 3}\n'
        )
        self._check_error(raw)

    def test_not_an_object(self):
        self._check_error('[1, 2, 3]\n')


if __name__ == "__main__":
    unittest.main()
