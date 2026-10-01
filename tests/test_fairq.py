"""Acceptance tests for fairq (see README.md for the semantics spec)."""

import json
import random
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from fairq import simulate  # noqa: E402


def reference_simulate(events, window=100):
    """Independent event-by-event simulator used to cross-check fairq.

    Written in a deliberately different style: events are bucketed per
    timestamp, ratios are compared by cross-multiplication instead of
    fractions, and flows are plain dicts.
    """
    buckets = {}
    for position, event in enumerate(events):
        buckets.setdefault(event["t"], []).append((position, event))
    flows = {}
    finish = {}
    starved = []
    capacity = 1
    for t in sorted(buckets):
        group = [event for _, event in buckets[t]]
        submits = sorted(
            (e for e in group if e["type"] == "submit"), key=lambda e: e["flow"]
        )
        for event in submits:
            flows[event["flow"]] = {
                "remaining": event["size"],
                "served": 0,
                "weight": max(1, event["prio"]),
                "submit_t": t,
                "last": None,
                "starved": False,
            }
        for event in (e for e in group if e["type"] == "capacity"):
            capacity = event["c"]
        for event in (e for e in group if e["type"] == "tick"):
            served_any = False
            for _ in range(capacity):
                best_id = None
                for fid, flow in flows.items():
                    if flow["remaining"] <= 0 or flow["submit_t"] >= t:
                        continue
                    if best_id is None:
                        best_id = fid
                        continue
                    best = flows[best_id]
                    left = flow["served"] * best["weight"]
                    right = best["served"] * flow["weight"]
                    if left < right or (left == right and fid < best_id):
                        best_id = fid
                if best_id is None:
                    break
                flow = flows[best_id]
                flow["remaining"] -= 1
                flow["served"] += 1
                flow["last"] = t
                served_any = True
                if flow["remaining"] == 0:
                    finish[best_id] = t
            if not served_any:
                continue
            for fid, flow in flows.items():
                if flow["remaining"] <= 0 or flow["starved"]:
                    continue
                if flow["submit_t"] > t:
                    continue
                ref = flow["last"] if flow["last"] is not None else flow["submit_t"]
                if t - ref > window:
                    flow["starved"] = True
                    starved.append(fid)
    return finish, sorted(starved)


def run_cli(*args, cwd=ROOT):
    return subprocess.run(
        [sys.executable, "-m", "fairq", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
    )


def serve_sequence(log_lines):
    return [
        int(line.split("flow=")[1].split()[0])
        for line in log_lines
        if " tick serve " in line
    ]


class TestAAlternation(unittest.TestCase):
    """A: two equal-weight flows alternate exactly, smaller flow id first."""

    def test_alternating_service_sequence(self):
        events = [
            {"type": "capacity", "t": 0, "c": 1},
            {"type": "submit", "t": 0, "flow": 1, "size": 3, "prio": 1},
            {"type": "submit", "t": 0, "flow": 2, "size": 3, "prio": 1},
        ] + [{"type": "tick", "t": t} for t in range(1, 7)]
        result, log = simulate(events)
        self.assertEqual(serve_sequence(log), [1, 2, 1, 2, 1, 2])
        self.assertEqual(result["flows"]["1"]["finish_t"], 5)
        self.assertEqual(result["flows"]["2"]["finish_t"], 6)
        self.assertEqual(result["starved"], [])


class TestBWeightedRatio(unittest.TestCase):
    """B: prio 3 vs prio 1 at capacity 1 converges to a 3:1 service ratio."""

    def test_weighted_ratio(self):
        events = [
            {"type": "submit", "t": 0, "flow": 1, "size": 100, "prio": 3},
            {"type": "submit", "t": 0, "flow": 2, "size": 100, "prio": 1},
        ] + [{"type": "tick", "t": t} for t in range(1, 21)]
        _, log = simulate(events)
        seq = serve_sequence(log)
        first10 = seq[:10]
        # Integer unit service cannot split 10 units as 7.5:2.5; the
        # deterministic schedule yields the closest split 7:3 ...
        self.assertEqual((first10.count(1), first10.count(2)), (7, 3))
        # ... and the exact 3:1 ratio over 20 ticks.
        self.assertEqual((seq.count(1), seq.count(2)), (15, 5))
        self.assertEqual(seq.count(1) / seq.count(2), 3.0)


class TestCNoImmediatePreemption(unittest.TestCase):
    """C: an arrival does not preempt the current tick, only the next one."""

    def test_preemption_takes_effect_next_tick(self):
        events = [
            {"type": "submit", "t": 0, "flow": 1, "size": 10, "prio": 1},
            {"type": "submit", "t": 5, "flow": 2, "size": 1, "prio": 5},
        ] + [{"type": "tick", "t": t} for t in range(1, 13)]
        result, log = simulate(events)
        by_t = {}
        for line in log:
            parts = line.split()
            by_t.setdefault(int(parts[0][2:]), []).append(line)
        # tick at t=5 still serves the long flow (no immediate preemption)
        self.assertIn("t=5 tick serve flow=1 remaining=5", by_t[5])
        # the newly arrived high-prio flow is served at the next tick
        self.assertIn("t=6 tick serve flow=2 remaining=0", by_t[6])
        self.assertIn("t=6 finish flow=2 finish_t=6", by_t[6])
        # then the long flow resumes
        self.assertIn("t=7 tick serve flow=1 remaining=4", by_t[7])
        self.assertEqual(result["flows"]["2"]["finish_t"], 6)
        self.assertEqual(result["flows"]["1"]["finish_t"], 11)


class TestDCrossCheck(unittest.TestCase):
    """D: cross-check finish_t and starved against the reference simulator."""

    def make_events(self, rng):
        events = []
        n = rng.randint(1, 6)
        for fid in range(1, n + 1):
            events.append({
                "type": "submit",
                "t": rng.randint(0, 19),
                "flow": fid,
                "size": rng.randint(1, 8),
                "prio": rng.randint(0, 4),
            })
        for _ in range(rng.randint(0, 3)):
            events.append({
                "type": "capacity",
                "t": rng.randint(0, 19),
                "c": rng.randint(1, 3),
            })
        for t in range(20):
            for _ in range(rng.randint(1, 2)):
                events.append({"type": "tick", "t": t})
        events.sort(key=lambda e: e["t"])  # stable: keeps same-t input order
        return events

    def check(self, events, window):
        result, _ = simulate(events, window=window)
        ref_finish, ref_starved = reference_simulate(events, window=window)
        got_finish = {
            int(fid): f["finish_t"]
            for fid, f in result["flows"].items()
            if f["finish_t"] is not None
        }
        self.assertEqual(got_finish, ref_finish)
        self.assertEqual(result["starved"], ref_starved)

    def test_random_small_cases(self):
        for seed in range(40):
            rng = random.Random(seed)
            events = self.make_events(rng)
            with self.subTest(seed=seed):
                self.check(events, window=100)

    def test_random_small_cases_tight_window(self):
        # window=3 exercises the starvation path within 20 ticks
        saw_starvation = False
        for seed in range(40):
            rng = random.Random(1000 + seed)
            events = self.make_events(rng)
            with self.subTest(seed=1000 + seed):
                self.check(events, window=3)
            if reference_simulate(events, window=3)[1]:
                saw_starvation = True
        self.assertTrue(saw_starvation, "starvation path was never exercised")


class TestEDeterminism(unittest.TestCase):
    """E: identical input produces byte-identical logs across 5 runs."""

    EVENTS = [
        {"type": "capacity", "c": 2},
        {"type": "submit", "t": 0, "flow": 1, "size": 7, "prio": 3},
        {"type": "submit", "t": 0, "flow": 2, "size": 5, "prio": 1},
    ] + [{"type": "tick", "t": t} for t in range(1, 3)] + [
        {"type": "submit", "t": 3, "flow": 3, "size": 2, "prio": 2},
    ] + [{"type": "tick", "t": t} for t in range(3, 6)] + [
        {"type": "capacity", "t": 6, "c": 1},
    ] + [{"type": "tick", "t": t} for t in range(6, 16)]

    def test_five_runs_byte_identical(self):
        with tempfile.TemporaryDirectory() as tmp:
            events_path = Path(tmp) / "events.json"
            events_path.write_text(json.dumps(self.EVENTS), encoding="utf-8")
            outputs = []
            for run in range(5):
                out_path = Path(tmp) / f"result{run}.json"
                log_path = Path(tmp) / f"log{run}.txt"
                proc = run_cli("run", str(events_path),
                               "--out", str(out_path), "--log", str(log_path))
                self.assertEqual(proc.returncode, 0, proc.stderr)
                outputs.append((out_path.read_bytes(), log_path.read_bytes()))
            for out_bytes, log_bytes in outputs[1:]:
                self.assertEqual(out_bytes, outputs[0][0])
                self.assertEqual(log_bytes, outputs[0][1])


class TestErrors(unittest.TestCase):
    """Invalid input exits with code 2 and a JSON error on stderr."""

    def run_bad(self, events):
        with tempfile.TemporaryDirectory() as tmp:
            events_path = Path(tmp) / "events.json"
            events_path.write_text(json.dumps(events), encoding="utf-8")
            proc = run_cli("run", str(events_path),
                           "--out", str(Path(tmp) / "r.json"),
                           "--log", str(Path(tmp) / "l.txt"))
        self.assertEqual(proc.returncode, 2, proc.stderr)
        payload = json.loads(proc.stderr)
        self.assertIn("error", payload)
        return payload["error"]

    def test_negative_size(self):
        error = self.run_bad([{"type": "submit", "t": 0, "flow": 1,
                               "size": -1, "prio": 1}])
        self.assertIn("negative size", error)

    def test_non_positive_capacity(self):
        error = self.run_bad([{"type": "capacity", "c": 0}])
        self.assertIn("capacity", error)

    def test_time_regression(self):
        error = self.run_bad([
            {"type": "tick", "t": 5},
            {"type": "tick", "t": 4},
        ])
        self.assertIn("time regression", error)


class TestCliSample(unittest.TestCase):
    """The README sample events file runs cleanly through the CLI."""

    def test_sample_events(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_path = Path(tmp) / "result.json"
            log_path = Path(tmp) / "log.txt"
            proc = run_cli("run", str(ROOT / "events.json"),
                           "--out", str(out_path), "--log", str(log_path))
            self.assertEqual(proc.returncode, 0, proc.stderr)
            result = json.loads(out_path.read_text(encoding="utf-8"))
            self.assertIn("flows", result)
            self.assertIn("starved", result)
            self.assertTrue(log_path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
