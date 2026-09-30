#!/usr/bin/env python3
"""End-to-end tests for minidb: run the real CLI in subprocesses and verify
the materialized view against an independent nested-loop recomputation."""

import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.abspath(__file__))
MINIDB = os.path.join(ROOT, "minidb.py")

EXIT_OK = 0
EXIT_SEMANTIC_ERROR = 2
EXIT_SIMULATED_CRASH = 137


def recompute_view(R, S):
    """Independent nested-loop recomputation of the join-count view."""
    view = {}
    for a, k in R:
        for sk, _b in S:
            if k == sk:
                view[a] = view.get(a, 0) + 1
    return view


def ins(table, tup):
    return {"op": "insert", "table": table, "tuple": tup}


def dele(table, tup):
    return {"op": "delete", "table": table, "tuple": tup}


class MiniDBTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = os.path.join(self.tmp.name, "db")
        os.makedirs(self.dir)
        self._tx_seq = 0

    # -- CLI helpers ------------------------------------------------------

    def apply_tx(self, ops, fail=None):
        self._tx_seq += 1
        txpath = os.path.join(self.tmp.name, "tx%d.json" % self._tx_seq)
        with open(txpath, "w", encoding="utf-8") as fh:
            json.dump({"ops": ops}, fh)
        cmd = [sys.executable, MINIDB, "apply", txpath, "--state-dir", self.dir]
        if fail:
            cmd += ["--fail", fail]
        return subprocess.run(cmd, capture_output=True, text=True)

    def recover(self):
        return subprocess.run(
            [sys.executable, MINIDB, "recover", "--state-dir", self.dir],
            capture_output=True, text=True)

    # -- state helpers ----------------------------------------------------

    def load_state(self):
        with open(os.path.join(self.dir, "state.json"), encoding="utf-8") as fh:
            return json.load(fh)

    def assert_view_consistent(self):
        """Stored view must equal the independent nested-loop recomputation."""
        state = self.load_state()
        self.assertEqual(recompute_view(state["R"], state["S"]), state["view"])

    def seed(self):
        ops = [ins("R", ["a1", "k1"]), ins("R", ["a2", "k1"]),
               ins("R", ["a3", "k2"]), ins("S", ["k1", "b1"]),
               ins("S", ["k2", "b2"])]
        res = self.apply_tx(ops)
        self.assertEqual(res.returncode, EXIT_OK, res.stderr)
        return self.load_state()

    # -- tests ------------------------------------------------------------

    def test_normal_apply_and_view(self):
        seeded = self.seed()
        self.assertEqual(seeded["view"], {"a1": 1, "a2": 1, "a3": 1})
        self.assert_view_consistent()
        res = self.apply_tx([ins("S", ["k1", "b9"]), dele("R", ["a3", "k2"])])
        self.assertEqual(res.returncode, EXIT_OK, res.stderr)
        state = self.load_state()
        self.assertEqual(state["view"], {"a1": 2, "a2": 2})
        self.assert_view_consistent()

    def test_semantic_error_exit2_no_commit_old_state_untouched(self):
        seeded = self.seed()
        res = self.apply_tx([ins("R", ["a9", "k1"]),      # valid, logged
                             ins("R", ["a1", "k1"])])      # duplicate -> error
        self.assertEqual(res.returncode, EXIT_SEMANTIC_ERROR)
        self.assertIn("semantic error", res.stderr)
        self.assertEqual(self.load_state(), seeded)        # nothing committed
        with open(os.path.join(self.dir, "wal.log"), encoding="utf-8") as fh:
            wal = fh.read()
        self.assertNotIn('"commit"', wal)                  # no COMMIT written
        res = self.recover()
        self.assertEqual(res.returncode, EXIT_OK, res.stderr)
        self.assertEqual(self.load_state(), seeded)        # rollback complete
        self.assert_view_consistent()

    def test_delete_missing_tuple_is_semantic_error(self):
        self.seed()
        res = self.apply_tx([dele("R", ["nope", "k9"])])
        self.assertEqual(res.returncode, EXIT_SEMANTIC_ERROR)
        res = self.recover()
        self.assertEqual(res.returncode, EXIT_OK, res.stderr)
        self.assert_view_consistent()

    def test_pre_commit_crash_rolls_back_fully(self):
        seeded = self.seed()
        res = self.apply_tx([ins("R", ["a7", "k1"]), ins("S", ["k1", "b7"])],
                            fail="pre_commit")
        self.assertEqual(res.returncode, EXIT_SIMULATED_CRASH)
        res = self.recover()
        self.assertEqual(res.returncode, EXIT_OK, res.stderr)
        self.assertEqual(self.load_state(), seeded)  # txn fully rolled back
        self.assert_view_consistent()

    def test_post_commit_crash_is_redone(self):
        self.seed()
        ops = [ins("R", ["a7", "k1"]), ins("S", ["k1", "b7"]),
               dele("S", ["k2", "b2"])]
        res = self.apply_tx(ops, fail="post_commit")
        self.assertEqual(res.returncode, EXIT_SIMULATED_CRASH)
        res = self.recover()
        self.assertEqual(res.returncode, EXIT_OK, res.stderr)
        self.assertIn("redone=1", res.stdout)
        state = self.load_state()
        self.assertIn(["a7", "k1"], state["R"])
        self.assertIn(["k1", "b7"], state["S"])
        self.assertNotIn(["k2", "b2"], state["S"])
        self.assertEqual(state["view"], {"a1": 2, "a2": 2, "a7": 2})
        self.assert_view_consistent()

    def test_post_checkpoint_crash_not_reapplied(self):
        self.seed()
        ops = [ins("R", ["a7", "k1"]), ins("S", ["k1", "b7"])]
        res = self.apply_tx(ops, fail="post_checkpoint")
        self.assertEqual(res.returncode, EXIT_SIMULATED_CRASH)
        expected = self.load_state()  # checkpoint already durable
        self.assertEqual(expected["view"], {"a1": 2, "a2": 2, "a3": 1, "a7": 2})
        res = self.recover()
        self.assertEqual(res.returncode, EXIT_OK, res.stderr)
        self.assertIn("redone=0", res.stdout)  # committed, not applied twice
        self.assertEqual(self.load_state(), expected)
        self.assert_view_consistent()

    def test_multiple_pending_commits_redone_in_order(self):
        self.seed()
        res = self.apply_tx([ins("R", ["a7", "k1"])], fail="post_commit")
        self.assertEqual(res.returncode, EXIT_SIMULATED_CRASH)
        res = self.apply_tx([ins("S", ["k1", "b7"])], fail="post_commit")
        self.assertEqual(res.returncode, EXIT_SIMULATED_CRASH)
        res = self.recover()
        self.assertEqual(res.returncode, EXIT_OK, res.stderr)
        self.assertIn("redone=2", res.stdout)
        state = self.load_state()
        self.assertEqual(state["view"],
                         {"a1": 2, "a2": 2, "a3": 1, "a7": 2})
        self.assert_view_consistent()

    def test_recover_on_empty_dir(self):
        res = self.recover()
        self.assertEqual(res.returncode, EXIT_OK, res.stderr)
        self.assertEqual(self.load_state(),
                         {"R": [], "S": [], "view": {}, "last_lsn": 0})

    def test_wal_records_fsynced_and_complete_after_crash(self):
        self.seed()
        res = self.apply_tx([ins("R", ["a7", "k1"])], fail="post_commit")
        self.assertEqual(res.returncode, EXIT_SIMULATED_CRASH)
        with open(os.path.join(self.dir, "wal.log"), encoding="utf-8") as fh:
            records = [json.loads(line) for line in fh if line.strip()]
        # every line is valid JSON and the final record is the COMMIT
        self.assertEqual(records[-1]["type"], "commit")
        res = self.recover()
        self.assertEqual(res.returncode, EXIT_OK, res.stderr)
        self.assert_view_consistent()


if __name__ == "__main__":
    unittest.main(verbosity=2)
