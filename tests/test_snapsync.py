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

from snapsync import core  # noqa: E402


def random_log(rng: random.Random, n: int):
    entries = []
    term = 1
    for seq in range(1, n + 1):
        if rng.random() < 0.2:
            term += 1
        op = f"{rng.choice(['set', 'add', 'del', 'mov'])} {rng.randint(0, 10**6)}"
        entries.append(core.make_entry(term, seq, op))
    return entries


def write_json(path, obj):
    Path(path).write_text(json.dumps(obj, sort_keys=True) + "\n", encoding="utf-8")


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "snapsync", *args],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )


class SnapSyncTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.log = self.dir / "ops.log"
        self.snap = self.dir / "snap.json"

    def setup_pair(self, entries, cut):
        core.write_log(self.log, entries)
        write_json(self.snap, core.snapshot_for_prefix(entries, cut))
        return core.snapshot_for_prefix(entries, cut)


class TestRandomCompaction(SnapSyncTestBase):
    """A: random logs (n <= 300), compacted result matches full replay."""

    def test_random_logs_against_full_replay(self):
        for seed in range(12):
            rng = random.Random(seed)
            n = rng.randint(0, 300)
            entries = random_log(rng, n)
            cut = rng.randint(0, n)
            self.setup_pair(entries, cut)

            proc = run_cli("compact", str(self.log), str(self.snap), "--keep", "3")
            self.assertEqual(proc.returncode, 0, f"seed={seed} stderr={proc.stderr}")
            out = json.loads(proc.stdout)

            full_hash = core.replay(entries)
            self.assertEqual(out["truncated"], cut)
            self.assertEqual(out["kept"], n - cut)
            self.assertEqual(out["restored_hash"], full_hash)

            remaining = core.read_log(self.log)
            self.assertEqual(remaining, entries[cut:])
            # restore from snapshot over the truncated log == full replay
            snap = core.read_snapshot(self.snap)
            self.assertEqual(core.restore(snap, remaining), full_hash)


class TestKeepZero(SnapSyncTestBase):
    """B: --keep 0 is treated as --keep 1 and does not error."""

    def test_keep_zero_behaves_like_one(self):
        rng = random.Random(99)
        entries = random_log(rng, 40)
        self.setup_pair(entries, 10)
        for seq in (3, 5, 7):
            write_json(self.dir / f"snap.json.{seq}", core.snapshot_for_prefix(entries, seq))

        proc = run_cli("compact", str(self.log), str(self.snap), "--keep", "0")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["restored_hash"], core.replay(entries))
        # current snapshot survives; all older generations are gone
        self.assertTrue(self.snap.exists())
        self.assertEqual(core.list_generations(self.snap), [])
        self.assertEqual(out["snapshots_kept"], [])


class TestTermBoundary(SnapSyncTestBase):
    """C: truncation point on a term-switch boundary must cut exactly."""

    def make_boundary_log(self):
        terms = [1, 1, 1, 2, 2, 3]
        return [core.make_entry(t, i + 1, f"op{i}") for i, t in enumerate(terms)]

    def test_cut_at_last_entry_of_old_term(self):
        entries = self.make_boundary_log()
        self.setup_pair(entries, 3)  # last entry of term 1
        proc = run_cli("compact", str(self.log), str(self.snap), "--keep", "2")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        remaining = core.read_log(self.log)
        self.assertEqual([e["seq"] for e in remaining], [4, 5, 6])
        self.assertEqual([e["term"] for e in remaining], [2, 2, 3])

    def test_cut_at_first_entry_of_new_term(self):
        entries = self.make_boundary_log()
        self.setup_pair(entries, 4)  # first entry of term 2
        proc = run_cli("compact", str(self.log), str(self.snap), "--keep", "2")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        remaining = core.read_log(self.log)
        self.assertEqual([e["seq"] for e in remaining], [5, 6])
        self.assertEqual([e["term"] for e in remaining], [2, 3])

    def test_term_mismatch_at_boundary_rejected(self):
        entries = self.make_boundary_log()
        core.write_log(self.log, entries)
        before = self.log.read_bytes()
        # claim seq 3 belongs to term 2 (it is term 1 in the log)
        bad = {"last_term": 2, "last_seq": 3,
               "state_hash": core.replay(entries[:3])}
        write_json(self.snap, bad)
        proc = run_cli("compact", str(self.log), str(self.snap), "--keep", "2")
        self.assertEqual(proc.returncode, 8, proc.stderr)
        self.assertTrue(proc.stderr.strip())
        self.assertEqual(self.log.read_bytes(), before)


class TestCorruptSnapshot(SnapSyncTestBase):
    """D: tampered state_hash -> exit 8, log untouched, generations untouched."""

    def test_tampered_state_hash(self):
        rng = random.Random(7)
        entries = random_log(rng, 50)
        snap = self.setup_pair(entries, 20)
        write_json(self.dir / "snap.json.5", core.snapshot_for_prefix(entries, 5))
        before_log = self.log.read_bytes()

        tampered = dict(snap)
        h = tampered["state_hash"]
        tampered["state_hash"] = ("0" if h[0] != "0" else "1") + h[1:]
        write_json(self.snap, tampered)

        proc = run_cli("compact", str(self.log), str(self.snap), "--keep", "1")
        self.assertEqual(proc.returncode, 8, proc.stderr)
        self.assertTrue(proc.stderr.strip())
        self.assertEqual(self.log.read_bytes(), before_log)
        self.assertEqual(len(core.list_generations(self.snap)), 1)

    def test_malformed_snapshot_json(self):
        entries = random_log(random.Random(8), 10)
        self.setup_pair(entries, 4)
        before_log = self.log.read_bytes()
        self.snap.write_text("{not json", encoding="utf-8")
        proc = run_cli("compact", str(self.log), str(self.snap), "--keep", "1")
        self.assertEqual(proc.returncode, 8)
        self.assertEqual(self.log.read_bytes(), before_log)

    def test_missing_snapshot(self):
        entries = random_log(random.Random(9), 10)
        core.write_log(self.log, entries)
        before_log = self.log.read_bytes()
        proc = run_cli("compact", str(self.log), str(self.snap), "--keep", "1")
        self.assertEqual(proc.returncode, 8)
        self.assertEqual(self.log.read_bytes(), before_log)


class TestRetention(SnapSyncTestBase):
    def test_keep_prunes_older_generations_but_never_current(self):
        entries = random_log(random.Random(11), 60)
        core.write_log(self.log, entries)
        # build a chain of snapshots; write_snapshot archives the previous one
        for cut in (10, 20, 30, 40):
            core.write_snapshot(self.snap, core.snapshot_for_prefix(entries, cut))
        self.assertEqual(len(core.list_generations(self.snap)), 3)

        proc = run_cli("compact", str(self.log), str(self.snap), "--keep", "2")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertTrue(self.snap.exists())
        gens = core.list_generations(self.snap)
        self.assertEqual(len(gens), 1)  # keep=2 -> current + 1 archive
        self.assertEqual(gens[0][0], 30)  # newest archive survives
        self.assertEqual(out["snapshots_kept"], [os.path.basename(gens[0][1])])


class TestLogIntegrity(SnapSyncTestBase):
    def test_corrupt_log_rejected_and_untouched(self):
        entries = random_log(random.Random(13), 20)
        self.setup_pair(entries, 5)
        entries[10]["op"] = "tampered"  # crc no longer matches
        core.write_log(self.log, entries)
        before = self.log.read_bytes()
        proc = run_cli("compact", str(self.log), str(self.snap), "--keep", "1")
        self.assertEqual(proc.returncode, 3)
        self.assertTrue(proc.stderr.strip())
        self.assertEqual(self.log.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
