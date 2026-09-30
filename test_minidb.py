#!/usr/bin/env python3
"""Acceptance tests for minidb: crash recovery at three failure points,
semantic-error handling, and view consistency checked by an independent
nested-loop recomputation from the committed base tables."""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
MINIDB = os.path.join(HERE, "minidb.py")


def independent_view(rows_r, rows_s):
    """Independent nested-loop recomputation of the join-count view."""
    counts = {}
    for r in rows_r:
        for s in rows_s:
            if r["k"] == s["k"]:
                counts[r["a"]] = counts.get(r["a"], 0) + 1
    return counts


class MiniDBTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state_dir = os.path.join(self.tmp.name, "state")
        self.tx_counter = 0

    # -- helpers ---------------------------------------------------------

    def write_tx(self, ops):
        self.tx_counter += 1
        path = os.path.join(self.tmp.name, f"tx{self.tx_counter}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"ops": ops}, f)
        return path

    def run_cli(self, *argv):
        return subprocess.run(
            [sys.executable, MINIDB, *argv],
            capture_output=True,
            text=True,
        )

    def apply(self, ops, fail=None):
        txfile = self.write_tx(ops)
        argv = ["apply", txfile, "--state", self.state_dir]
        if fail:
            argv += ["--fail", fail]
        return self.run_cli(*argv)

    def recover(self):
        return self.run_cli("recover", "--state", self.state_dir)

    def load_state(self):
        path = os.path.join(self.state_dir, "tables.json")
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    def wal_records(self):
        path = os.path.join(self.state_dir, "wal.log")
        if not os.path.exists(path):
            return []
        with open(path, "r", encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]

    def assert_view_consistent(self, state):
        expected = independent_view(state["R"], state["S"])
        self.assertEqual(
            state["view"], expected,
            f"stored view {state['view']} != nested-loop recompute {expected}",
        )

    # -- tests -----------------------------------------------------------

    def test_normal_apply_and_view(self):
        rc = self.apply([
            {"op": "insert", "table": "R", "a": "a1", "k": "k1"},
            {"op": "insert", "table": "R", "a": "a2", "k": "k1"},
            {"op": "insert", "table": "S", "k": "k1", "b": "b1"},
            {"op": "insert", "table": "S", "k": "k2", "b": "b2"},
        ])
        self.assertEqual(rc.returncode, 0, rc.stderr)
        state = self.load_state()
        self.assertEqual(state["view"], {"a1": 1, "a2": 1})
        self.assert_view_consistent(state)

    def test_pre_commit_crash_rolls_back(self):
        rc = self.apply([
            {"op": "insert", "table": "R", "a": "a1", "k": "k1"},
            {"op": "insert", "table": "S", "k": "k1", "b": "b1"},
        ])
        self.assertEqual(rc.returncode, 0, rc.stderr)
        before = self.load_state()

        rc = self.apply(
            [{"op": "insert", "table": "R", "a": "aBAD", "k": "k1"}],
            fail="pre_commit",
        )
        self.assertEqual(rc.returncode, 137, rc.stderr)

        rc = self.recover()
        self.assertEqual(rc.returncode, 0, rc.stderr)

        state = self.load_state()
        self.assertEqual(state["R"], before["R"])
        self.assertEqual(state["S"], before["S"])
        self.assertEqual(state["view"], before["view"])
        self.assertFalse(any(r["a"] == "aBAD" for r in state["R"]))
        self.assert_view_consistent(state)

    def test_post_commit_crash_is_redone(self):
        rc = self.apply([
            {"op": "insert", "table": "S", "k": "k1", "b": "b1"},
            {"op": "insert", "table": "S", "k": "k2", "b": "b2"},
        ])
        self.assertEqual(rc.returncode, 0, rc.stderr)

        rc = self.apply(
            [
                {"op": "insert", "table": "R", "a": "a1", "k": "k1"},
                {"op": "insert", "table": "R", "a": "a1", "k": "k2"},
                {"op": "insert", "table": "R", "a": "a2", "k": "k2"},
            ],
            fail="post_commit",
        )
        self.assertEqual(rc.returncode, 137, rc.stderr)

        # Crash happened before checkpoint: base tables must not yet
        # contain the new rows.
        state = self.load_state()
        self.assertEqual(state["R"], [])

        rc = self.recover()
        self.assertEqual(rc.returncode, 0, rc.stderr)

        state = self.load_state()
        self.assertEqual(len(state["R"]), 3)
        self.assertEqual(state["view"], {"a1": 2, "a2": 1})
        self.assert_view_consistent(state)

    def test_post_checkpoint_crash_not_reapplied(self):
        rc = self.apply([
            {"op": "insert", "table": "R", "a": "a1", "k": "k1"},
            {"op": "insert", "table": "S", "k": "k1", "b": "b1"},
        ])
        self.assertEqual(rc.returncode, 0, rc.stderr)

        rc = self.apply(
            [{"op": "insert", "table": "R", "a": "a2", "k": "k1"}],
            fail="post_checkpoint",
        )
        self.assertEqual(rc.returncode, 137, rc.stderr)

        rc = self.recover()
        self.assertEqual(rc.returncode, 0, rc.stderr)

        state = self.load_state()
        # Committed exactly once: a second apply would show up as
        # duplicated rows / doubled counts.
        self.assertEqual(len(state["R"]), 2)
        self.assertEqual(len(state["S"]), 1)
        self.assertEqual(state["view"], {"a1": 1, "a2": 1})
        self.assert_view_consistent(state)

    def test_semantic_error_exit2_and_no_commit(self):
        rc = self.apply([
            {"op": "insert", "table": "R", "a": "a1", "k": "k1"},
            {"op": "insert", "table": "S", "k": "k1", "b": "b1"},
        ])
        self.assertEqual(rc.returncode, 0, rc.stderr)
        before = self.load_state()

        bad_txs = [
            [{"op": "insert", "table": "R", "a": "a1", "k": "k1"}],   # duplicate R
            [{"op": "insert", "table": "S", "k": "k1", "b": "b9"}],   # duplicate S
            [{"op": "delete", "table": "R", "a": "zz", "k": "zz"}],   # missing row
            [{"op": "insert", "table": "Q", "a": "a", "k": "k"}],     # bad table
            [{"op": "upsert", "table": "R", "a": "a", "k": "k"}],     # bad op
            [{"op": "insert", "table": "R", "a": "a2"}],              # missing field
        ]
        for ops in bad_txs:
            rc = self.apply(ops)
            self.assertEqual(rc.returncode, 2, f"{ops}: {rc.stderr}")

        # Old state untouched; WAL carries no COMMIT for any bad tx.
        self.assertEqual(self.load_state(), before)
        self.assertFalse(
            any(r["type"] == "COMMIT" for r in self.wal_records()),
            "a semantic-error transaction must not write COMMIT",
        )

        rc = self.recover()
        self.assertEqual(rc.returncode, 0, rc.stderr)
        state = self.load_state()
        self.assertEqual(state["R"], before["R"])
        self.assertEqual(state["S"], before["S"])
        self.assertEqual(state["view"], before["view"])
        self.assert_view_consistent(state)

    def test_bad_tx_file_exit2(self):
        path = os.path.join(self.tmp.name, "broken.json")
        with open(path, "w", encoding="utf-8") as f:
            f.write("{not json")
        rc = self.run_cli("apply", path, "--state", self.state_dir)
        self.assertEqual(rc.returncode, 2)

    def test_recover_on_empty_state_dir(self):
        rc = self.recover()
        self.assertEqual(rc.returncode, 0, rc.stderr)
        state = self.load_state()
        self.assertEqual(state["view"], {})
        self.assert_view_consistent(state)

    def test_delete_updates_view(self):
        rc = self.apply([
            {"op": "insert", "table": "R", "a": "a1", "k": "k1"},
            {"op": "insert", "table": "R", "a": "a1", "k": "k2"},
            {"op": "insert", "table": "S", "k": "k1", "b": "b1"},
            {"op": "insert", "table": "S", "k": "k2", "b": "b2"},
        ])
        self.assertEqual(rc.returncode, 0, rc.stderr)
        rc = self.apply([{"op": "delete", "table": "S", "k": "k2"}])
        self.assertEqual(rc.returncode, 0, rc.stderr)
        state = self.load_state()
        self.assertEqual(state["view"], {"a1": 1})
        self.assert_view_consistent(state)


if __name__ == "__main__":
    unittest.main()
