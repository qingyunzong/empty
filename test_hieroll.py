import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

from hieroll import HierRoll, LAYERS

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))


def reference_chains(events, late):
    """Independent recomputation of the expected output.

    Returns (chains, dropped) where chains maps
    (layer, key, window_start) -> [(value, version), ...] in emission order.
    """
    max_ts = None
    wms = []
    accepted = []  # (idx, key, ts, delta)
    dropped = 0
    for idx, (key, ts, delta) in enumerate(events):
        max_ts = ts if max_ts is None else max(max_ts, ts)
        wm = max_ts - late
        wms.append(wm)
        if ts < wm - late:
            dropped += 1
        else:
            accepted.append((idx, key, ts, delta))

    chains = {}
    for name, size in LAYERS:
        groups = {}
        for idx, key, ts, delta in accepted:
            start = (ts // size) * size
            groups.setdefault((key, start), []).append((idx, delta))
        for (key, start), items in groups.items():
            end = start + size
            first_idx = items[0][0]
            fin_idx = None
            for i in range(first_idx, len(events)):
                if wms[i] >= end:
                    fin_idx = i
                    break
            if fin_idx is None:
                continue  # window never finalized
            value = 0
            pos = 0
            while pos < len(items) and items[pos][0] <= fin_idx:
                value += items[pos][1]
                pos += 1
            chain = [(value, 1)]
            version = 1
            while pos < len(items):
                value += items[pos][1]
                version += 1
                chain.append((value, version))
                pos += 1
            chains[(name, key, start)] = chain
    return chains, dropped


def run_roll(events, late):
    roll = HierRoll(late=late)
    records = []
    for key, ts, delta in events:
        records.extend(roll.add(key, ts, delta))
    chains = {}
    for rec in records:
        chain_key = (rec["layer"], rec["key"], rec["start"])
        chains.setdefault(chain_key, []).append((rec["value"], rec["version"]))
    return chains, roll.dropped, records


class RandomizedReferenceTest(unittest.TestCase):
    """Acceptance 1: n<=9 random +/- deltas vs recomputed reference,
    verifying every layer and every version chain."""

    def test_random_against_reference(self):
        for seed in range(200):
            rng = random.Random(seed)
            late = rng.choice([0, 1, 30, 60, 300, 1000])
            n = rng.randint(1, 9)
            events = [
                (rng.choice(["a", "b"]), rng.randint(0, 5000),
                 rng.randint(-9, 9))
                for _ in range(n)
            ]
            with self.subTest(seed=seed, late=late, events=events):
                exp_chains, exp_dropped = reference_chains(events, late)
                got_chains, got_dropped, records = run_roll(events, late)
                self.assertEqual(got_dropped, exp_dropped)
                self.assertEqual(got_chains, exp_chains)
                # versions must be 1..k sequential per window
                for chain_key, chain in got_chains.items():
                    self.assertEqual(
                        [v for _, v in chain],
                        list(range(1, len(chain) + 1)),
                        f"non-sequential versions in {chain_key}",
                    )
                # end/start alignment and layer sizes
                sizes = dict(LAYERS)
                for rec in records:
                    self.assertEqual(rec["end"] - rec["start"],
                                     sizes[rec["layer"]])
                    self.assertEqual(rec["start"] % sizes[rec["layer"]], 0)


class LeafOnlyCorrectionTest(unittest.TestCase):
    """Acceptance 2: a correction crossing a 1m boundary but not the 5m
    boundary must re-emit only the 1m layer (no ancestor re-emission,
    no unchanged-layer re-emission)."""

    def test_correction_only_emits_1m(self):
        roll = HierRoll(late=30)
        out = []
        out += roll.add("k", 0, 5)     # 1m[0,60) 5m[0,300) 1h[0,3600)
        out += roll.add("k", 100, 1)   # WM=70 -> finalizes 1m[0,60) v1=5
        self.assertEqual([(r["layer"], r["value"], r["version"]) for r in out],
                         [("1m", 5, 1)])
        # Late correction lands in finalized 1m[0,60); its 5m/1h windows
        # are not final yet, so only the 1m leaf may be re-emitted.
        corrections = roll.add("k", 50, 2)
        self.assertEqual(
            [(r["layer"], r["start"], r["value"], r["version"])
             for r in corrections],
            [("1m", 0, 7, 2)],
        )
        # The 5m accumulator silently absorbed the correction: when the
        # 5m window later finalizes it carries the corrected value once.
        more = roll.add("k", 400, 0)   # WM=370 -> finalizes 5m[0,300)
        finals_5m = [r for r in more if r["layer"] == "5m"]
        self.assertEqual([(r["value"], r["version"]) for r in finals_5m],
                         [(8, 1)])


class CascadeCorrectionTest(unittest.TestCase):
    """Acceptance 3: one late event whose 1m/5m/1h windows are all final
    cascades a version+1 re-emission across all three layers."""

    def test_cascade_all_three_layers(self):
        roll = HierRoll(late=3600)
        out = []
        out += roll.add("k", 0, 1)
        out += roll.add("k", 7200, 2)  # WM=3600 -> finalizes [0,..) all layers
        finals = [(r["layer"], r["value"], r["version"]) for r in out]
        self.assertEqual(finals, [("1m", 1, 1), ("5m", 1, 1), ("1h", 1, 1)])
        # ts=10 >= WM-late = 0: accepted; hits finalized windows on all layers.
        corrections = roll.add("k", 10, 4)
        self.assertEqual(
            [(r["layer"], r["start"], r["value"], r["version"])
             for r in corrections],
            [("1m", 0, 5, 2), ("5m", 0, 5, 2), ("1h", 0, 5, 2)],
        )
        self.assertEqual(roll.dropped, 0)


class TooLateDropTest(unittest.TestCase):
    """Acceptance 4: after final, an event older than WM-late is dropped
    and counted, emitting nothing."""

    def test_too_late_dropped_and_counted(self):
        roll = HierRoll(late=100)
        out = []
        out += roll.add("k", 0, 1)
        out += roll.add("k", 500, 2)   # WM=400 -> 1m[0,60), 5m[0,300) final
        self.assertEqual([(r["layer"], r["value"], r["version"]) for r in out],
                         [("1m", 1, 1), ("5m", 1, 1)])
        # ts=250 < WM-late = 300: too late even though its 1m window is final.
        emitted = roll.add("k", 250, 7)
        self.assertEqual(emitted, [])
        self.assertEqual(roll.dropped, 1)
        # A still-allowed event (ts >= WM-late) is not dropped.
        emitted = roll.add("k", 350, 3)
        self.assertEqual(roll.dropped, 1)
        self.assertEqual(
            [(r["layer"], r["start"], r["value"], r["version"])
             for r in emitted],
            [("1m", 300, 3, 1)],  # first event of 1m[300,360): finalizes now
        )


class CliTest(unittest.TestCase):
    def _run_cli(self, lines, extra_args=()):
        with tempfile.TemporaryDirectory() as tmp:
            inp = os.path.join(tmp, "e.jsonl")
            out = os.path.join(tmp, "roll.jsonl")
            with open(inp, "w", encoding="utf-8") as f:
                for line in lines:
                    f.write(line if line.endswith("\n") else line + "\n")
            proc = subprocess.run(
                [sys.executable, "-m", "hieroll",
                 "--in", inp, "--out", out, *extra_args],
                cwd=REPO_ROOT, capture_output=True, text=True,
            )
            out_lines = []
            if os.path.exists(out):
                with open(out, encoding="utf-8") as f:
                    out_lines = [json.loads(l) for l in f if l.strip()]
            return proc, out_lines

    def test_cli_end_to_end(self):
        proc, records = self._run_cli([
            '{"key":"a","ts":0,"delta":5}',
            '{"key":"a","ts":100,"delta":-2}',
            '{"key":"b","ts":100,"delta":3}',
        ], extra_args=["--late", "30"])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("dropped=0", proc.stderr)
        self.assertEqual(
            [(r["key"], r["layer"], r["start"], r["value"], r["version"])
             for r in records],
            [("a", "1m", 0, 5, 1)],
        )

    def test_cli_negative_delta_and_correction(self):
        proc, records = self._run_cli([
            '{"key":"a","ts":0,"delta":5}',
            '{"key":"a","ts":100,"delta":1}',
            '{"key":"a","ts":50,"delta":-2}',
        ], extra_args=["--late", "30"])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(
            [(r["layer"], r["value"], r["version"]) for r in records],
            [("1m", 5, 1), ("1m", 3, 2)],
        )

    def test_cli_non_integer_delta_exit2(self):
        for bad in ['{"key":"a","ts":0,"delta":1.5}',
                    '{"key":"a","ts":0,"delta":"x"}',
                    '{"key":"a","ts":0,"delta":true}',
                    '{"key":"a","ts":0}',
                    'not json']:
            with self.subTest(bad=bad):
                proc, _ = self._run_cli([bad])
                self.assertEqual(proc.returncode, 2, proc.stderr)

    def test_cli_too_late_drop_count(self):
        proc, records = self._run_cli([
            '{"key":"a","ts":0,"delta":1}',
            '{"key":"a","ts":500,"delta":2}',
            '{"key":"a","ts":250,"delta":7}',
        ], extra_args=["--late", "100"])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("dropped=1", proc.stderr)
        self.assertEqual(
            [(r["layer"], r["value"], r["version"]) for r in records],
            [("1m", 1, 1), ("5m", 1, 1)],
        )


if __name__ == "__main__":
    unittest.main()
