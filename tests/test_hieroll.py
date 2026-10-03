import json
import math
import os
import random
import subprocess
import sys
import tempfile
import unittest

from hieroll import HierRoll

LAYER_SIZES = [("1m", 60), ("5m", 300), ("1h", 3600)]
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def reference(events, late):
    """Naive from-scratch recomputation used as an oracle.

    Recomputes every window sum by grouping all accepted events instead of
    maintaining incremental state.  Returns (records, dropped).
    """
    records = []
    dropped = 0
    states = {}
    for key, ts, delta in events:
        st = states.setdefault(key, {"max_ts": None, "accepted": [], "versions": {}})
        if st["max_ts"] is None or ts > st["max_ts"]:
            st["max_ts"] = ts
            wm = st["max_ts"] - late
            for name, size in LAYER_SIZES:
                starts = sorted({int(math.floor(t / size)) * size for t, _ in st["accepted"]})
                for start in starts:
                    if start + size <= wm and (size, start) not in st["versions"]:
                        total = sum(d for t, d in st["accepted"] if start <= t < start + size)
                        st["versions"][(size, start)] = 1
                        records.append({"key": key, "layer": name, "start": start,
                                        "end": start + size, "sum": total, "version": 1})
        wm = st["max_ts"] - late
        if ts < wm - late:
            dropped += 1
            continue
        st["accepted"].append((ts, delta))
        for name, size in LAYER_SIZES:
            start = int(math.floor(ts / size)) * size
            if start + size <= wm:
                total = sum(d for t, d in st["accepted"] if start <= t < start + size)
                version = st["versions"].get((size, start), 0) + 1
                st["versions"][(size, start)] = version
                records.append({"key": key, "layer": name, "start": start,
                                "end": start + size, "sum": total, "version": version})
    for key, st in states.items():
        for name, size in LAYER_SIZES:
            starts = sorted({int(math.floor(t / size)) * size for t, _ in st["accepted"]})
            for start in starts:
                if (size, start) not in st["versions"]:
                    total = sum(d for t, d in st["accepted"] if start <= t < start + size)
                    records.append({"key": key, "layer": name, "start": start,
                                    "end": start + size, "sum": total, "version": 1})
    return records, dropped


def run(events, late):
    roll = HierRoll(late=late)
    records = []
    for key, ts, delta in events:
        records.extend(r.to_dict() for r in roll.add(key, ts, delta))
    records.extend(r.to_dict() for r in roll.close())
    return records, roll.dropped


class TestRandomizedAgainstReference(unittest.TestCase):
    """Acceptance 1: n<=9 random +/- deltas vs recomputed reference."""

    def test_random_trials(self):
        rng = random.Random(20261004)
        trials = 0
        for _ in range(300):
            n = rng.randint(1, 9)
            keys = ["a", "b"][: rng.randint(1, 2)]
            late = rng.choice([0, 30, 60, 300, 2000])
            events = [
                (rng.choice(keys), rng.randint(0, 4000), rng.randint(-9, 9))
                for _ in range(n)
            ]
            expected_records, expected_dropped = reference(events, late)
            actual_records, actual_dropped = run(events, late)
            self.assertEqual(actual_records, expected_records,
                             f"events={events} late={late}")
            self.assertEqual(actual_dropped, expected_dropped,
                             f"events={events} late={late}")
            trials += 1
        self.assertEqual(trials, 300)

    def test_versions_increment_per_layer(self):
        rng = random.Random(7)
        for _ in range(100):
            n = rng.randint(1, 9)
            late = rng.choice([0, 60, 300])
            events = [("k", rng.randint(0, 3000), rng.randint(-5, 5)) for _ in range(n)]
            records, _ = run(events, late)
            seen = {}
            for rec in records:
                ident = (rec["key"], rec["layer"], rec["start"])
                seen[ident] = seen.get(ident, 0) + 1
                self.assertEqual(rec["version"], seen[ident])
                self.assertLess(rec["start"], rec["end"])
                self.assertIn(rec["layer"], ("1m", "5m", "1h"))


class TestCorrectionOnlyLeafWhenAncestorsNotFinal(unittest.TestCase):
    """Acceptance 2: correction in a final 1m window whose 5m/1h ancestors
    are not final must re-emit only the 1m layer."""

    def test_only_1m_reemitted(self):
        late = 60
        events = [("k", 10, 5), ("k", 125, 1), ("k", 10, 3)]
        roll = HierRoll(late=late)
        out0 = roll.add("k", 10, 5)
        out1 = roll.add("k", 125, 1)
        out2 = roll.add("k", 10, 3)
        self.assertEqual(out0, [])
        self.assertEqual([r.to_dict() for r in out1],
                         [{"key": "k", "layer": "1m", "start": 0, "end": 60,
                           "sum": 5, "version": 1}])
        # The correction touches only the final 1m window; 5m/1h absorb silently.
        self.assertEqual([r.to_dict() for r in out2],
                         [{"key": "k", "layer": "1m", "start": 0, "end": 60,
                           "sum": 8, "version": 2}])
        flushed = [r.to_dict() for r in roll.close()]
        self.assertEqual(flushed, [
            {"key": "k", "layer": "1m", "start": 120, "end": 180, "sum": 1, "version": 1},
            {"key": "k", "layer": "5m", "start": 0, "end": 300, "sum": 9, "version": 1},
            {"key": "k", "layer": "1h", "start": 0, "end": 3600, "sum": 9, "version": 1},
        ])
        self.assertEqual(roll.dropped, 0)


class TestCascadeAcrossThreeLayers(unittest.TestCase):
    """Acceptance 3: one late event cascades versioned re-emissions of the
    leaf window and all final ancestors, leaf first."""

    def test_three_level_cascade(self):
        late = 2000
        roll = HierRoll(late=late)
        roll.add("k", 2000, 1)
        finals = roll.add("k", 5600, 1)  # WM = 3600 finalizes 1h [0,3600)
        self.assertEqual([r.layer for r in finals], ["1m", "5m", "1h"])
        cascade = roll.add("k", 2001, 4)
        self.assertEqual([r.to_dict() for r in cascade], [
            {"key": "k", "layer": "1m", "start": 1980, "end": 2040, "sum": 5, "version": 2},
            {"key": "k", "layer": "5m", "start": 1800, "end": 2100, "sum": 5, "version": 2},
            {"key": "k", "layer": "1h", "start": 0, "end": 3600, "sum": 5, "version": 2},
        ])
        self.assertEqual(roll.dropped, 0)


class TestTooLateDropped(unittest.TestCase):
    """Acceptance 4: events older than WM - late are dropped and counted."""

    def test_drop_after_final(self):
        roll = HierRoll(late=60)
        roll.add("k", 10, 5)
        roll.add("k", 200, 1)  # WM = 140, finalizes 1m [0,60)
        out = roll.add("k", 50, 7)  # 50 < 140 - 60 -> too late
        self.assertEqual(out, [])
        self.assertEqual(roll.dropped, 1)
        flushed = [r.to_dict() for r in roll.close()]
        # The dropped delta must not appear anywhere: 5m sum stays 5 + 1 = 6.
        self.assertIn({"key": "k", "layer": "5m", "start": 0, "end": 300,
                       "sum": 6, "version": 1}, flushed)
        self.assertIn({"key": "k", "layer": "1h", "start": 0, "end": 3600,
                       "sum": 6, "version": 1}, flushed)


class TestCli(unittest.TestCase):
    def _run_cli(self, lines, extra_args=()):
        with tempfile.TemporaryDirectory() as tmp:
            in_path = os.path.join(tmp, "e.jsonl")
            out_path = os.path.join(tmp, "roll.jsonl")
            with open(in_path, "w", encoding="utf-8") as fh:
                fh.write("\n".join(lines) + "\n")
            proc = subprocess.run(
                [sys.executable, "-m", "hieroll", "--in", in_path, "--out", out_path,
                 *extra_args],
                cwd=REPO_ROOT, capture_output=True, text=True)
            records = []
            if os.path.exists(out_path):
                with open(out_path, encoding="utf-8") as fh:
                    records = [json.loads(line) for line in fh if line.strip()]
            return proc, records

    def test_cli_end_to_end(self):
        lines = [
            json.dumps({"key": "k", "ts": 2000, "delta": 1}),
            json.dumps({"key": "k", "ts": 5600, "delta": 1}),
            json.dumps({"key": "k", "ts": 2001, "delta": -4}),
        ]
        proc, records = self._run_cli(lines, ["--late", "2000"])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(records[:4], [
            {"key": "k", "layer": "1m", "start": 1980, "end": 2040, "sum": 1, "version": 1},
            {"key": "k", "layer": "5m", "start": 1800, "end": 2100, "sum": 1, "version": 1},
            {"key": "k", "layer": "1h", "start": 0, "end": 3600, "sum": 1, "version": 1},
            {"key": "k", "layer": "1m", "start": 1980, "end": 2040, "sum": -3, "version": 2},
        ])
        stats = json.loads(proc.stderr.strip())
        self.assertEqual(stats["dropped"], 0)

    def test_cli_matches_library(self):
        rng = random.Random(99)
        events = [("k", rng.randint(0, 4000), rng.randint(-9, 9)) for _ in range(9)]
        lines = [json.dumps({"key": k, "ts": t, "delta": d}) for k, t, d in events]
        proc, records = self._run_cli(lines, ["--late", "300"])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        expected, _ = run(events, 300)
        self.assertEqual(records, expected)

    def test_cli_non_integer_delta_exit2(self):
        for bad in ['{"key": "k", "ts": 1, "delta": 1.5}',
                    '{"key": "k", "ts": 1, "delta": "3"}',
                    '{"key": "k", "ts": 1, "delta": true}']:
            proc, _ = self._run_cli([bad])
            self.assertEqual(proc.returncode, 2, bad)
            self.assertIn("delta", proc.stderr)


if __name__ == "__main__":
    unittest.main()
