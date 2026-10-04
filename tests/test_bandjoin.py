import itertools
import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

from bandjoin import BandJoin, InputError, load_stream, pair_sort_key, validate_event

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def reference_join(seq, bound, left_skew=0, right_skew=0):
    """Independent, deliberately simple nested-loop reference.

    Keeps every accepted event forever (no eviction) and matches each new
    event against the full opposite buffer.
    """
    max_ts = {"L": None, "R": None}
    skew = {"L": left_skew, "R": right_skew}
    seen = {"L": set(), "R": set()}
    buf = {"L": [], "R": []}
    pairs = []
    counts = {s: {"input": 0, "accepted": 0, "duplicates": 0, "late": 0} for s in "LR"}
    for side, ev in seq:
        counts[side]["input"] += 1
        if ev["id"] in seen[side]:
            counts[side]["duplicates"] += 1
            continue
        wms = [max_ts[s] - skew[s] for s in "LR" if max_ts[s] is not None]
        threshold = max(wms) - bound if wms else None
        if threshold is not None and ev["ts"] < threshold:
            counts[side]["late"] += 1
            continue
        seen[side].add(ev["id"])
        counts[side]["accepted"] += 1
        if max_ts[side] is None or ev["ts"] > max_ts[side]:
            max_ts[side] = ev["ts"]
        other = "R" if side == "L" else "L"
        for cand in buf[other]:
            if cand["key"] == ev["key"] and abs(cand["ts"] - ev["ts"]) <= bound:
                pairs.append((ev, cand) if side == "L" else (cand, ev))
        buf[side].append(ev)
    out = [
        {"l_id": l["id"], "r_id": r["id"], "key": l["key"], "ts_l": l["ts"], "ts_r": r["ts"]}
        for l, r in pairs
    ]
    out.sort(key=pair_sort_key)
    return out, counts


def run_join(seq, bound, left_skew=0, right_skew=0):
    join = BandJoin(bound, left_skew=left_skew, right_skew=right_skew)
    for side, ev in seq:
        join.add(side, ev)
    stats = join.stats()
    counts = {"L": stats["left"], "R": stats["right"]}
    return join.finalise(), counts


def interleave(left_seq, right_seq):
    seq = []
    for i in range(max(len(left_seq), len(right_seq))):
        if i < len(left_seq):
            seq.append(("L", left_seq[i]))
        if i < len(right_seq):
            seq.append(("R", right_seq[i]))
    return seq


def ev(id_, key, ts):
    return {"id": id_, "key": key, "ts": ts}


class PermutationVsReferenceTest(unittest.TestCase):
    """n<=12: exhaustive per-side permutations against the nested-loop reference."""

    def _check(self, left_events, right_events, bound, lskew=0, rskew=0):
        for lp in itertools.permutations(left_events):
            for rp in itertools.permutations(right_events):
                seq = interleave(list(lp), list(rp))
                got, got_counts = run_join(seq, bound, lskew, rskew)
                want, want_counts = reference_join(seq, bound, lskew, rskew)
                self.assertEqual(got, want, msg=f"seq={seq} bound={bound}")
                self.assertEqual(got_counts, want_counts, msg=f"counts seq={seq}")

    def test_permutations_n_up_to_5_per_side(self):
        left = [ev(f"l{i}", "ab"[i % 2], 5 * i) for i in range(5)]
        right = [ev(f"r{i}", "ab"[(i + 1) % 2], 3 + 5 * i) for i in range(5)]
        for n in range(1, 6):
            with self.subTest(n=n):
                self._check(left[:n], right[:n], bound=10)

    def test_permutations_with_skew_and_bound_zero(self):
        left = [ev(f"l{i}", "k", 4 * i) for i in range(4)]
        right = [ev(f"r{i}", "k", 4 * i) for i in range(4)]
        self._check(left, right, bound=0, lskew=3, rskew=5)

    def test_random_total_n_up_to_12(self):
        rng = random.Random(20261005)
        for trial in range(300):
            n_left = rng.randint(0, 6)
            n_right = rng.randint(0, 12 - n_left)
            left = [ev(f"l{i}", rng.choice("ab"), rng.randint(0, 40)) for i in range(n_left)]
            right = [ev(f"r{i}", rng.choice("ab"), rng.randint(0, 40)) for i in range(n_right)]
            rng.shuffle(left)
            rng.shuffle(right)
            bound = rng.choice([0, 1, 7, 20])
            seq = interleave(left, right)
            got, got_counts = run_join(seq, bound)
            want, want_counts = reference_join(seq, bound)
            self.assertEqual(got, want, msg=f"trial={trial} seq={seq}")
            self.assertEqual(got_counts, want_counts, msg=f"counts trial={trial}")


class BoundEdgeTest(unittest.TestCase):
    def test_bound_5000_inclusive_and_exclusive(self):
        # Skew of 10000 keeps every event here within its side's watermark,
        # so only the band predicate decides matches.
        join = BandJoin(5000, left_skew=10000, right_skew=10000)
        join.add_left(ev("l1", "k", 10000))
        join.add_right(ev("r_in_hi", "k", 15000))   # diff == 5000 -> match
        join.add_right(ev("r_out_hi", "k", 15001))  # diff 5001 -> no match
        join.add_right(ev("r_in_lo", "k", 5000))    # diff == 5000 -> match
        join.add_right(ev("r_out_lo", "k", 4999))   # diff 5001 -> no match
        pairs = join.finalise()
        self.assertEqual([p["r_id"] for p in pairs], ["r_in_lo", "r_in_hi"])
        self.assertEqual(pairs[0]["ts_r"], 5000)
        self.assertEqual(pairs[1]["ts_r"], 15000)

    def test_bound_zero_requires_equal_ts(self):
        join = BandJoin(0)
        join.add_left(ev("l1", "k", 42))
        join.add_right(ev("r_eq", "k", 42))
        join.add_right(ev("r_off", "k", 43))
        pairs = join.finalise()
        self.assertEqual(len(pairs), 1)
        self.assertEqual(pairs[0]["r_id"], "r_eq")

    def test_key_must_match(self):
        join = BandJoin(5000)
        join.add_left(ev("l1", "a", 100))
        join.add_right(ev("r1", "b", 100))
        self.assertEqual(join.finalise(), [])


class DuplicateAndDisorderTest(unittest.TestCase):
    def test_duplicate_id_first_occurrence_wins(self):
        join = BandJoin(10)
        join.add_left(ev("l1", "k", 100))
        join.add_left(ev("l1", "k", 999))  # duplicate logical event
        join.add_right(ev("r1", "k", 105))
        pairs = join.finalise()
        self.assertEqual(len(pairs), 1)
        self.assertEqual(pairs[0]["ts_l"], 100)
        self.assertEqual(join.stats()["left"]["duplicates"], 1)

    def test_extreme_out_of_order_dropped_and_counted(self):
        join = BandJoin(10)
        join.add_left(ev("l1", "k", 1000))
        join.add_left(ev("l2", "k", 5))  # ts 5 < 1000 - 10 -> late
        self.assertEqual(join.stats()["left"]["late"], 1)
        self.assertEqual(join.finalise(), [])

    def test_out_of_order_within_bound_survives_and_matches(self):
        join = BandJoin(10)
        join.add_left(ev("l1", "k", 1000))
        join.add_left(ev("l2", "k", 995))  # out of order but not late
        join.add_right(ev("r1", "k", 990))
        pairs = join.finalise()
        self.assertEqual({p["l_id"] for p in pairs}, {"l1", "l2"})

    def test_lateness_uses_max_of_both_watermarks(self):
        join = BandJoin(10, left_skew=0, right_skew=0)
        join.add_left(ev("l1", "k", 100))   # LWM = 100 -> threshold = 90
        join.add_right(ev("r1", "k", 95))   # accepted; RWM = 95
        join.add_right(ev("r2", "k", 85))   # 85 < 90 -> late via LWM, though RWM is 95
        join.add_right(ev("r3", "k", 92))   # 92 >= 90 -> accepted
        stats = join.stats()["right"]
        self.assertEqual(stats["late"], 1)
        self.assertEqual(stats["accepted"], 2)

    def test_not_yet_due_is_not_unsatisfiable(self):
        # Low watermarks must not cause premature drops: an early event
        # still matches a much later event within bound.
        join = BandJoin(100)
        join.add_left(ev("l1", "k", 0))
        join.add_right(ev("r1", "k", 100))
        self.assertEqual(len(join.finalise()), 1)


class EmptySideTest(unittest.TestCase):
    def test_one_side_empty_finalises_with_no_matches(self):
        join = BandJoin(5000)
        join.add_left(ev("l1", "k", 1))
        join.add_left(ev("l2", "k", 2))
        self.assertEqual(join.finalise(), [])
        stats = join.stats()
        self.assertEqual(stats["left"]["accepted"], 2)
        self.assertEqual(stats["right"]["input"], 0)
        self.assertIsNone(stats["right_watermark"])


class ValidationTest(unittest.TestCase):
    def test_validate_event_rejects_bad_records(self):
        for bad in (
            [],
            {"id": 1, "key": "k"},
            {"id": True, "key": "k", "ts": 1},
            {"id": 1, "key": "k", "ts": "1"},
            {"id": 1, "key": {}, "ts": 1},
        ):
            with self.assertRaises(InputError, msg=bad):
                validate_event(bad)

    def test_load_stream_rejects_bad_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "bad.jsonl")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write('{"id": 1, "key": "k", "ts": 1}\nnot json\n')
            with self.assertRaises(InputError):
                load_stream(path)


class CliTest(unittest.TestCase):
    def _write(self, dir_, name, rows):
        path = os.path.join(dir_, name)
        with open(path, "w", encoding="utf-8") as fh:
            for row in rows:
                fh.write(row if isinstance(row, str) else json.dumps(row))
                fh.write("\n")
        return path

    def _run_cli(self, *argv):
        return subprocess.run(
            [sys.executable, "-m", "bandjoin", *argv],
            cwd=REPO_ROOT, capture_output=True, text=True,
        )

    def test_cli_end_to_end_matches_reference(self):
        with tempfile.TemporaryDirectory() as tmp:
            left = [ev(f"l{i}", "ab"[i % 2], 5000 * i) for i in range(6)]
            right = [ev(f"r{i}", "ab"[i % 2], 2500 + 5000 * i) for i in range(6)]
            lp = self._write(tmp, "L.jsonl", left)
            rp = self._write(tmp, "R.jsonl", right)
            out = os.path.join(tmp, "pairs.jsonl")
            proc = self._run_cli("--left", lp, "--right", rp, "--bound", "5000", "--out", out)
            self.assertEqual(proc.returncode, 0, msg=proc.stderr)
            with open(out, encoding="utf-8") as fh:
                got = [json.loads(line) for line in fh]
            from bandjoin.__main__ import _merge_by_ts
            want, _ = reference_join(_merge_by_ts(left, right), 5000)
            self.assertEqual(got, want)
            stats = json.loads(proc.stderr)
            self.assertEqual(stats["pairs"], len(want))

    def test_cli_bound_edge_5000(self):
        with tempfile.TemporaryDirectory() as tmp:
            lp = self._write(tmp, "L.jsonl", [ev("l1", "k", 10000)])
            rp = self._write(tmp, "R.jsonl", [ev("r_in", "k", 15000), ev("r_out", "k", 15001)])
            out = os.path.join(tmp, "pairs.jsonl")
            proc = self._run_cli("--left", lp, "--right", rp, "--bound", "5000", "--out", out)
            self.assertEqual(proc.returncode, 0, msg=proc.stderr)
            with open(out, encoding="utf-8") as fh:
                got = [json.loads(line) for line in fh]
            self.assertEqual([p["r_id"] for p in got], ["r_in"])

    def test_cli_bad_line_exit_2_and_no_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            lp = self._write(tmp, "L.jsonl", ['{"id": 1, "key": "k", "ts": 1}', '{"id": 2}'])
            rp = self._write(tmp, "R.jsonl", [ev("r1", "k", 1)])
            out = os.path.join(tmp, "pairs.jsonl")
            proc = self._run_cli("--left", lp, "--right", rp, "--bound", "5000", "--out", out)
            self.assertEqual(proc.returncode, 2, msg=proc.stderr)
            self.assertFalse(os.path.exists(out))
            self.assertFalse(os.path.exists(out + ".tmp"))

    def test_cli_empty_right_still_finalises(self):
        with tempfile.TemporaryDirectory() as tmp:
            lp = self._write(tmp, "L.jsonl", [ev("l1", "k", 1), ev("l2", "k", 2)])
            rp = self._write(tmp, "R.jsonl", [])
            out = os.path.join(tmp, "pairs.jsonl")
            proc = self._run_cli("--left", lp, "--right", rp, "--bound", "5000", "--out", out)
            self.assertEqual(proc.returncode, 0, msg=proc.stderr)
            with open(out, encoding="utf-8") as fh:
                self.assertEqual(fh.read(), "")
            stats = json.loads(proc.stderr)
            self.assertEqual(stats["left"]["accepted"], 2)
            self.assertEqual(stats["pairs"], 0)


if __name__ == "__main__":
    unittest.main()
