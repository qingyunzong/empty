"""Acceptance tests for winsync.

A: random dropped/duplicated/corrupt segments (n <= 500) vs a serial
   reference implementation.
B: fault injected after the DST write and before the ACK write;
   recovery must not duplicate records.
C: window W=1 and W=8 produce identical results.
D: a corrupt first segment yields an empty DST and exit code 7.
"""

from __future__ import annotations

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

from winsync import core  # noqa: E402


def write_segment(src: Path, seq: int, payload: bytes, corrupt: bool = False,
                  copies: int = 1) -> None:
    data = core.format_segment(payload)
    if corrupt:
        # Flip the last payload byte so the CRC no longer matches.
        data = data[:-1] + bytes([data[-1] ^ 0xFF])
    for copy in range(copies):
        if copy == 0:
            name = f"{seq:06d}.seg"
        else:
            name = f"{seq:06d}.dup{copy}.seg"
        (src / name).write_bytes(data)


def reference(src: Path, watermark: int = 0):
    """Serial reference: returns (records, quarantined, high_watermark)."""
    paths: dict[int, Path] = {}
    for entry in sorted(src.iterdir()):
        seq = core.parse_segment_name(entry.name)
        if seq is not None and entry.is_file():
            paths.setdefault(seq, entry)
    payloads: dict[int, bytes | None] = {}
    quarantined = []
    for seq in sorted(paths):
        if seq < watermark:
            continue
        payload = core.load_payload(paths[seq])
        payloads[seq] = payload
        if payload is None:
            quarantined.append(seq)
    records = []
    cursor = watermark
    while cursor in payloads and payloads[cursor] is not None:
        records.append((cursor, payloads[cursor]))
        cursor += 1
    return records, quarantined, cursor


def run_cli(src: Path, dst: Path, ack: Path, win: int, env_extra=None):
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    cmd = [
        sys.executable, "-m", "winsync", "pull",
        str(src), str(dst), "--win", str(win), "--ack", str(ack),
    ]
    return subprocess.run(cmd, capture_output=True, text=True,
                          cwd=REPO_ROOT, env=env)


def read_dst(dst: Path):
    if not dst.exists():
        return []
    return [json.loads(line) for line in dst.read_text("utf-8").splitlines()
            if line.strip()]


def make_scenario(src: Path, rng: random.Random, n: int):
    """Populate src with n logical segments, randomly dropped, duplicated
    or corrupted. Returns the count of segments actually generated."""
    generated = 0
    for seq in range(n):
        roll = rng.random()
        if roll < 0.10:
            continue  # dropped segment
        payload = f"record-{seq}-{rng.randrange(1 << 30)}".encode("utf-8")
        corrupt = roll < 0.22
        copies = rng.choice([1, 1, 1, 2, 3])
        write_segment(src, seq, payload, corrupt=corrupt, copies=copies)
        generated += 1
    return generated


class TestRandomVsReference(unittest.TestCase):
    """A: random drop/dup/corrupt scenarios against the serial reference."""

    def test_random_scenarios(self):
        for trial in range(8):
            rng = random.Random(1000 + trial)
            n = rng.randint(1, 500)
            with tempfile.TemporaryDirectory() as tmp:
                src = Path(tmp) / "src"
                src.mkdir()
                make_scenario(src, rng, n)
                dst = Path(tmp) / "dst.jsonl"
                ack = Path(tmp) / "ack.json"
                win = rng.choice([1, 2, 3, 5, 8])
                proc = run_cli(src, dst, ack, win)
                self.assertIn(proc.returncode, (0, 7), proc.stderr)

                exp_records, exp_quar, exp_wm = reference(src)
                got = read_dst(dst)
                self.assertEqual([r["seq"] for r in got],
                                 [seq for seq, _ in exp_records],
                                 f"trial {trial}")
                self.assertEqual([r["payload"] for r in got],
                                 [p.decode("utf-8") for _, p in exp_records],
                                 f"trial {trial}")
                out = json.loads(proc.stdout)
                self.assertEqual(out["high_watermark"], exp_wm, f"trial {trial}")
                self.assertEqual(out["quarantined"], exp_quar, f"trial {trial}")
                self.assertEqual(proc.returncode, 7 if exp_quar else 0,
                                 f"trial {trial}")
                # ACK file agrees with the reported watermark.
                ack_data = json.loads(ack.read_text("utf-8"))
                self.assertEqual(ack_data["high_watermark"], exp_wm)


class TestCrashRecovery(unittest.TestCase):
    """B: crash after DST write, before ACK write -> no duplicates."""

    def test_crash_between_dst_and_ack(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "src"
            src.mkdir()
            total = 50
            for seq in range(total):
                write_segment(src, seq, f"payload-{seq}".encode("utf-8"))
            dst = Path(tmp) / "dst.jsonl"
            ack = Path(tmp) / "ack.json"

            crash = run_cli(src, dst, ack, 4,
                            env_extra={core.CRASH_ENV: "1"})
            self.assertNotEqual(crash.returncode, 0)
            # DST was written, ACK was not.
            self.assertEqual(len(read_dst(dst)), total)
            self.assertFalse(ack.exists())

            # Recovery run must not duplicate already-written records.
            proc = run_cli(src, dst, ack, 4)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            got = read_dst(dst)
            seqs = [r["seq"] for r in got]
            self.assertEqual(seqs, list(range(total)))
            self.assertEqual(len(seqs), len(set(seqs)), "duplicate seqs in DST")
            self.assertEqual([r["payload"] for r in got],
                             [f"payload-{i}" for i in range(total)])
            out = json.loads(proc.stdout)
            self.assertEqual(out["high_watermark"], total)

            # A third run is a no-op: duplicate ACK state must not
            # regress or re-deliver anything.
            again = run_cli(src, dst, ack, 4)
            self.assertEqual(again.returncode, 0, again.stderr)
            out = json.loads(again.stdout)
            self.assertEqual(out["committed"], 0)
            self.assertEqual(out["high_watermark"], total)
            self.assertEqual(read_dst(dst), got)


class TestWindowEquivalence(unittest.TestCase):
    """C: W=1 and W=8 give identical DST content and stdout summary."""

    def test_window_1_vs_8(self):
        rng = random.Random(42)
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "src"
            src.mkdir()
            make_scenario(src, rng, 300)
            results = []
            for win in (1, 8):
                dst = Path(tmp) / f"dst{win}.jsonl"
                ack = Path(tmp) / f"ack{win}.json"
                proc = run_cli(src, dst, ack, win)
                out = json.loads(proc.stdout)
                out.pop("dst")
                results.append((proc.returncode, out,
                                dst.read_bytes()))
            self.assertEqual(results[0], results[1])


class TestFirstSegmentCorrupt(unittest.TestCase):
    """D: corrupt first segment -> empty DST and exit code 7."""

    def test_first_segment_corrupt(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "src"
            src.mkdir()
            write_segment(src, 0, b"first", corrupt=True)
            write_segment(src, 1, b"second")
            write_segment(src, 2, b"third")
            dst = Path(tmp) / "dst.jsonl"
            ack = Path(tmp) / "ack.json"
            proc = run_cli(src, dst, ack, 4)
            self.assertEqual(proc.returncode, 7, proc.stderr)
            self.assertTrue(dst.exists())
            self.assertEqual(dst.read_text("utf-8"), "")
            out = json.loads(proc.stdout)
            self.assertEqual(out["high_watermark"], 0)
            self.assertEqual(out["quarantined"], [0])
            self.assertIn("quarantined", proc.stderr)


class TestResumeNoDuplicates(unittest.TestCase):
    """Restart from the ACK file: committed records never re-enter DST."""

    def test_resume_after_quarantine_then_fix(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "src"
            src.mkdir()
            for seq in range(10):
                write_segment(src, seq, f"rec-{seq}".encode("utf-8"),
                              corrupt=(seq == 5))
            dst = Path(tmp) / "dst.jsonl"
            ack = Path(tmp) / "ack.json"

            first = run_cli(src, dst, ack, 3)
            self.assertEqual(first.returncode, 7)
            self.assertEqual([r["seq"] for r in read_dst(dst)],
                             list(range(5)))

            # Re-running over the same corrupt segment is a stable no-op.
            second = run_cli(src, dst, ack, 3)
            self.assertEqual(second.returncode, 7)
            self.assertEqual(json.loads(second.stdout)["committed"], 0)
            self.assertEqual([r["seq"] for r in read_dst(dst)],
                             list(range(5)))

            # Operator replaces the corrupt segment with a valid copy.
            (src / "000005.seg").write_bytes(core.format_segment(b"rec-5"))
            third = run_cli(src, dst, ack, 3)
            self.assertEqual(third.returncode, 0, third.stderr)
            got = read_dst(dst)
            self.assertEqual([r["seq"] for r in got], list(range(10)))
            self.assertEqual([r["payload"] for r in got],
                             [f"rec-{i}" for i in range(10)])


if __name__ == "__main__":
    unittest.main()
