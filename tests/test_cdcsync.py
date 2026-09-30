"""Acceptance tests for cdcsync (scenarios A/B/C/D)."""
from __future__ import annotations

import itertools
import json
import os
import random
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from cdcsync import apply_log, chain_events, dump_kv, dumps_log  # noqa: E402


def reference_state(events):
    """Independent reference: dedupe by (src, seq), replay in (src, seq)
    total order onto a plain dict."""
    uniq = {}
    for ev in events:
        uniq.setdefault((ev["src"], ev["seq"]), ev)
    state = {}
    for key in sorted(uniq):
        ev = uniq[key]
        if ev["op"] == "put":
            state[ev["key"]] = ev["value"]
        else:
            state.pop(ev["key"], None)
    return state


def make_events(spec):
    """spec: list of (src, seq, op, key, value) tuples; ts auto-assigned."""
    return [
        {"src": s, "seq": q, "op": o, "key": k, "value": v, "ts": float(i)}
        for i, (s, q, o, k, v) in enumerate(spec)
    ]


class CliMixin:
    def run_cli(self, *args, env_extra=None):
        env = dict(os.environ)
        if env_extra:
            env.update(env_extra)
        return subprocess.run(
            [sys.executable, "-m", "cdcsync", *args],
            cwd=ROOT, env=env, capture_output=True, text=True,
        )


class TestRandomLog(CliMixin, unittest.TestCase):
    """A: 200 random events with duplicates and disorder vs reference."""

    def test_random_200_events_match_reference(self):
        rng = random.Random(20260930)
        srcs = ["alpha", "beta", "gamma", "delta"]
        keys = [f"k{i}" for i in range(12)]
        spec = []
        for src in srcs:
            for seq in range(1, 51):
                op = "put" if rng.random() < 0.75 else "del"
                spec.append((src, seq, op, rng.choice(keys),
                             rng.randint(0, 10**6)))
        base = make_events(spec)  # 200 unique events
        stamped = chain_events(base)
        lines = list(stamped)
        # ~30 exact duplicate lines (idempotency check)
        lines += [rng.choice(stamped) for _ in range(30)]
        rng.shuffle(lines)

        with tempfile.TemporaryDirectory() as td:
            log = Path(td, "log.jsonl")
            db = Path(td, "main.db")
            ckpt = Path(td, "ckpt.db")
            log.write_text(dumps_log(lines), encoding="utf-8")

            proc = self.run_cli("apply", "--log", str(log),
                                "--db", str(db), "--ckpt", str(ckpt))
            self.assertEqual(proc.returncode, 0, proc.stderr)
            counts = json.loads(proc.stdout)
            self.assertEqual(counts["applied"], 200)
            self.assertEqual(counts["ignored"], 30)
            self.assertEqual(counts["pending"], 0)
            self.assertEqual(counts["failed"], 0)
            self.assertEqual(dump_kv(str(db)), reference_state(base))

            # Re-applying the same log must be a pure no-op.
            proc2 = self.run_cli("apply", "--log", str(log),
                                 "--db", str(db), "--ckpt", str(ckpt))
            self.assertEqual(proc2.returncode, 0, proc2.stderr)
            counts2 = json.loads(proc2.stdout)
            self.assertEqual(counts2["applied"], 0)
            self.assertEqual(counts2["ignored"], len(lines))
            self.assertEqual(dump_kv(str(db)), reference_state(base))


class TestPermutations(unittest.TestCase):
    """A: every permutation of a small log (n <= 7) yields the same state."""

    def test_all_permutations_small_sample(self):
        spec = [
            ("a", 1, "put", "x", 1),
            ("a", 2, "put", "y", 2),
            ("a", 3, "del", "x", None),
            ("b", 1, "put", "x", 10),
            ("b", 2, "put", "z", 20),
            ("b", 3, "del", "y", None),
        ]
        base = make_events(spec)
        stamped = chain_events(base)
        # include one duplicate line in the permuted multiset
        lines = [json.dumps(e, ensure_ascii=False) for e in stamped]
        multiset = lines + [lines[2]]
        expected = reference_state(base)
        self.assertEqual(expected, {"x": 10, "z": 20})

        seen_states = set()
        perms = set(itertools.permutations(multiset))
        self.assertEqual(len(perms), 5040 // 2)  # 7! / 2! (one duplicate)
        for i, perm in enumerate(perms):
            with tempfile.TemporaryDirectory() as td:
                log = Path(td, "log.jsonl")
                log.write_text("".join(p + "\n" for p in perm), encoding="utf-8")
                counts = apply_log(str(log), str(Path(td, "m.db")),
                                   str(Path(td, "c.db")))
                self.assertEqual(counts["failed"], 0)
                self.assertEqual(counts["applied"], 6)
                self.assertEqual(counts["pending"], 0)
                state = dump_kv(str(Path(td, "m.db")))
                self.assertEqual(state, expected,
                                 f"permutation {i} diverged")
                seen_states.add(json.dumps(state, sort_keys=True))
        self.assertEqual(len(seen_states), 1)


class TestFaultInjection(CliMixin, unittest.TestCase):
    """B: crash after DB writes, before ckpt writes; restart stays correct."""

    def test_fault_between_apply_and_ckpt(self):
        rng = random.Random(7)
        spec = [("s1", q, "put", f"key{q % 5}", rng.randint(0, 999))
                for q in range(1, 21)]
        base = make_events(spec)
        stamped = chain_events(base)
        rng.shuffle(stamped)

        with tempfile.TemporaryDirectory() as td:
            log = Path(td, "log.jsonl")
            db = Path(td, "main.db")
            ckpt = Path(td, "ckpt.db")
            log.write_text(dumps_log(stamped), encoding="utf-8")

            # Crash injected between the apply phase and the ckpt phase.
            proc = self.run_cli("apply", "--log", str(log), "--db", str(db),
                                "--ckpt", str(ckpt),
                                env_extra={"CDCSYNC_FAULT_AFTER_APPLY": "1"})
            self.assertEqual(proc.returncode, 1)
            self.assertIn("fault", proc.stderr.lower())

            # The whole transaction must have rolled back.
            if db.exists():
                self.assertEqual(dump_kv(str(db)), {})
            if ckpt.exists():
                conn = sqlite3.connect(str(ckpt))
                try:
                    rows = conn.execute(
                        "SELECT COUNT(*) FROM ckpt_state").fetchone()[0]
                except sqlite3.Error:
                    rows = 0
                finally:
                    conn.close()
                self.assertEqual(rows, 0)

            # Restart: replay must succeed and be exactly correct.
            proc2 = self.run_cli("apply", "--log", str(log), "--db", str(db),
                                 "--ckpt", str(ckpt))
            self.assertEqual(proc2.returncode, 0, proc2.stderr)
            counts = json.loads(proc2.stdout)
            self.assertEqual(counts["applied"], 20)
            self.assertEqual(dump_kv(str(db)), reference_state(base))

            # And a third run proves no effect was applied twice.
            proc3 = self.run_cli("apply", "--log", str(log), "--db", str(db),
                                 "--ckpt", str(ckpt))
            counts3 = json.loads(proc3.stdout)
            self.assertEqual(counts3["applied"], 0)
            self.assertEqual(counts3["ignored"], 20)
            self.assertEqual(dump_kv(str(db)), reference_state(base))


class TestSeqGap(unittest.TestCase):
    """C: a seq gap parks events in pending; backfilling drains them."""

    def test_gap_pending_then_backfill(self):
        with tempfile.TemporaryDirectory() as td:
            db = str(Path(td, "m.db"))
            ckpt = str(Path(td, "c.db"))

            gap_spec = [("s", 1, "put", "a", 1), ("s", 2, "put", "b", 2),
                        ("s", 4, "put", "d", 4), ("s", 5, "put", "e", 5)]
            gap_events = chain_events(make_events(gap_spec))
            log1 = Path(td, "gap.jsonl")
            log1.write_text(dumps_log(gap_events), encoding="utf-8")

            counts = apply_log(str(log1), db, ckpt)
            self.assertEqual(counts["applied"], 2)   # seq 1,2 only
            self.assertEqual(counts["pending"], 2)   # seq 4,5 parked
            self.assertEqual(dump_kv(db), {"a": 1, "b": 2})

            conn = sqlite3.connect(ckpt)
            watermark = conn.execute(
                "SELECT last_seq FROM ckpt_state WHERE src='s'").fetchone()[0]
            conn.close()
            self.assertEqual(watermark, 2)  # never jumps the gap

            # Backfill seq 3 in a later run; pending 4,5 drain behind it.
            fill_events = chain_events(make_events([("s", 3, "put", "c", 3)]))
            log2 = Path(td, "fill.jsonl")
            log2.write_text(dumps_log(fill_events), encoding="utf-8")
            counts2 = apply_log(str(log2), db, ckpt)
            self.assertEqual(counts2["applied"], 3)  # 3 + drained 4,5
            self.assertEqual(counts2["pending"], 0)
            self.assertEqual(dump_kv(db), {"a": 1, "b": 2, "c": 3, "d": 4, "e": 5})

            conn = sqlite3.connect(ckpt)
            watermark = conn.execute(
                "SELECT last_seq FROM ckpt_state WHERE src='s'").fetchone()[0]
            conn.close()
            self.assertEqual(watermark, 5)


class TestBadLog(CliMixin, unittest.TestCase):
    """D: bad JSON / broken hash chain -> exit 3, ckpt does not advance."""

    def _seed_consistent_point(self, td):
        spec = [("s", q, "put", f"k{q}", q) for q in range(1, 6)]
        events = chain_events(make_events(spec))
        log = Path(td, "good.jsonl")
        log.write_text(dumps_log(events), encoding="utf-8")
        db = str(Path(td, "m.db"))
        ckpt = str(Path(td, "c.db"))
        counts = apply_log(str(log), db, ckpt)
        self.assertEqual(counts["applied"], 5)
        return db, ckpt, events

    def _ckpt_watermark(self, ckpt):
        conn = sqlite3.connect(ckpt)
        try:
            return conn.execute(
                "SELECT last_seq FROM ckpt_state WHERE src='s'").fetchone()[0]
        finally:
            conn.close()

    def test_bad_json_line_exit_3(self):
        with tempfile.TemporaryDirectory() as td:
            db, ckpt, events = self._seed_consistent_point(td)
            before_state = dump_kv(db)
            bad = dumps_log(events) + "{not valid json\n"
            log = Path(td, "bad_json.jsonl")
            log.write_text(bad, encoding="utf-8")

            proc = self.run_cli("apply", "--log", str(log),
                                "--db", db, "--ckpt", ckpt)
            self.assertEqual(proc.returncode, 3)
            self.assertIn("error", proc.stderr.lower())
            counts = json.loads(proc.stdout)
            self.assertEqual(counts["failed"], 1)
            self.assertEqual(counts["applied"], 0)
            self.assertEqual(self._ckpt_watermark(ckpt), 5)  # not advanced
            self.assertEqual(dump_kv(db), before_state)

    def test_tampered_value_breaks_hash_chain_exit_3(self):
        with tempfile.TemporaryDirectory() as td:
            db, ckpt, events = self._seed_consistent_point(td)
            before_state = dump_kv(db)
            tampered = [dict(e) for e in events]
            tampered[2]["value"] = 999999  # keep old hash -> chain broken
            log = Path(td, "tampered.jsonl")
            log.write_text(dumps_log(tampered), encoding="utf-8")

            proc = self.run_cli("apply", "--log", str(log),
                                "--db", db, "--ckpt", ckpt)
            self.assertEqual(proc.returncode, 3)
            self.assertIn("hash chain", proc.stderr)
            counts = json.loads(proc.stdout)
            # one tampered link invalidates itself and every downstream link
            self.assertGreaterEqual(counts["failed"], 1)
            self.assertEqual(self._ckpt_watermark(ckpt), 5)
            self.assertEqual(dump_kv(db), before_state)

    def test_tampered_hash_field_exit_3(self):
        with tempfile.TemporaryDirectory() as td:
            db, ckpt, events = self._seed_consistent_point(td)
            before_state = dump_kv(db)
            tampered = [dict(e) for e in events]
            tampered[0]["hash"] = "f" * 64
            log = Path(td, "bad_hash.jsonl")
            log.write_text(dumps_log(tampered), encoding="utf-8")

            proc = self.run_cli("apply", "--log", str(log),
                                "--db", db, "--ckpt", ckpt)
            self.assertEqual(proc.returncode, 3)
            self.assertEqual(self._ckpt_watermark(ckpt), 5)
            self.assertEqual(dump_kv(db), before_state)


if __name__ == "__main__":
    unittest.main()
