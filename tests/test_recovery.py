import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from recovery.engine import Engine
from recovery.reference import reference_state
from recovery.storage import PageFile, page_of


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="recovery-test-")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def wal_records(self, dbdir=None):
        path = os.path.join(dbdir or self.dir, "wal.log")
        with open(path, "r", encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]

    def file_bytes(self, name, dbdir=None):
        with open(os.path.join(dbdir or self.dir, name), "rb") as f:
            return f.read()


class CheckpointPlacementTest(Base):
    """(a) Crash before vs. after a checkpoint must recover to the same state."""

    OPS = [
        ("put", "t1", "alpha", "1"),
        ("put", "t1", "beta", "2"),
        ("commit", "t1"),
        ("put", "t2", "gamma", "3"),
        ("commit", "t2"),
        ("put", "t3", "delta", "4"),
        ("put", "t3", "alpha", "10"),
    ]

    def _run(self, checkpoint_after):
        engine = Engine(self.dir)
        for i, op in enumerate(self.OPS):
            if i == checkpoint_after:
                engine.checkpoint()
            if op[0] == "put":
                engine.put(op[1], op[2], op[3])
            else:
                engine.commit(op[1])
        if checkpoint_after == len(self.OPS):
            engine.checkpoint()
        engine.crash()
        engine.recover()
        state = engine.dump()
        engine.close()
        return state

    def test_crash_before_and_after_checkpoint_same_result(self):
        states = {}
        for label, cp in [("no_checkpoint", None),
                          ("mid_checkpoint", 3),
                          ("final_checkpoint", len(self.OPS))]:
            shutil.rmtree(self.dir, ignore_errors=True)
            os.makedirs(self.dir)
            states[label] = self._run(cp)
        self.assertEqual(states["no_checkpoint"], states["mid_checkpoint"])
        self.assertEqual(states["mid_checkpoint"], states["final_checkpoint"])
        # Uncommitted t3 must be gone; committed writes visible.
        self.assertEqual(states["no_checkpoint"],
                         {"alpha": "1", "beta": "2", "gamma": "3"})
        self.assertEqual(states["no_checkpoint"], reference_state(self.dir))


class MixedTransactionsTest(Base):
    """(b) After recovery only committed transactions are visible."""

    def test_only_committed_visible(self):
        engine = Engine(self.dir)
        engine.put("t1", "k1", "committed")
        engine.commit("t1")
        engine.put("t2", "k2", "uncommitted")
        engine.put("t2", "k1", "overwritten")
        # Checkpoint flushes t2's dirty (uncommitted) pages to disk.
        engine.checkpoint()

        # Prove uncommitted data really reached the disk before the crash.
        disk_state = {}
        pages = PageFile(os.path.join(self.dir, "data.db"))
        from recovery.storage import PAGE_COUNT
        for pid in range(PAGE_COUNT):
            _, data = pages.read_page(pid)
            disk_state.update(data)
        self.assertEqual(disk_state.get("k2"), "uncommitted")
        self.assertEqual(disk_state.get("k1"), "overwritten")

        engine.crash()
        stats = engine.recover()
        self.assertEqual(stats["losers"], ["t2"])
        self.assertEqual(engine.dump(), {"k1": "committed"})
        engine.close()
        self.assertEqual(engine.dump(), reference_state(self.dir))

    def test_undo_writes_compensation_records(self):
        engine = Engine(self.dir)
        engine.put("t1", "x", "1")
        engine.commit("t1")
        engine.put("t2", "y", "2")
        engine.put("t2", "x", "3")
        engine.crash()
        engine.recover()
        engine.close()

        records = self.wal_records()
        clrs = [r for r in records if r["type"] == "CLR"]
        self.assertEqual(len(clrs), 2)
        for clr in clrs:
            self.assertEqual(clr["txn"], "t2")
            self.assertIn("undo_next", clr)
        # CLRs appear in reverse order of the original updates.
        self.assertEqual([c["key"] for c in clrs], ["x", "y"])
        ends = [r for r in records if r["type"] == "END" and r["txn"] == "t2"]
        self.assertEqual(len(ends), 1)
        # Undo of the insert removes the key; undo of the overwrite restores.
        engine2 = Engine(self.dir)
        self.assertEqual(engine2.dump(), {"x": "1"})
        engine2.close()


class IdempotentRecoveryTest(Base):
    """(c) Running recover twice on the same crashed state changes nothing."""

    def test_double_recover_is_noop(self):
        engine = Engine(self.dir)
        engine.put("t1", "a", "1")
        engine.commit("t1")
        engine.put("t2", "b", "2")
        engine.checkpoint()
        engine.put("t3", "c", "3")
        engine.put("t1", "a", "10")
        engine.crash()

        stats1 = engine.recover()
        dump1 = engine.dump()
        data1 = self.file_bytes("data.db")
        wal1 = self.file_bytes("wal.log")
        engine.close()

        engine2 = Engine(self.dir)
        stats2 = engine2.recover()
        dump2 = engine2.dump()
        engine2.close()

        self.assertEqual(dump1, dump2)
        self.assertEqual(self.file_bytes("data.db"), data1)
        self.assertEqual(self.file_bytes("wal.log"), wal1)
        self.assertEqual(stats2["redone"], 0)
        self.assertEqual(stats2["clrs"], 0)
        self.assertEqual(stats2["losers"], [])
        self.assertGreater(stats1["clrs"], 0)

    def test_page_lsn_blocks_reapplication(self):
        engine = Engine(self.dir)
        engine.put("t1", "k", "v1")
        engine.commit("t1")
        engine.crash()
        engine.recover()
        page_lsn_after_first, _ = engine.pages.read_page(page_of("k"))
        engine.recover()
        page_lsn_after_second, data = engine.pages.read_page(page_of("k"))
        engine.close()
        self.assertEqual(page_lsn_after_first, page_lsn_after_second)
        self.assertGreater(page_lsn_after_first, 0)
        self.assertEqual(data, {"k": "v1"})


class ReferenceComparisonTest(Base):
    """(d) Recovered state must match full-replay reference implementation."""

    def _random_workload(self, seed, rounds):
        rng = random.Random(seed)
        engine = Engine(self.dir)
        active = []
        used = set()
        counter = [0]
        for _ in range(rounds):
            roll = rng.random()
            if roll < 0.55 or not active:
                fresh = [t for t in ("t0", "t1", "t2", "t3")
                         if t not in active and t not in used]
                if not fresh:
                    continue
                txn = rng.choice(fresh)
                key = "key%02d" % rng.randrange(30)
                engine.put(txn, key, "v%d" % counter[0])
                counter[0] += 1
                active.append(txn)
            elif roll < 0.75:
                txn = rng.choice(active)
                engine.commit(txn)
                active.remove(txn)
                used.add(txn)
            elif roll < 0.85:
                engine.checkpoint()
            else:
                # Crash and recover mid-workload, then keep going.
                # Recovery ends all in-flight transactions.
                engine.crash()
                engine.recover()
                used.update(active)
                active = []
        engine.crash()
        engine.recover()
        state = engine.dump()
        engine.close()
        return state

    def test_matches_full_replay_reference(self):
        for seed in (1, 7, 42, 20260927):
            shutil.rmtree(self.dir, ignore_errors=True)
            os.makedirs(self.dir)
            state = self._random_workload(seed, rounds=200)
            self.assertEqual(state, reference_state(self.dir),
                             "mismatch for seed %d" % seed)


class CheckpointRecordTest(Base):
    """(1) Checkpoint records carry the dirty page table and txn table."""

    def test_checkpoint_contains_dpt_and_tt(self):
        engine = Engine(self.dir)
        engine.put("t1", "a", "1")
        engine.put("t2", "b", "2")
        engine.commit("t2")
        engine.checkpoint()
        engine.close()

        checkpoints = [r for r in self.wal_records() if r["type"] == "CHECKPOINT"]
        self.assertEqual(len(checkpoints), 1)
        chk = checkpoints[0]
        # t1 is still active and appears in the transaction table snapshot.
        self.assertEqual(chk["tt"]["t1"]["status"], "running")
        self.assertNotIn("t2", chk["tt"])
        # The dirty page table names the page holding key "a".
        self.assertIn(str(page_of("a")), chk["dpt"])
        self.assertGreater(chk["dpt"][str(page_of("a"))], 0)


class CliTest(Base):
    def _run_cli(self, dbdir, *commands):
        env = dict(os.environ, PYTHONPATH=REPO_ROOT)
        return subprocess.run(
            [sys.executable, "-m", "recovery", "--dir", dbdir, *commands],
            capture_output=True, text=True, env=env, cwd=REPO_ROOT, check=True)

    def test_cli_end_to_end(self):
        result = self._run_cli(
            self.dir,
            "put t1 a 1", "put t1 b 2", "commit t1",
            "checkpoint",
            "put t2 c 3", "put t2 a 99",
            "crash", "recover", "dump")
        lines = result.stdout.strip().splitlines()
        self.assertIn("recovered:", lines[0])
        self.assertEqual(lines[1:], ["a=1", "b=2"])

    def test_cli_recover_in_separate_process(self):
        self._run_cli(self.dir, "put t1 a 1", "commit t1", "put t2 b 2")
        # New process: in-memory state is gone, only files remain.
        result = self._run_cli(self.dir, "recover", "dump")
        self.assertEqual(result.stdout.strip().splitlines()[1:], ["a=1"])
        # Idempotent across processes too (compare the dumped state).
        result2 = self._run_cli(self.dir, "recover", "dump")
        dump1 = result.stdout.strip().splitlines()[1:]
        dump2 = result2.stdout.strip().splitlines()[1:]
        self.assertEqual(dump1, dump2)


if __name__ == "__main__":
    unittest.main()
