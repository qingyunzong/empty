"""Acceptance tests for snapidx.

A: enumerate small operation sequences and compare against a naive model.
B: three-level nested rollback.
C: snapshots keep old results under interleaved add/commit.
D: log recovery with truncation at a record boundary and inside a record.
Plus: CLI exit codes for the specified error cases.
"""

import itertools
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from snapidx import SnapIdx, SnapIdxError, NoTransactionError, UnknownSnapshotError


# --------------------------------------------------------------------- model

class Model:
    """Naive reference implementation: every transaction layer holds a full
    copy of the view. Independent of SnapIdx's delta-layer design."""

    def __init__(self):
        self.states = [{}]          # committed snapshots, index == seq
        self.layers = []            # each: [view_dict, op_count]

    def _view(self):
        return self.layers[-1][0] if self.layers else self.states[-1]

    @property
    def seq(self):
        return len(self.states) - 1

    def begin(self):
        self.layers.append([dict(self._view()), 0])

    def add(self, doc_id, terms):
        if not self.layers:
            raise NoTransactionError("add without an active transaction")
        self.layers[-1][0][doc_id] = frozenset(terms)
        self.layers[-1][1] += 1

    def delete(self, doc_id):
        if not self.layers:
            raise NoTransactionError("del without an active transaction")
        self.layers[-1][0].pop(doc_id, None)
        self.layers[-1][1] += 1

    def commit(self):
        if not self.layers:
            raise NoTransactionError("commit without an active transaction")
        view, ops = self.layers.pop()
        if self.layers:
            self.layers[-1][0] = view
            self.layers[-1][1] += ops
            return None
        if ops == 0:
            return None
        self.states.append(view)
        return self.seq

    def rollback(self):
        if not self.layers:
            raise NoTransactionError("rollback without an active transaction")
        self.layers.pop()

    def search(self, term, snapshot=None):
        if snapshot is not None:
            if not 0 <= snapshot <= self.seq:
                raise UnknownSnapshotError("unknown snapshot")
            state = self.states[snapshot]
        else:
            state = self._view()
        return sorted(d for d, terms in state.items() if term in terms)


# ------------------------------------------------------------------ test A

class TestModelEnumeration(unittest.TestCase):
    """Enumerate all op sequences up to length 5 over a small alphabet and
    compare SnapIdx against the naive model after every step."""

    OPS = [
        ("begin",),
        ("commit",),
        ("rollback",),
        ("add", "a", ("x",)),
        ("add", "b", ("x", "y")),
        ("add", "a", ("y",)),       # overwrite same id
        ("del", "a"),
        ("del", "zz"),              # delete missing id: no-op
    ]

    def _apply(self, obj, op):
        name = op[0]
        if name == "begin":
            obj.begin()
        elif name == "commit":
            obj.commit()
        elif name == "rollback":
            obj.rollback()
        elif name == "add":
            obj.add(op[1], op[2])
        elif name == "del":
            obj.delete(op[1])

    def _check_equal(self, idx, model, context):
        self.assertEqual(idx.seq, model.seq, context)
        self.assertEqual(idx.txn_depth, len(model.layers), context)
        for term in ("x", "y", "absent"):
            self.assertEqual(idx.search(term), model.search(term), context)
            for s in range(model.seq + 1):
                self.assertEqual(idx.search(term, snapshot=s),
                                 model.search(term, snapshot=s), context)

    def test_enumeration(self):
        checked = 0
        for length in range(1, 6):
            for seq_ops in itertools.product(self.OPS, repeat=length):
                idx = SnapIdx()
                model = Model()
                for step, op in enumerate(seq_ops):
                    ctx = f"seq={seq_ops[:step + 1]}"
                    err_idx = err_model = None
                    try:
                        self._apply(idx, op)
                    except SnapIdxError as exc:
                        err_idx = type(exc)
                    try:
                        self._apply(model, op)
                    except SnapIdxError as exc:
                        err_model = type(exc)
                    self.assertEqual(err_idx, err_model, ctx)
                    self._check_equal(idx, model, ctx)
                checked += 1
        # sanity: we really enumerated a large space
        self.assertGreater(checked, 19000)


# ------------------------------------------------------------------ test B

class TestNestedRollback(unittest.TestCase):
    def test_three_level_rollback(self):
        idx = SnapIdx()
        idx.begin()
        idx.add("a", ["x"])
        idx.begin()
        idx.add("b", ["x"])
        idx.begin()
        idx.add("c", ["x"])
        self.assertEqual(idx.txn_depth, 3)
        self.assertEqual(idx.search("x"), ["a", "b", "c"])

        idx.rollback()  # undo only level 3
        self.assertEqual(idx.search("x"), ["a", "b"])
        idx.rollback()  # undo only level 2
        self.assertEqual(idx.search("x"), ["a"])

        # outer layer continues: add more, then commit
        idx.add("d", ["x"])
        seq = idx.commit()
        self.assertEqual(seq, 1)
        self.assertEqual(idx.search("x"), ["a", "d"])
        self.assertEqual(idx.search("x", snapshot=1), ["a", "d"])
        self.assertEqual(idx.search("x", snapshot=0), [])

    def test_rollback_without_transaction_exit(self):
        idx = SnapIdx()
        with self.assertRaises(NoTransactionError):
            idx.rollback()

    def test_empty_commit_keeps_seq(self):
        idx = SnapIdx()
        idx.begin()
        idx.begin()
        self.assertIsNone(idx.commit())   # empty nested commit
        self.assertIsNone(idx.commit())   # empty outermost commit
        self.assertEqual(idx.seq, 0)
        idx.begin()
        idx.add("a", ["x"])
        self.assertEqual(idx.commit(), 1)  # seq advances only now


# ------------------------------------------------------------------ test C

class TestSnapshotIsolation(unittest.TestCase):
    def test_interleaved_add_commit_keeps_old_snapshots(self):
        idx = SnapIdx()
        idx.begin()
        idx.add("d1", ["x"])
        self.assertEqual(idx.commit(), 1)
        before = idx.search("x", snapshot=1)

        # uncommitted changes are invisible to every open snapshot
        idx.begin()
        idx.add("d2", ["x"])
        self.assertEqual(idx.search("x", snapshot=1), before)
        self.assertEqual(idx.search("x", snapshot=0), [])
        self.assertEqual(idx.search("x"), ["d1", "d2"])  # current view sees it

        # commit only affects later snapshots
        self.assertEqual(idx.commit(), 2)
        self.assertEqual(idx.search("x", snapshot=1), before)
        self.assertEqual(idx.search("x", snapshot=2), ["d1", "d2"])

        # more interleaving: delete + overwrite
        idx.begin()
        idx.delete("d1")
        idx.add("d2", ["y"])
        self.assertEqual(idx.commit(), 3)
        self.assertEqual(idx.search("x", snapshot=1), before)
        self.assertEqual(idx.search("x", snapshot=2), ["d1", "d2"])
        self.assertEqual(idx.search("x", snapshot=3), [])
        self.assertEqual(idx.search("y", snapshot=3), ["d2"])

    def test_unknown_snapshot_raises(self):
        idx = SnapIdx()
        with self.assertRaises(UnknownSnapshotError):
            idx.search("x", snapshot=1)
        idx.begin()
        idx.add("a", ["x"])
        idx.commit()
        with self.assertRaises(UnknownSnapshotError):
            idx.search("x", snapshot=2)
        with self.assertRaises(UnknownSnapshotError):
            idx.search("x", snapshot=-1)


# ------------------------------------------------------------------ test D

class TestLogRecovery(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.log = os.path.join(self.tmp.name, "snapidx.log")

    def tearDown(self):
        self.tmp.cleanup()

    def _write_two_commits(self):
        idx = SnapIdx(log_path=self.log)
        idx.begin()
        idx.add("a", ["x"])
        idx.commit()
        idx.begin()
        idx.add("b", ["y"])
        idx.commit()
        idx.close()
        with open(self.log, "rb") as fh:
            data = fh.read()
        first_end = data.find(b"\n") + 1
        return data, first_end

    def test_clean_recovery(self):
        self._write_two_commits()
        idx = SnapIdx(log_path=self.log)
        self.assertEqual(idx.seq, 2)
        self.assertEqual(idx.search("x", snapshot=1), ["a"])
        self.assertEqual(idx.search("y", snapshot=2), ["b"])
        idx.close()

    def test_truncate_at_record_boundary(self):
        data, first_end = self._write_two_commits()
        with open(self.log, "r+b") as fh:
            fh.truncate(first_end)  # exactly after record 1
        warnings = []
        idx = SnapIdx(log_path=self.log, warn=warnings.append)
        self.assertEqual(idx.seq, 1)
        self.assertEqual(idx.search("x", snapshot=1), ["a"])
        self.assertEqual(idx.search("y"), [])
        self.assertEqual(warnings, [])  # clean boundary: no warning
        idx.close()

    def test_truncate_inside_record(self):
        data, first_end = self._write_two_commits()
        cut = first_end + (len(data) - first_end) // 2  # mid record 2
        with open(self.log, "r+b") as fh:
            fh.truncate(cut)
        warnings = []
        idx = SnapIdx(log_path=self.log, warn=warnings.append)
        # recover to last complete commit; half record discarded with warning
        self.assertEqual(idx.seq, 1)
        self.assertEqual(idx.search("x", snapshot=1), ["a"])
        self.assertEqual(len(warnings), 1)
        self.assertIn("discard", warnings[0])
        # torn tail was removed; new commits append cleanly and survive
        idx.begin()
        idx.add("c", ["z"])
        self.assertEqual(idx.commit(), 2)
        idx.close()
        idx2 = SnapIdx(log_path=self.log)
        self.assertEqual(idx2.seq, 2)
        self.assertEqual(idx2.search("z", snapshot=2), ["c"])
        idx2.close()

    def test_torn_commit_record_ignored(self):
        # Simulate a crash mid-commit: valid record 1, then garbage bytes
        # that were never fsynced as a complete record.
        data, first_end = self._write_two_commits()
        with open(self.log, "r+b") as fh:
            fh.truncate(first_end)
            fh.seek(first_end)
            fh.write(b"SNAPIDX1 999 deadbeef {\"seq\":2,\"ops\":[[\"a\"")  # torn
        warnings = []
        idx = SnapIdx(log_path=self.log, warn=warnings.append)
        self.assertEqual(idx.seq, 1)  # uncommitted/torn record ignored
        self.assertEqual(idx.search("y"), [])
        self.assertEqual(len(warnings), 1)
        idx.close()


# ------------------------------------------------------------------ CLI tests

class TestCli(unittest.TestCase):
    def _run(self, script_text, log=None):
        with tempfile.NamedTemporaryFile(
                "w", suffix=".txt", delete=False) as fh:
            fh.write(script_text)
            path = fh.name
        try:
            cmd = [sys.executable, "-m", "snapidx"]
            if log:
                cmd += ["--log", log]
            cmd.append(path)
            return subprocess.run(cmd, capture_output=True, text=True)
        finally:
            os.unlink(path)

    def test_unknown_snapshot_exit3(self):
        proc = self._run("begin\nadd a x\ncommit\nsearch x --snapshot 7\n")
        self.assertEqual(proc.returncode, 3)
        self.assertIn("unknown snapshot", proc.stderr)

    def test_rollback_without_transaction_exit3(self):
        proc = self._run("rollback\n")
        self.assertEqual(proc.returncode, 3)
        self.assertIn("rollback", proc.stderr)

    def test_basic_script_ok(self):
        proc = self._run(
            "begin\nadd a x y\ncommit\nsearch x\nsearch x --snapshot 1\n")
        self.assertEqual(proc.returncode, 0)
        self.assertIn("ok commit seq=1", proc.stdout)
        self.assertEqual(proc.stdout.strip().splitlines()[-2:], ["a", "a"])


if __name__ == "__main__":
    unittest.main()
