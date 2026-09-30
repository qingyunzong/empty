"""Acceptance tests for snapidx.

A: enumerate small op sequences, cross-checked against an independent model.
B: three-level nested rollback.
C: snapshots keep old results under interleaved (threaded) add/commit.
D: log recovery from truncation at a record boundary and mid-record.
"""

import io
import json
import os
import random
import subprocess
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import snapidx
from snapidx import NoTransactionError, SnapIdx, UnknownSnapshotError


# --------------------------------------------------------------------------
# Independent reference model used by test A.
# --------------------------------------------------------------------------
class Model:
    def __init__(self):
        self.committed = {}
        self.seq = 0
        self.states = {0: {}}
        self.stack = []

    def _view(self):
        view = dict(self.committed)
        for layer in self.stack:
            for key, value in layer.items():
                if value is None:
                    view.pop(key, None)
                else:
                    view[key] = value
        return view

    def begin(self):
        self.stack.append({})

    def add(self, key, text):
        if self.stack:
            self.stack[-1][key] = text
        else:
            self.committed[key] = text
            self.seq += 1
            self.states[self.seq] = dict(self.committed)

    def delete(self, key):
        if key not in self._view():
            return
        if self.stack:
            self.stack[-1][key] = None
        else:
            self.committed.pop(key, None)
            self.seq += 1
            self.states[self.seq] = dict(self.committed)

    def commit(self):
        layer = self.stack.pop()
        if self.stack:
            self.stack[-1].update(layer)
        elif layer:
            for key, value in layer.items():
                if value is None:
                    self.committed.pop(key, None)
                else:
                    self.committed[key] = value
            self.seq += 1
            self.states[self.seq] = dict(self.committed)
        return self.seq

    def rollback(self):
        self.stack.pop()

    def search(self, term, snapshot=None):
        data = self._view() if snapshot is None else self.states[snapshot]
        return sorted(k for k, v in data.items() if term in v)


# --------------------------------------------------------------------------
# A: small-sequence enumeration vs. model
# --------------------------------------------------------------------------
class TestA_ModelEnumeration(unittest.TestCase):
    def test_random_sequences_match_model(self):
        ids = ["a", "b", "c"]
        terms = ["x", "y"]
        rng = random.Random(20240930)
        for trial in range(300):
            db = SnapIdx()
            model = Model()
            for _ in range(40):
                op = rng.choice(
                    ["begin", "add", "del", "commit", "rollback",
                     "search", "search_snap", "search_bad_snap"])
                if op == "begin":
                    db.begin()
                    model.begin()
                elif op == "add":
                    key, term = rng.choice(ids), rng.choice(terms)
                    text = f"{term}{rng.randint(0, 2)}"
                    db.add(key, text)
                    model.add(key, text)
                elif op == "del":
                    key = rng.choice(ids)
                    db.delete(key)
                    model.delete(key)
                elif op == "commit":
                    if model.stack:
                        self.assertEqual(db.commit(), model.commit())
                    else:
                        with self.assertRaises(NoTransactionError):
                            db.commit()
                elif op == "rollback":
                    if model.stack:
                        db.rollback()
                        model.rollback()
                    else:
                        with self.assertRaises(NoTransactionError):
                            db.rollback()
                elif op == "search":
                    term = rng.choice(terms)
                    self.assertEqual(db.search(term), model.search(term),
                                     f"trial {trial}")
                elif op == "search_snap":
                    term = rng.choice(terms)
                    snap = rng.randint(0, model.seq)
                    self.assertEqual(db.search(term, snapshot=snap),
                                     model.search(term, snapshot=snap),
                                     f"trial {trial} snapshot {snap}")
                else:  # search_bad_snap
                    with self.assertRaises(UnknownSnapshotError):
                        db.search("x", snapshot=model.seq + 1 + rng.randint(0, 5))
                self.assertEqual(db.sequence, model.seq, f"trial {trial}")


# --------------------------------------------------------------------------
# Core semantics
# --------------------------------------------------------------------------
class TestCoreSemantics(unittest.TestCase):
    def test_empty_commit_does_not_advance_sequence(self):
        db = SnapIdx()
        db.begin()
        self.assertEqual(db.commit(), 0)
        self.assertEqual(db.sequence, 0)

    def test_del_missing_id_is_noop_and_keeps_tx_empty(self):
        db = SnapIdx()
        db.begin()
        db.delete("ghost")
        self.assertEqual(db.commit(), 0)  # still an empty transaction
        self.assertEqual(db.sequence, 0)

    def test_readd_same_id_overwrites(self):
        db = SnapIdx()
        db.add("d1", "first")
        db.add("d1", "second")
        self.assertEqual(db.search("first"), [])
        self.assertEqual(db.search("second"), ["d1"])
        self.assertEqual(db.sequence, 2)

    def test_uncommitted_invisible_to_snapshots(self):
        db = SnapIdx()
        db.add("d1", "alpha")
        db.begin()
        db.add("d2", "beta")
        self.assertEqual(db.search("beta", snapshot=1), [])
        self.assertEqual(db.search("beta"), ["d2"])  # visible in live view
        db.commit()
        self.assertEqual(db.search("beta", snapshot=1), [])
        self.assertEqual(db.search("beta", snapshot=2), ["d2"])

    def test_unknown_snapshot_raises(self):
        db = SnapIdx()
        with self.assertRaises(UnknownSnapshotError):
            db.search("x", snapshot=7)

    def test_rollback_without_transaction_raises(self):
        db = SnapIdx()
        with self.assertRaises(NoTransactionError):
            db.rollback()

    def test_commit_without_transaction_raises(self):
        db = SnapIdx()
        with self.assertRaises(NoTransactionError):
            db.commit()


# --------------------------------------------------------------------------
# B: three-level nested rollback
# --------------------------------------------------------------------------
class TestB_NestedRollback(unittest.TestCase):
    def test_three_level_rollback(self):
        db = SnapIdx()
        db.begin()              # L1
        db.add("a", "term-a")
        db.begin()              # L2
        db.add("b", "term-b")
        db.begin()              # L3
        db.add("c", "term-c")
        db.rollback()           # discard only L3
        self.assertEqual(db.search("term-c"), [])
        self.assertEqual(db.search("term-b"), ["b"])
        db.rollback()           # discard only L2
        self.assertEqual(db.search("term-b"), [])
        self.assertEqual(db.search("term-a"), ["a"])
        self.assertEqual(db.commit(), 1)  # outer layer survives and commits
        self.assertEqual(db.search("term-a", snapshot=1), ["a"])
        self.assertEqual(db.search("term-b", snapshot=1), [])

    def test_inner_commit_merges_outward(self):
        db = SnapIdx()
        db.begin()
        db.add("a", "x")
        db.begin()
        db.add("b", "x")
        db.commit()             # inner commit: no sequence bump
        self.assertEqual(db.sequence, 0)
        db.rollback()           # outer rollback discards merged changes
        self.assertEqual(db.search("x"), [])
        self.assertEqual(db.sequence, 0)


# --------------------------------------------------------------------------
# C: snapshot stability under interleaved add/commit
# --------------------------------------------------------------------------
class TestC_SnapshotIsolation(unittest.TestCase):
    def test_interleaved_add_commit_keeps_old_snapshot(self):
        db = SnapIdx()
        db.add("d1", "apple")
        snap = db.sequence
        for i in range(50):
            db.add(f"d{i}", "apple")
            self.assertEqual(db.search("apple", snapshot=snap), ["d1"])

    def test_threaded_interleave(self):
        db = SnapIdx()
        db.add("seed", "apple")
        snap = db.sequence
        stop = threading.Event()
        failures = []

        def writer(tid):
            for i in range(200):
                db.add(f"w{tid}-{i}", "apple banana")

        def reader():
            while not stop.is_set():
                try:
                    if db.search("apple", snapshot=snap) != ["seed"]:
                        failures.append("snapshot mutated")
                except UnknownSnapshotError:
                    failures.append("snapshot vanished")

        threads = ([threading.Thread(target=writer, args=(t,)) for t in range(3)] +
                   [threading.Thread(target=reader) for _ in range(3)])
        for t in threads:
            t.start()
        for t in threads[:3]:
            t.join()
        stop.set()
        for t in threads[3:]:
            t.join()
        self.assertEqual(failures, [])
        self.assertEqual(db.search("apple", snapshot=snap), ["seed"])
        self.assertEqual(len(db.search("banana")), 200 * 3)


# --------------------------------------------------------------------------
# D: log truncation recovery
# --------------------------------------------------------------------------
class TestD_LogRecovery(unittest.TestCase):
    def _build_log(self, path):
        db = SnapIdx(log_path=path)
        db.add("d1", "alpha")          # commit 1
        db.add("d2", "beta")           # commit 2
        db.begin()
        db.add("d3", "gamma")
        db.delete("d1")
        db.commit()                    # commit 3
        with open(path, "rb") as fh:
            return fh.read()

    def test_recover_full_log(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "idx.log")
            self._build_log(path)
            db = SnapIdx(log_path=path)
            self.assertEqual(db.sequence, 3)
            self.assertEqual(db.search("beta"), ["d2"])
            self.assertEqual(db.search("gamma"), ["d3"])
            self.assertEqual(db.search("alpha"), [])  # d1 deleted in commit 3

    def test_truncate_at_record_boundary(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "idx.log")
            raw = self._build_log(path)
            lines = raw.split(b"\n")
            # Drop the final commit marker of commit 3 plus its ops:
            # keep exactly the records of commits 1 and 2.
            keep = b"\n".join(lines[:6]) + b"\n"
            with open(path, "wb") as fh:
                fh.write(keep)
            warnings = []
            db = SnapIdx(log_path=path, warn=warnings.append)
            self.assertEqual(db.sequence, 2)
            self.assertEqual(db.search("beta"), ["d2"])
            self.assertEqual(db.search("gamma"), [])  # uncommitted: ignored
            self.assertEqual(warnings, [])            # clean boundary

    def test_truncate_mid_record(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "idx.log")
            raw = self._build_log(path)
            cut = len(raw) - 5  # slice inside the final commit record
            with open(path, "wb") as fh:
                fh.write(raw[:cut])
            warnings = []
            db = SnapIdx(log_path=path, warn=warnings.append)
            self.assertEqual(db.sequence, 2)
            self.assertEqual(db.search("gamma"), [])
            self.assertEqual(len(warnings), 1)
            self.assertIn("incomplete", warnings[0])

    def test_crash_between_ops_and_commit_marker(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "idx.log")
            db = SnapIdx(log_path=path)
            db.add("d1", "alpha")  # commit 1
            # Simulate a crash: ops written without their commit marker.
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps({"op": "add", "id": "d9", "text": "zzz"}) + "\n")
            db2 = SnapIdx(log_path=path)
            self.assertEqual(db2.sequence, 1)
            self.assertEqual(db2.search("zzz"), [])


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
class TestCLI(unittest.TestCase):
    def run_cli(self, commands, *argv):
        return subprocess.run(
            [sys.executable, "snapidx.py", *argv],
            input="\n".join(commands) + "\n",
            capture_output=True, text=True,
            cwd=os.path.dirname(os.path.abspath(__file__)))

    def test_basic_session(self):
        proc = self.run_cli([
            "begin", "add 1 hello world", "add 2 hello there", "commit",
            "search hello", "search hello --snapshot 0",
            "search hello --snapshot 1", "exit"])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = proc.stdout.splitlines()
        self.assertEqual(lines, ["ok", "ok", "ok", "seq 1",
                                 "1 2", "", "1 2"])

    def test_unknown_snapshot_exit_3(self):
        proc = self.run_cli(["search x --snapshot 9"])
        self.assertEqual(proc.returncode, 3)
        self.assertIn("unknown snapshot", proc.stderr)

    def test_rollback_without_transaction_exit_3(self):
        proc = self.run_cli(["rollback"])
        self.assertEqual(proc.returncode, 3)
        self.assertIn("rollback without active transaction", proc.stderr)

    def test_cli_persistence_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "idx.log")
            p1 = self.run_cli(["add 1 hello", "add 2 world", "exit"], "--log", log)
            self.assertEqual(p1.returncode, 0, p1.stderr)
            p2 = self.run_cli(["search hello", "search world"], "--log", log)
            self.assertEqual(p2.stdout.splitlines(), ["1", "2"])


if __name__ == "__main__":
    unittest.main()
