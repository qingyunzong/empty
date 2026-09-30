import json
import os
import random
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

import snapsync
from snapsync import (
    GENESIS_HASH,
    LogEntry,
    Snapshot,
    entry_crc,
    replay_hash,
    write_log,
    write_snapshot,
)


def make_entries(spec):
    """spec: list of (term, seq, op) -> list[LogEntry] with valid crcs."""
    return [
        LogEntry(term=t, seq=s, op=o, crc=entry_crc(t, s, o)) for t, s, o in spec
    ]


def random_entries(rng, n):
    """Random valid entries: seq 1..n, non-decreasing terms, varied ops."""
    spec = []
    term = rng.randint(1, 3)
    for seq in range(1, n + 1):
        if rng.random() < 0.2:
            term += rng.randint(1, 2)
        op = rng.choice(
            [
                f"set key{rng.randint(0, 9)}={rng.randint(0, 999)}",
                f"del key{rng.randint(0, 9)}",
                f"incr counter by {rng.randint(1, 50)}",
                "noop",
                "set 中文键=值",
            ]
        )
        spec.append((term, seq, op))
    return make_entries(spec)


class CliMixin:
    def run_cli(self, *argv):
        return subprocess.run(
            [sys.executable, "-m", "snapsync", *argv],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )

    def run_compact(self, log, snap, keep):
        return self.run_cli("compact", str(log), str(snap), "--keep", str(keep))

    def run_restore(self, log, snap):
        return self.run_cli("restore", str(log), str(snap))


class TestRandomCompactAgainstFullReplay(unittest.TestCase, CliMixin):
    """Acceptance A: random logs (n <= 300), compact vs full replay reference."""

    def test_random_logs_match_full_replay(self):
        rng = random.Random(20260930)
        sizes = [0, 1, 2, 7, 42] + [rng.randint(0, 300) for _ in range(10)]
        for n in sizes:
            with self.subTest(n=n), tempfile.TemporaryDirectory() as tmp:
                log = Path(tmp) / "ops.log"
                snap = Path(tmp) / "state.snap"
                entries = random_entries(rng, n)
                write_log(log, entries)
                reference = replay_hash(e.op for e in entries)

                proc = self.run_compact(log, snap, keep=3)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                out = json.loads(proc.stdout)
                self.assertEqual(out["restored_hash"], reference)
                self.assertEqual(out["truncated"], n)
                self.assertEqual(out["kept"], 1)

                # Log fully truncated; restore from snapshot == full replay.
                self.assertEqual(log.read_text(), "")
                proc = self.run_restore(log, snap)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertEqual(json.loads(proc.stdout)["restored_hash"], reference)

                # Library-level agreement.
                self.assertEqual(snapsync.restore(log, snap), reference)


class TestKeepZeroBehavesAsOne(unittest.TestCase, CliMixin):
    """Acceptance B: --keep 0 is treated as --keep 1 and does not error."""

    def test_keep_zero(self):
        rng = random.Random(7)
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / "ops.log"
            snap = Path(tmp) / "state.snap"
            write_log(log, random_entries(rng, 5))

            proc = self.run_compact(log, snap, keep=0)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            out = json.loads(proc.stdout)
            self.assertEqual(out["kept"], 1)
            self.assertTrue(snap.exists())
            self.assertFalse(Path(f"{snap}.1").exists())

            # Compact again with more entries: still exactly one generation.
            term = snapsync.read_snapshot(snap).last_term
            more = make_entries([(term, 6, "set a=1"), (term, 7, "set b=2")])
            write_log(log, more)
            proc = self.run_compact(log, snap, keep=0)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(json.loads(proc.stdout)["kept"], 1)
            self.assertEqual(
                [p for p in Path(tmp).iterdir() if p.name.startswith("state.snap")],
                [snap],
            )

    def test_keep_k_retains_exactly_k_generations(self):
        rng = random.Random(11)
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / "ops.log"
            snap = Path(tmp) / "state.snap"
            seq = 0
            term = 1
            previous_snapshot_text = None
            for round_no in range(1, 5):
                batch = []
                for _ in range(3):
                    seq += 1
                    batch.append((term, seq, f"op{seq}"))
                term += 1
                write_log(log, make_entries(batch))
                proc = self.run_compact(log, snap, keep=2)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                out = json.loads(proc.stdout)
                self.assertEqual(out["kept"], min(round_no, 2))
                if round_no >= 2:
                    # Rotation: SNAP.1 must be the previous generation.
                    self.assertEqual(
                        Path(f"{snap}.1").read_text(), previous_snapshot_text
                    )
                self.assertFalse(Path(f"{snap}.2").exists())
                previous_snapshot_text = snap.read_text()


class TestTermBoundaryTruncation(unittest.TestCase, CliMixin):
    """Acceptance C: truncation point on a term-switch boundary, no mis-cut."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.log = Path(self.tmp.name) / "ops.log"
        self.snap = Path(self.tmp.name) / "state.snap"
        self.ops = ["op1", "op2", "op3", "op4"]
        # Terms switch exactly between seq 2 and seq 3.
        self.entries = make_entries(
            [(1, 1, "op1"), (1, 2, "op2"), (2, 3, "op3"), (2, 4, "op4")]
        )
        write_log(self.log, self.entries)

    def test_snapshot_at_term_boundary_compacts_cleanly(self):
        boundary_hash = replay_hash(self.ops[:2])
        write_snapshot(self.snap, Snapshot(1, 2, boundary_hash))
        proc = self.run_compact(self.log, self.snap, keep=3)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["truncated"], 4)
        self.assertEqual(out["restored_hash"], replay_hash(self.ops))
        snap = snapsync.read_snapshot(self.snap)
        self.assertEqual((snap.last_term, snap.last_seq), (2, 4))

    def test_wrong_term_at_boundary_seq_is_rejected(self):
        # seq 2 exists but belongs to term 1, not term 2: must not truncate.
        write_snapshot(self.snap, Snapshot(2, 2, replay_hash(self.ops[:2])))
        before = self.log.read_bytes()
        proc = self.run_compact(self.log, self.snap, keep=3)
        self.assertEqual(proc.returncode, 8)
        self.assertIn("error", proc.stderr)
        self.assertEqual(self.log.read_bytes(), before)
        self.assertFalse(Path(f"{self.snap}.1").exists())

    def test_stale_term_at_boundary_seq_is_rejected(self):
        # seq 3 exists but belongs to term 2, not term 1.
        write_snapshot(self.snap, Snapshot(1, 3, replay_hash(self.ops[:3])))
        before = self.log.read_bytes()
        proc = self.run_compact(self.log, self.snap, keep=3)
        self.assertEqual(proc.returncode, 8)
        self.assertEqual(self.log.read_bytes(), before)

    def test_second_compaction_across_term_switch(self):
        proc = self.run_compact(self.log, self.snap, keep=3)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        more = make_entries([(2, 5, "op5"), (3, 6, "op6")])
        write_log(self.log, more)
        proc = self.run_compact(self.log, self.snap, keep=3)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["restored_hash"], replay_hash(self.ops + ["op5", "op6"]))
        snap = snapsync.read_snapshot(self.snap)
        self.assertEqual((snap.last_term, snap.last_seq), (3, 6))


class TestCorruptSnapshotExitCode8(unittest.TestCase, CliMixin):
    """Acceptance D: tampered state_hash -> exit 8, log untouched."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.log = Path(self.tmp.name) / "ops.log"
        self.snap = Path(self.tmp.name) / "state.snap"
        self.ops = ["alpha", "beta", "gamma"]
        self.entries = make_entries([(1, 1, "alpha"), (1, 2, "beta"), (2, 3, "gamma")])
        write_log(self.log, self.entries)

    def _assert_untouched(self, log_before, snap_before):
        self.assertEqual(self.log.read_bytes(), log_before)
        self.assertEqual(self.snap.read_bytes(), snap_before)
        self.assertFalse(Path(f"{self.snap}.1").exists())

    def test_tampered_state_hash(self):
        good = replay_hash(self.ops[:2])
        tampered = ("0" if good[0] != "0" else "1") + good[1:]
        write_snapshot(self.snap, Snapshot(1, 2, tampered))
        log_before, snap_before = self.log.read_bytes(), self.snap.read_bytes()
        proc = self.run_compact(self.log, self.snap, keep=3)
        self.assertEqual(proc.returncode, 8)
        self.assertTrue(proc.stderr.strip())
        self.assertEqual(proc.stdout, "")
        self._assert_untouched(log_before, snap_before)

    def test_malformed_snapshot_json(self):
        self.snap.write_text("{not json")
        log_before, snap_before = self.log.read_bytes(), self.snap.read_bytes()
        proc = self.run_compact(self.log, self.snap, keep=3)
        self.assertEqual(proc.returncode, 8)
        self._assert_untouched(log_before, snap_before)

    def test_no_silent_fallback_to_older_generation(self):
        # A valid older generation exists; corrupting SNAP must not make
        # the tool fall back to SNAP.1.
        proc = self.run_compact(self.log, self.snap, keep=3)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        old_gen = Path(f"{self.snap}.1")
        self.assertFalse(old_gen.exists())
        # Simulate a previous generation and append new log entries.
        write_snapshot(old_gen, Snapshot(1, 2, replay_hash(self.ops[:2])))
        write_log(self.log, make_entries([(2, 4, "delta")]))
        self.snap.write_text('{"last_term": 2, "last_seq": 3, "state_hash": "zz"}')
        log_before = self.log.read_bytes()
        proc = self.run_compact(self.log, self.snap, keep=3)
        self.assertEqual(proc.returncode, 8)
        self.assertEqual(self.log.read_bytes(), log_before)
        self.assertTrue(old_gen.exists())  # older generation left in place

    def test_missing_snapshot_with_truncated_log_is_rejected(self):
        # Log starting at seq 4 without a snapshot: falling back to genesis
        # would silently produce a wrong (older-generation) state.
        write_log(self.log, make_entries([(2, 4, "delta")]))
        proc = self.run_compact(self.log, self.snap, keep=3)
        self.assertEqual(proc.returncode, 8)
        self.assertFalse(self.snap.exists())


class TestRestoreConsistency(unittest.TestCase, CliMixin):
    """Acceptance: restore == replay from valid snapshot + suffix == full replay."""

    def test_restore_after_compaction_equals_full_replay(self):
        rng = random.Random(99)
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / "ops.log"
            snap = Path(tmp) / "state.snap"
            first = random_entries(rng, 120)
            write_log(log, first)
            proc = self.run_compact(log, snap, keep=3)
            self.assertEqual(proc.returncode, 0, proc.stderr)

            # Append a suffix with non-decreasing terms.
            last_term = first[-1].term
            term = last_term
            fixed = []
            for i in range(40):
                if i % 3 == 0:
                    term += 1
                fixed.append((term, 121 + i, f"suffix-{i}"))
            suffix = make_entries(fixed)
            write_log(log, suffix)

            reference = replay_hash([e.op for e in first] + [e.op for e in suffix])
            proc = self.run_restore(log, snap)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(json.loads(proc.stdout)["restored_hash"], reference)

            # Compacting the suffix keeps the same restored hash.
            proc = self.run_compact(log, snap, keep=3)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(json.loads(proc.stdout)["restored_hash"], reference)

    def test_restore_from_mid_log_snapshot_prefix(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / "ops.log"
            snap = Path(tmp) / "state.snap"
            ops = [f"op{i}" for i in range(1, 11)]
            entries = make_entries([(1, i, op) for i, op in enumerate(ops, start=1)])
            write_log(log, entries)
            write_snapshot(snap, Snapshot(1, 4, replay_hash(ops[:4])))
            proc = self.run_restore(log, snap)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(
                json.loads(proc.stdout)["restored_hash"], replay_hash(ops)
            )


class TestLogCorruption(unittest.TestCase, CliMixin):
    """crc failures forbid truncation; log and snapshot stay untouched."""

    def test_tampered_log_crc_refuses_truncation(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / "ops.log"
            snap = Path(tmp) / "state.snap"
            entries = make_entries([(1, 1, "a"), (1, 2, "b")])
            write_log(log, entries)
            lines = log.read_text().splitlines()
            bad = json.loads(lines[1])
            bad["op"] = "tampered"
            lines[1] = json.dumps(bad)
            log.write_text("\n".join(lines) + "\n")
            before = log.read_bytes()
            proc = self.run_compact(log, snap, keep=3)
            self.assertNotEqual(proc.returncode, 0)
            self.assertNotEqual(proc.returncode, 8)  # log error, not snapshot
            self.assertTrue(proc.stderr.strip())
            self.assertEqual(log.read_bytes(), before)
            self.assertFalse(snap.exists())

    def test_genesis_snapshot_hash_is_checked(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / "ops.log"
            snap = Path(tmp) / "state.snap"
            write_log(log, make_entries([(1, 1, "a")]))
            write_snapshot(snap, Snapshot(0, 0, "ab" * 32))
            proc = self.run_compact(log, snap, keep=3)
            self.assertEqual(proc.returncode, 8)

    def test_genesis_constant(self):
        self.assertEqual(replay_hash([]), GENESIS_HASH)


if __name__ == "__main__":
    unittest.main()
