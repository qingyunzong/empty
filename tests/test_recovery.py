import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

from recovery import Engine, MAX_KEY
from recovery.engine import LockConflict


def reference_state(wal_path):
    """Full-replay reference: apply after-images of committed txns only,
    scanning the whole WAL from LSN 0 onto an empty database.

    Transaction ids may be reused, so each begin starts a new
    incarnation and only updates of committed incarnations apply.
    """
    committed = set()
    current = {}
    sequence = {}
    updates = []
    with open(wal_path, "r", encoding="utf-8") as fh:
        for line in fh:
            rec = json.loads(line)
            if rec["type"] == "begin":
                txn = rec["txn"]
                sequence[txn] = sequence.get(txn, 0) + 1
                current[txn] = (txn, sequence[txn])
            elif rec["type"] == "update":
                updates.append((current[rec["txn"]], rec["key"], rec["after"]))
            elif rec["type"] == "commit":
                committed.add(current[rec["txn"]])
    state = {key: 0 for key in range(MAX_KEY)}
    for incarnation, key, after in updates:
        if incarnation in committed:
            state[key] = after
    return state


class RecoveryTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = self.tmp.name
        self.engine = Engine(self.dir)
        self.addCleanup(self.engine.close)

    def wal_path(self):
        return os.path.join(self.dir, "wal.log")

    def test_a_crash_before_and_after_checkpoint_same_result(self):
        results = []
        for with_checkpoint in (False, True):
            with tempfile.TemporaryDirectory() as d:
                eng = Engine(d)
                eng.put(1, 5, 100)
                eng.commit(1)
                eng.put(2, 7, 200)
                eng.put(1, 9, 300)  # txn 1 already committed: new implicit txn
                eng.commit(1)
                eng.commit(2)
                if with_checkpoint:
                    eng.checkpoint()
                eng.crash()
                eng.recover()
                results.append(eng.dump())
                eng.close()
        self.assertEqual(results[0], results[1])
        self.assertEqual(results[0][5], 100)
        self.assertEqual(results[0][7], 200)
        self.assertEqual(results[0][9], 300)

    def test_b_only_committed_visible_after_recovery(self):
        eng = self.engine
        eng.put(1, 1, 11)
        eng.put(2, 2, 22)
        eng.commit(1)
        eng.put(2, 3, 33)          # txn 2 stays active (uncommitted)
        eng.checkpoint()           # steals uncommitted pages to disk
        eng.crash()
        # before recovery the uncommitted write is physically on disk
        self.assertEqual(eng.dump()[3], 33)
        eng.recover()
        state = eng.dump()
        self.assertEqual(state[1], 11)   # committed: survives
        self.assertEqual(state[2], 0)    # uncommitted: rolled back
        self.assertEqual(state[3], 0)    # uncommitted: rolled back

    def test_c_double_recover_is_idempotent(self):
        eng = self.engine
        eng.put(1, 4, 40)
        eng.commit(1)
        eng.put(2, 5, 50)
        eng.checkpoint()
        eng.put(3, 6, 60)
        eng.commit(3)
        eng.crash()
        eng.recover()
        first = eng.dump()
        with open(self.wal_path(), "rb") as fh:
            wal_after_first = fh.read()
        eng.recover()
        second = eng.dump()
        self.assertEqual(first, second)
        self.assertEqual(first[4], 40)
        self.assertEqual(first[5], 0)
        self.assertEqual(first[6], 60)
        # second recovery must not change the durable state either
        eng.crash()
        eng.recover()
        self.assertEqual(eng.dump(), first)
        self.assertTrue(wal_after_first)  # sanity: WAL existed

    def test_d_matches_full_replay_reference(self):
        rng = random.Random(20261001)
        eng = self.engine
        txns = [1, 2, 3, 4]
        active = set()
        for _ in range(120):
            txn = rng.choice(txns)
            action = rng.random()
            if action < 0.6 or txn not in active:
                key, value = rng.randrange(MAX_KEY), rng.randrange(1000)
                try:
                    eng.put(txn, key, value)
                except LockConflict as exc:
                    # strict 2PL: commit the holder, then retry the put
                    eng.commit(exc.holder)
                    active.discard(exc.holder)
                    eng.put(txn, key, value)
                active.add(txn)
            elif action < 0.8:
                eng.commit(txn)
                active.discard(txn)
            else:
                eng.abort(txn)
                active.discard(txn)
            if rng.random() < 0.15:
                eng.checkpoint()
        eng.crash()
        eng.recover()
        self.assertEqual(eng.dump(), reference_state(self.wal_path()))

    def test_e_cli_end_to_end(self):
        script = "\n".join([
            "put 1 10 111",
            "put 2 20 222",
            "commit 1",
            "checkpoint",
            "crash",
            "recover",
            "dump",
        ])
        proc = subprocess.run(
            [sys.executable, "-m", "recovery", self.dir],
            input=script, capture_output=True, text=True,
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        state = dict(
            line.split("=", 1) for line in proc.stdout.strip().splitlines()
        )
        self.assertEqual(state["10"], "111")
        self.assertEqual(state["20"], "0")


if __name__ == "__main__":
    unittest.main()
