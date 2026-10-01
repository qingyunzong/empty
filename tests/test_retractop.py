"""Tests for retractop: differential vs brute force, ties, lateness, invalids."""

import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

from retractop import Engine, Event, ParseError, parse_line


def id_sort(ident):
    return (1, ident) if isinstance(ident, str) else (0, ident)


def reference_run(events, k, win, allowed_lateness=0):
    """Brute-force reference: recomputes each window's TopK from the global
    active set at every emission point.  Returns (out, invalid, dropped)."""
    active = {}          # id -> (key, score, ts)
    known_starts = set() # windows that ever held an item
    finalized = set()
    emitted = {}         # start -> last emitted topk tuple
    out, invalid, dropped = [], 0, 0
    wm = None

    def topk(start):
        rows = [
            (key, score, ident)
            for ident, (key, score, ts) in active.items()
            if (ts // win) * win == start
        ]
        rows.sort(key=lambda r: (-r[1], r[0], id_sort(r[2])))
        return tuple(rows[:k])

    def emit(start):
        new, old = topk(start), emitted.get(start, ())
        if new == old:
            return
        for row in old:
            if row not in new:
                out.append({"op": "-", "window_end": start + win,
                            "key": row[0], "score": row[1], "id": row[2]})
        for row in new:
            if row not in old:
                out.append({"op": "+", "window_end": start + win,
                            "key": row[0], "score": row[1], "id": row[2]})
        emitted[start] = new

    def finalize_ready():
        for start in sorted(known_starts):
            if start not in finalized and start + win <= wm:
                finalized.add(start)
                emit(start)

    def is_final(start):
        return start in finalized or (wm is not None and start + win <= wm)

    def apply(ev):
        nonlocal invalid, dropped
        start = (ev.ts // win) * win
        if ev.op == "add":
            if ev.id in active:
                invalid += 1
                return
            if is_final(start):
                if wm <= start + win + allowed_lateness:
                    active[ev.id] = (ev.key, ev.score, ev.ts)
                    emit(start)
                else:
                    dropped += 1
                return
            active[ev.id] = (ev.key, ev.score, ev.ts)
            known_starts.add(start)
        elif ev.op == "retract":
            cur = active.get(ev.id)
            if cur is None or cur[0] != ev.key or cur[1] != ev.score:
                invalid += 1
                return
            start = (cur[2] // win) * win
            if is_final(start):
                if wm <= start + win + allowed_lateness:
                    del active[ev.id]
                    emit(start)
                else:
                    dropped += 1
                return
            del active[ev.id]
        else:
            invalid += 1

    for ev in events:
        if wm is None or ev.ts > wm:
            wm = ev.ts
        finalize_ready()
        apply(ev)
    for start in sorted(known_starts):
        if start not in finalized:
            finalized.add(start)
            emit(start)
    return out, invalid, dropped


def engine_run(events, k, win, allowed_lateness=0):
    eng = Engine(k=k, win=win, allowed_lateness=allowed_lateness)
    for ev in events:
        eng.process(ev)
    eng.finish()
    return eng.out, eng.invalid, eng.dropped


class TestDifferential(unittest.TestCase):
    """Acceptance 1: random add/retract sequences (n<=8) vs brute force."""

    def random_events(self, rng, n, win):
        events = []
        ids = [1, 2, 3, "x"]
        keys = ["a", "b"]
        for _ in range(n):
            op = rng.choice(["add", "add", "retract", "retract", "bogus"])
            events.append(
                Event(
                    op=op,
                    ts=rng.randrange(0, 4 * win),
                    key=rng.choice(keys),
                    score=rng.choice([1, 2, 2, 3]),
                    id=rng.choice(ids),
                )
            )
        return events

    def test_random_small_sequences(self):
        trials = 0
        for seed in range(400):
            rng = random.Random(seed)
            win = rng.choice([10, 1000])
            k = rng.choice([1, 2, 3, 5])
            lateness = rng.choice([0, 0, win // 2, win])
            n = rng.randrange(0, 9)
            events = self.random_events(rng, n, win)
            got = engine_run(events, k, win, lateness)
            want = reference_run(events, k, win, lateness)
            self.assertEqual(got, want, f"seed={seed} events={events}")
            trials += 1
        self.assertGreater(trials, 0)

    def test_deterministic_replay(self):
        rng = random.Random(7)
        events = self.random_events(rng, 8, 100)
        first = engine_run(events, 3, 100, 50)
        second = engine_run(list(events), 3, 100, 50)
        self.assertEqual(first, second)


class TestTies(unittest.TestCase):
    """Acceptance 2: same score, same key, different ids -> id asc."""

    def test_tie_break_by_id(self):
        events = [
            Event("add", 10, "a", 5, 3),
            Event("add", 20, "a", 5, 1),
            Event("add", 30, "a", 5, 2),
            Event("add", 40, "b", 5, 0),  # key asc beats id
        ]
        out, invalid, _ = engine_run(events, k=3, win=1000)
        self.assertEqual(invalid, 0)
        plus = [r for r in out if r["op"] == "+"]
        # same score: key "a" rows rank first, tie-broken by id asc
        self.assertEqual([r["id"] for r in plus], [1, 2, 3])
        self.assertEqual([r["key"] for r in plus], ["a", "a", "a"])

    def test_score_desc_primary(self):
        events = [
            Event("add", 1, "z", 1, 1),
            Event("add", 2, "a", 9, 2),
            Event("add", 3, "m", 5, 3),
        ]
        out, _, _ = engine_run(events, k=3, win=1000)
        self.assertEqual([r["id"] for r in out], [2, 3, 1])

    def test_fewer_than_k_outputs_actual(self):
        events = [Event("add", 1, "a", 1, 1), Event("add", 2, "b", 2, 2)]
        out, _, _ = engine_run(events, k=5, win=1000)
        self.assertEqual(len([r for r in out if r["op"] == "+"]), 2)


class TestLateness(unittest.TestCase):
    """Acceptance 3: late correction within allowed_lateness, drop beyond."""

    def test_late_retract_correction_and_drop(self):
        events = [
            Event("add", 100, "a", 5, 1),      # window [0,1000)
            Event("add", 1200, "b", 7, 2),     # wm=1200 -> finalizes [0,1000)
            Event("retract", 1200, "a", 5, 1), # late, wm=1200 <= 1000+500: correct
            Event("add", 200, "c", 9, 3),      # late add, still within lateness
            Event("add", 2000, "d", 1, 4),     # wm=2000 > 1500
            Event("retract", 2000, "c", 9, 3), # too old -> dropped
        ]
        out, invalid, dropped = engine_run(events, k=3, win=1000, allowed_lateness=500)
        self.assertEqual(invalid, 0)
        self.assertEqual(dropped, 1)
        marks = [(r["op"], r["window_end"], r["id"]) for r in out]
        self.assertEqual(
            marks,
            [
                ("+", 1000, 1),  # finalize [0,1000)
                ("-", 1000, 1),  # late retract correction
                ("+", 1000, 3),  # late add correction
                ("+", 2000, 2),  # finalize [1000,2000)
                ("+", 3000, 4),  # finalize [2000,3000) at EOF
            ],
        )

    def test_zero_lateness_drops_immediately(self):
        events = [
            Event("add", 100, "a", 5, 1),
            Event("add", 1000, "b", 6, 2),  # wm=1000 finalizes [0,1000)
            Event("retract", 1000, "a", 5, 1),  # wm=1000 <= 1000+0: allowed
            Event("add", 2000, "c", 1, 3),
            Event("retract", 2000, "a", 5, 1),  # id 1 already gone -> invalid
        ]
        out, invalid, dropped = engine_run(events, k=2, win=1000, allowed_lateness=0)
        self.assertEqual(dropped, 0)
        self.assertEqual(invalid, 1)
        self.assertIn({"op": "-", "window_end": 1000, "key": "a", "score": 5, "id": 1}, out)

    def test_watermark_never_regresses(self):
        events = [
            Event("add", 5000, "a", 1, 1),
            Event("add", 10, "b", 2, 2),   # far in the past, window final, lateness 0
            Event("add", 6000, "c", 3, 3),
        ]
        out, invalid, dropped = engine_run(events, k=2, win=1000, allowed_lateness=0)
        self.assertEqual(dropped, 1)
        self.assertEqual(invalid, 0)


class TestInvalid(unittest.TestCase):
    """Acceptance 4: invalid retract / duplicate add / unknown op counting."""

    def test_invalid_retracts(self):
        events = [
            Event("retract", 1, "a", 1, 99),        # unknown id
            Event("add", 2, "a", 1, 1),
            Event("retract", 3, "a", 2, 1),         # score mismatch
            Event("retract", 4, "b", 1, 1),         # key mismatch
            Event("retract", 5, "a", 1, 1),         # ok
            Event("retract", 6, "a", 1, 1),         # already retracted
            Event("add", 7, "a", 1, 1),
            Event("add", 8, "x", 9, 1),             # duplicate id
            Event("frobnicate", 9, "a", 1, 2),      # unknown op
        ]
        out, invalid, dropped = engine_run(events, k=3, win=1000)
        self.assertEqual(invalid, 6)
        self.assertEqual(dropped, 0)
        # id 1 re-added at ts=7 survives -> one final + row
        self.assertEqual(
            out, [{"op": "+", "window_end": 1000, "key": "a", "score": 1, "id": 1}]
        )

    def test_retract_nonexistent_does_not_crash(self):
        eng = Engine(k=1, win=10)
        eng.process(Event("retract", 0, "a", 1, "nope"))
        eng.finish()
        self.assertEqual(eng.invalid, 1)
        self.assertEqual(eng.out, [])


class TestParse(unittest.TestCase):
    def test_bad_lines_raise(self):
        for line in [
            "not json",
            "[1,2]",
            '{"op":"add","ts":1,"key":"a","score":1}',          # missing id
            '{"op":"add","ts":"1","key":"a","score":1,"id":1}', # bad ts
            '{"op":"add","ts":1,"key":2,"score":1,"id":1}',     # bad key
            '{"op":"add","ts":1,"key":"a","score":"x","id":1}', # bad score
            '{"op":"add","ts":true,"key":"a","score":1,"id":1}',
        ]:
            with self.assertRaises(ParseError, msg=line):
                parse_line(line)

    def test_unknown_op_parses_but_counts_invalid(self):
        ev = parse_line('{"op":"upsert","ts":1,"key":"a","score":1,"id":1}')
        self.assertEqual(ev.op, "upsert")


class TestCli(unittest.TestCase):
    def run_cli(self, lines, *extra):
        with tempfile.NamedTemporaryFile(
            "w", suffix=".jsonl", delete=False, encoding="utf-8"
        ) as fh:
            fh.write("\n".join(lines) + "\n")
            path = fh.name
        try:
            return subprocess.run(
                [sys.executable, "-m", "retractop", "--in", path,
                 "--k", "3", "--win", "1000", *extra],
                capture_output=True,
                text=True,
            )
        finally:
            os.unlink(path)

    def test_cli_happy_path(self):
        proc = self.run_cli(
            [
                '{"op":"add","ts":100,"key":"a","score":5,"id":1}',
                '{"op":"add","ts":200,"key":"b","score":7,"id":2}',
                '{"op":"retract","ts":300,"key":"a","score":5,"id":1}',
                '{"op":"oops","ts":400,"key":"c","score":1,"id":3}',
            ]
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        rows = [json.loads(l) for l in proc.stdout.strip().splitlines()]
        self.assertEqual(
            rows,
            [
                {"op": "+", "window_end": 1000, "id": 2, "key": "b", "score": 7},
            ],
        )
        summary = json.loads(proc.stderr.strip())
        self.assertEqual(summary, {"invalid": 1, "dropped": 0})

    def test_cli_bad_line_exit_2(self):
        proc = self.run_cli(
            [
                '{"op":"add","ts":100,"key":"a","score":5,"id":1}',
                "{broken",
            ]
        )
        self.assertEqual(proc.returncode, 2)
        self.assertIn("line 2", proc.stderr)

    def test_cli_unknown_op_does_not_abort(self):
        proc = self.run_cli(
            [
                '{"op":"weird","ts":1,"key":"a","score":1,"id":1}',
                '{"op":"add","ts":2,"key":"a","score":1,"id":2}',
            ]
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn('"invalid": 1', proc.stderr)


if __name__ == "__main__":
    unittest.main()
