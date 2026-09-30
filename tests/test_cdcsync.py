"""Acceptance tests for cdcsync.

A. Random 200-event log with duplicates and out-of-order records matches
   an independent model; exhaustive permutations for small n (n <= 7).
B. FaultInject between the DB write and the ckpt write: after restart the
   result is still correct (exactly-once).
C. A seq gap goes to pending, is not applied, and can be filled later.
D. A corrupt line exits with code 3 and the checkpoint does not advance.
"""
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

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from cdcsync.core import Engine, FaultInject  # noqa: E402
from cdcsync.loggen import write_log  # noqa: E402

OPS_PUT = {"put", "set", "upsert"}
OPS_DEL = {"del", "delete", "remove"}


def model(payloads):
    """Independent oracle: replay unique (src, seq) records in order.

    First occurrence of a duplicated (src, seq) wins, matching the engine.
    """
    seen = set()
    unique = []
    for p in payloads:
        ident = (p["src"], p["seq"])
        if ident in seen:
            continue
        seen.add(ident)
        unique.append(p)
    kv = {}
    for p in sorted(unique, key=lambda p: (p["src"], p["seq"])):
        if p["op"] in OPS_PUT:
            kv[p["key"]] = p["value"]
        elif p["op"] in OPS_DEL:
            kv.pop(p["key"], None)
    return kv


def read_kv(db_path):
    conn = sqlite3.connect(db_path)
    try:
        return {k: json.loads(v) for k, v in conn.execute(
            "SELECT key, value FROM kv WHERE value IS NOT NULL")}
    finally:
        conn.close()


def read_ckpt_table(db_path):
    conn = sqlite3.connect(db_path)
    try:
        return {s: n for s, n in conn.execute("SELECT src, next_seq FROM ckpt")}
    finally:
        conn.close()


def run_cli(log, db, ckpt, env_extra=None):
    env = dict(os.environ)
    env.pop("CDCSYNC_FAULT_AFTER", None)
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        [sys.executable, "-m", "cdcsync", "apply",
         "--log", str(log), "--db", str(db), "--ckpt", str(ckpt)],
        capture_output=True, text=True, cwd=REPO_ROOT, env=env)


class CdcSyncTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.db = self.dir / "state.db"
        self.ckpt = self.dir / "ckpt.json"
        self.log = self.dir / "log.jsonl"

    def apply(self, payloads, log=None):
        log = log or self.log
        write_log(log, payloads)
        eng = Engine(str(self.db), str(self.ckpt))
        try:
            return eng.run(str(log))
        finally:
            eng.close()


class TestRandomLog(CdcSyncTestBase):
    """A: random 200-event log with duplicates and out-of-order records."""

    def test_random_200_events_with_duplicates(self):
        rng = random.Random(20240930)
        payloads = []
        for src in ("alpha", "beta", "gamma"):
            for seq in range(1, 61):  # 180 base events
                op = "del" if rng.random() < 0.2 else "put"
                payloads.append({
                    "src": src, "seq": seq, "op": op,
                    "key": f"k{rng.randint(1, 15)}",
                    "value": rng.randint(0, 1000),
                    "ts": round(rng.random() * 1e6, 3),
                })
        for _ in range(20):  # 20 duplicates, half with conflicting values
            dup = dict(rng.choice(payloads))
            if rng.random() < 0.5:
                dup["value"] = rng.randint(0, 1000)
            payloads.append(dup)
        self.assertEqual(len(payloads), 200)
        rng.shuffle(payloads)

        counts = self.apply(payloads)
        self.assertEqual(read_kv(self.db), model(payloads))
        self.assertEqual(counts["pending"], 0)
        self.assertEqual(counts["failed"], 0)
        self.assertEqual(counts["applied"] + counts["duplicates"], 200)

        # Re-running the same log is a no-op (idempotent).
        counts2 = self.apply(payloads, log=self.dir / "log2.jsonl")
        self.assertEqual(counts2["applied"], 0)
        self.assertEqual(counts2["duplicates"], 200)
        self.assertEqual(read_kv(self.db), model(payloads))

    def test_exhaustive_permutations_small_n(self):
        """A: all permutations of n <= 7 events match the model."""
        base = [
            {"src": "a", "seq": 1, "op": "put", "key": "x", "value": 1, "ts": 1},
            {"src": "a", "seq": 2, "op": "put", "key": "x", "value": 2, "ts": 2},
            {"src": "a", "seq": 3, "op": "del", "key": "x", "value": None, "ts": 3},
            {"src": "b", "seq": 1, "op": "put", "key": "x", "value": 9, "ts": 4},
            {"src": "b", "seq": 2, "op": "put", "key": "y", "value": 5, "ts": 5},
        ]
        checked = 0
        for perm in itertools.permutations(base):
            db = self.dir / "p.db"
            if db.exists():
                db.unlink()
            write_log(self.log, perm)
            eng = Engine(str(db), None)
            try:
                eng.run(str(self.log))
            finally:
                eng.close()
            self.assertEqual(read_kv(db), model(list(perm)))
            checked += 1
        self.assertEqual(checked, 120)  # 5!

        # n = 6 with a conflicting duplicate (6! / 2 unique permutations).
        dup = dict(base[1])
        dup["value"] = 99
        multiset = base + [dup]
        seen = set()
        checked = 0
        for idx_perm in itertools.permutations(range(len(multiset))):
            perm = tuple(multiset[i] for i in idx_perm)
            key = tuple(json.dumps(e, sort_keys=True) for e in perm)
            if key in seen:
                continue
            seen.add(key)
            db = self.dir / "q.db"
            if db.exists():
                db.unlink()
            write_log(self.log, perm)
            eng = Engine(str(db), None)
            try:
                eng.run(str(self.log))
            finally:
                eng.close()
            self.assertEqual(read_kv(db), model(list(perm)))
            checked += 1
        self.assertEqual(checked, 720)  # 6! (conflicting dup is distinct)


class TestFaultInjection(CdcSyncTestBase):
    """B: crash after the DB write, before the ckpt write."""

    def _payloads(self, n=10):
        return [{"src": "s", "seq": i, "op": "put",
                 "key": f"key{i}", "value": i, "ts": float(i)}
                for i in range(1, n + 1)]

    def test_fault_in_process_rolls_back_and_recovers(self):
        write_log(self.log, self._payloads())
        os.environ["CDCSYNC_FAULT_AFTER"] = "6"
        try:
            eng = Engine(str(self.db), str(self.ckpt))
            try:
                with self.assertRaises(FaultInject):
                    eng.run(str(self.log))
            finally:
                eng.close()
        finally:
            del os.environ["CDCSYNC_FAULT_AFTER"]
        # The 6th record's KV write was rolled back with its ckpt write.
        self.assertEqual(read_ckpt_table(self.db), {"s": 6})
        kv = read_kv(self.db)
        self.assertEqual(len(kv), 5)
        self.assertNotIn("key6", kv)

        # Restart without the fault: completes exactly once.
        eng = Engine(str(self.db), str(self.ckpt))
        try:
            counts = eng.run(str(self.log))
        finally:
            eng.close()
        self.assertEqual(counts["applied"], 5)
        self.assertEqual(read_kv(self.db), {f"key{i}": i for i in range(1, 11)})
        self.assertEqual(read_ckpt_table(self.db), {"s": 11})

    def test_fault_via_cli_restart_correct(self):
        write_log(self.log, self._payloads())
        proc = run_cli(self.log, self.db, self.ckpt,
                       env_extra={"CDCSYNC_FAULT_AFTER": "6"})
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("fault injected", proc.stderr)

        proc = run_cli(self.log, self.db, self.ckpt)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        counts = json.loads(proc.stdout)
        self.assertEqual(counts["applied"], 5)
        self.assertEqual(counts["duplicates"], 5)
        self.assertEqual(read_kv(self.db), {f"key{i}": i for i in range(1, 11)})
        mirror = json.loads(self.ckpt.read_text())
        self.assertEqual(mirror["next_seq"], {"s": 11})


class TestSeqGap(CdcSyncTestBase):
    """C: a seq gap pends, is not applied, and can be filled."""

    def test_gap_pending_then_filled(self):
        first = [
            {"src": "a", "seq": 1, "op": "put", "key": "x", "value": 1, "ts": 1},
            {"src": "a", "seq": 2, "op": "put", "key": "y", "value": 2, "ts": 2},
            {"src": "a", "seq": 4, "op": "put", "key": "z", "value": 4, "ts": 4},
        ]
        counts = self.apply(first)
        self.assertEqual(counts["applied"], 2)
        self.assertEqual(counts["pending"], 1)
        kv = read_kv(self.db)
        self.assertEqual(kv, {"x": 1, "y": 2})  # seq 4 not applied (no越过)
        self.assertEqual(read_ckpt_table(self.db), {"a": 3})

        # Fill the gap with a second log; seq 4 cascades out of pending.
        filler = [{"src": "a", "seq": 3, "op": "put",
                   "key": "w", "value": 3, "ts": 3}]
        counts = self.apply(filler, log=self.dir / "filler.jsonl")
        self.assertEqual(counts["applied"], 2)
        self.assertEqual(counts["pending"], 0)
        self.assertEqual(read_kv(self.db),
                         {"x": 1, "y": 2, "w": 3, "z": 4})
        self.assertEqual(read_ckpt_table(self.db), {"a": 5})


class TestCorruptLog(CdcSyncTestBase):
    """D: corrupt line -> exit code 3, checkpoint does not advance."""

    def _good(self):
        return [{"src": "a", "seq": i, "op": "put",
                 "key": f"k{i}", "value": i, "ts": float(i)}
                for i in range(1, 6)]

    def test_broken_hash_chain_exit_3(self):
        records = write_log(self.log, self._good())
        lines = self.log.read_text().splitlines()
        bad = json.loads(lines[3])
        bad["value"] = 999  # tamper without rehashing
        lines[3] = json.dumps(bad)
        self.log.write_text("\n".join(lines) + "\n")

        proc = run_cli(self.log, self.db, self.ckpt)
        self.assertEqual(proc.returncode, 3)
        self.assertIn("hash chain broken", proc.stderr)
        counts = json.loads(proc.stdout)
        self.assertEqual(counts["applied"], 3)
        # DB stays at the last consistent point; ckpt did not advance.
        self.assertEqual(read_kv(self.db), {"k1": 1, "k2": 2, "k3": 3})
        self.assertEqual(read_ckpt_table(self.db), {"a": 4})
        mirror = json.loads(self.ckpt.read_text())
        self.assertEqual(mirror["next_seq"], {"a": 4})

    def test_invalid_json_exit_3(self):
        write_log(self.log, self._good()[:2])
        with open(self.log, "a", encoding="utf-8") as fh:
            fh.write("{not valid json\n")
        proc = run_cli(self.log, self.db, self.ckpt)
        self.assertEqual(proc.returncode, 3)
        self.assertIn("invalid JSON", proc.stderr)
        self.assertEqual(read_kv(self.db), {"k1": 1, "k2": 2})
        self.assertEqual(read_ckpt_table(self.db), {"a": 3})


class TestCliAndCounts(CdcSyncTestBase):
    def test_counts_json_shape_and_unknown_op(self):
        payloads = [
            {"src": "a", "seq": 1, "op": "put", "key": "x", "value": 1, "ts": 1},
            {"src": "a", "seq": 2, "op": "noop", "key": "x", "value": 2, "ts": 2},
            {"src": "a", "seq": 3, "op": "put", "key": "y", "value": 3, "ts": 3},
            {"src": "a", "seq": 3, "op": "put", "key": "y", "value": 3, "ts": 3},
        ]
        write_log(self.log, payloads)
        proc = run_cli(self.log, self.db, self.ckpt)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        counts = json.loads(proc.stdout)
        for key in ("applied", "pending", "failed"):
            self.assertIn(key, counts)
        self.assertEqual(counts["applied"], 2)
        self.assertEqual(counts["failed"], 1)   # unknown op consumed, failed
        self.assertEqual(counts["duplicates"], 1)
        self.assertEqual(counts["pending"], 0)
        # The unknown op did not block the contiguous stream.
        self.assertEqual(read_kv(self.db), {"x": 1, "y": 3})
        self.assertEqual(read_ckpt_table(self.db), {"a": 4})


if __name__ == "__main__":
    unittest.main()
