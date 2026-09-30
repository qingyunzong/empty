"""Acceptance and unit tests for safedelsync."""

from __future__ import annotations

import itertools
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from safedelsync import core  # noqa: E402


def write_file(root, rel, content):
    full = os.path.join(root, rel)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf-8") as handle:
        handle.write(content)


def read_file(root, rel):
    with open(os.path.join(root, rel), "r", encoding="utf-8") as handle:
        return handle.read()


def tree(root):
    result = {}
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            result[rel] = read_file(root, rel)
    return result


class SyncTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = self.tmp.name
        self.left = os.path.join(base, "L")
        self.right = os.path.join(base, "R")
        self.state = os.path.join(base, "state.json")
        os.makedirs(self.left)
        os.makedirs(self.right)

    def sync(self):
        return core.sync(self.left, self.right, self.state)

    def run_cli(self, *extra_args):
        env = dict(os.environ, PYTHONPATH=REPO_ROOT)
        return subprocess.run(
            [sys.executable, "-m", "safedelsync", "sync",
             self.left, self.right, "--state", self.state, *extra_args],
            capture_output=True, text=True, env=env,
        )

    def assert_converged(self):
        self.assertEqual(tree(self.left), tree(self.right))

    def assert_stable(self):
        stats = self.sync()
        self.assertEqual(stats, {"copied": 0, "deleted": 0, "conflicts": 0})
        self.assert_converged()


class TestBasicSync(SyncTestCase):
    def test_new_file_on_one_side_is_copied_not_deleted(self):
        # Acceptance B: a one-sided add must never be treated as a delete.
        write_file(self.left, "keep.txt", "keep")
        write_file(self.right, "keep.txt", "keep")
        self.sync()
        write_file(self.left, "new.txt", "brand new")
        stats = self.sync()
        self.assertEqual(stats["deleted"], 0)
        self.assertEqual(stats["copied"], 1)
        self.assertEqual(read_file(self.right, "new.txt"), "brand new")
        self.assert_converged()
        self.assert_stable()

    def test_first_sync_merges_both_sides(self):
        write_file(self.left, "a.txt", "from left")
        write_file(self.right, "b.txt", "from right")
        stats = self.sync()
        self.assertEqual(stats["copied"], 2)
        self.assert_converged()
        self.assertEqual(read_file(self.left, "b.txt"), "from right")
        self.assertEqual(read_file(self.right, "a.txt"), "from left")
        self.assert_stable()

    def test_modify_propagates(self):
        write_file(self.left, "a.txt", "v1")
        write_file(self.right, "a.txt", "v1")
        self.sync()
        write_file(self.right, "a.txt", "v2")
        stats = self.sync()
        self.assertEqual(stats["copied"], 1)
        self.assertEqual(read_file(self.left, "a.txt"), "v2")
        self.assert_stable()

    def test_delete_propagates(self):
        write_file(self.left, "a.txt", "doomed")
        write_file(self.right, "a.txt", "doomed")
        self.sync()
        os.unlink(os.path.join(self.right, "a.txt"))
        stats = self.sync()
        self.assertEqual(stats["deleted"], 1)
        self.assertFalse(os.path.exists(os.path.join(self.left, "a.txt")))
        self.assert_converged()
        self.assert_stable()

    def test_subdirectory_files(self):
        write_file(self.left, "sub/dir/a.txt", "nested")
        self.sync()
        self.assertEqual(read_file(self.right, "sub/dir/a.txt"), "nested")
        os.unlink(os.path.join(self.left, "sub/dir/a.txt"))
        self.sync()
        self.assertEqual(tree(self.left), tree(self.right))
        self.assertNotIn("sub/dir/a.txt", tree(self.right))


class TestDeleteVsLateWrite(SyncTestCase):
    def test_late_old_write_does_not_resurrect(self):
        # Acceptance C: delete propagates, then a delayed write of the old
        # content arrives; it must be discarded, not resurrected.
        write_file(self.left, "a.txt", "old")
        write_file(self.right, "a.txt", "old")
        self.sync()
        os.unlink(os.path.join(self.left, "a.txt"))
        self.sync()
        self.assertNotIn("a.txt", tree(self.right))
        # A stale writer re-creates the old content on the right.
        write_file(self.right, "a.txt", "old")
        stats = self.sync()
        self.assertNotIn("a.txt", tree(self.left))
        self.assertNotIn("a.txt", tree(self.right))
        self.assertEqual(stats["copied"], 0)
        self.assert_stable()

    def test_genuinely_new_content_after_delete_is_added(self):
        write_file(self.left, "a.txt", "old")
        write_file(self.right, "a.txt", "old")
        self.sync()
        os.unlink(os.path.join(self.left, "a.txt"))
        self.sync()
        # Different content on the tombstoned path is a real new file.
        write_file(self.right, "a.txt", "recreated with new content")
        self.sync()
        self.assertEqual(read_file(self.left, "a.txt"), "recreated with new content")
        self.assert_converged()
        self.assert_stable()


class TestConflicts(SyncTestCase):
    def test_delete_vs_modify_modify_wins(self):
        # Rule 3: delete vs concurrent modify -> modify wins, .conflict copy.
        write_file(self.left, "a.txt", "v1")
        write_file(self.right, "a.txt", "v1")
        self.sync()
        os.unlink(os.path.join(self.right, "a.txt"))
        write_file(self.left, "a.txt", "v2")
        stats = self.sync()
        self.assertEqual(stats["conflicts"], 1)
        self.assertEqual(read_file(self.left, "a.txt"), "v2")
        self.assertEqual(read_file(self.right, "a.txt"), "v2")
        self.assertEqual(read_file(self.left, "a.txt.conflict"), "v2")
        self.assertEqual(read_file(self.right, "a.txt.conflict"), "v2")
        self.assert_stable()

    def test_both_modified_lexicographically_smaller_wins(self):
        # Rule 4: both sides changed relative to state.
        write_file(self.left, "a.txt", "base")
        write_file(self.right, "a.txt", "base")
        self.sync()
        write_file(self.left, "a.txt", "zzz")
        write_file(self.right, "a.txt", "aaa")
        stats = self.sync()
        self.assertEqual(stats["conflicts"], 1)
        self.assertEqual(read_file(self.left, "a.txt"), "aaa")
        self.assertEqual(read_file(self.right, "a.txt"), "aaa")
        self.assertEqual(read_file(self.left, "a.txt.conflict"), "zzz")
        self.assertEqual(read_file(self.right, "a.txt.conflict"), "zzz")
        self.assert_stable()

    def test_both_sides_new_different_content_conflicts(self):
        write_file(self.left, "a.txt", "b-content")
        write_file(self.right, "a.txt", "a-content")
        stats = self.sync()
        self.assertEqual(stats["conflicts"], 1)
        self.assertEqual(read_file(self.left, "a.txt"), "a-content")
        self.assertEqual(read_file(self.right, "a.txt"), "a-content")
        self.assertEqual(read_file(self.left, "a.txt.conflict"), "b-content")
        self.assert_stable()

    def test_conflict_count_does_not_grow_on_rerun(self):
        # Rule 5: re-running after a conflict must not re-conflict.
        write_file(self.left, "a.txt", "x")
        write_file(self.right, "a.txt", "y")
        first = self.sync()
        self.assertEqual(first["conflicts"], 1)
        for _ in range(3):
            stats = self.sync()
            self.assertEqual(stats["conflicts"], 0)
            self.assertEqual(stats["copied"], 0)
            self.assertEqual(stats["deleted"], 0)
        self.assert_converged()


class TestInterruption(SyncTestCase):
    def test_crash_before_state_write_then_rerun_is_stable(self):
        # Acceptance D: kill after file ops but before the state write.
        write_file(self.left, "a.txt", "one")
        write_file(self.left, "b.txt", "two")
        write_file(self.right, "c.txt", "three")
        with mock.patch.object(
            core, "save_state", side_effect=KeyboardInterrupt("killed")
        ):
            with self.assertRaises(KeyboardInterrupt):
                self.sync()
        self.assertFalse(os.path.exists(self.state))
        self.sync()  # rerun to completion
        self.assert_converged()
        self.assertEqual(read_file(self.left, "c.txt"), "three")
        self.assertEqual(read_file(self.right, "a.txt"), "one")
        self.assert_stable()

    def test_crash_with_conflict_pending_then_rerun_is_stable(self):
        # A conflict is resolved on disk, then the run is killed before the
        # state write; the rerun must not produce a second conflict.
        write_file(self.left, "a.txt", "left-version")
        write_file(self.right, "a.txt", "right-version")
        with mock.patch.object(
            core, "save_state", side_effect=KeyboardInterrupt("killed")
        ):
            with self.assertRaises(KeyboardInterrupt):
                self.sync()
        # The conflict was fully resolved on disk before the kill, so the
        # rerun has nothing to do and must not raise the count again.
        stats = self.sync()
        self.assertEqual(stats, {"copied": 0, "deleted": 0, "conflicts": 0})
        self.assertEqual(read_file(self.left, "a.txt"), "left-version")
        self.assertEqual(read_file(self.left, "a.txt.conflict"), "right-version")
        self.assert_converged()
        self.assert_stable()

    def test_sigkill_mid_sync_then_rerun(self):
        for index in range(400):
            write_file(self.left, f"dir{index % 8}/f{index:03d}.txt",
                       f"payload-{index}" * 50)
        env = dict(os.environ, PYTHONPATH=REPO_ROOT)
        proc = subprocess.Popen(
            [sys.executable, "-m", "safedelsync", "sync",
             self.left, self.right, "--state", self.state],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
        )
        proc.kill()
        proc.communicate()
        # Whatever happened, a fresh run must converge and then be stable.
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_converged()
        again = self.run_cli()
        self.assertEqual(json.loads(again.stdout),
                         {"copied": 0, "deleted": 0, "conflicts": 0})


class TestCli(SyncTestCase):
    def test_cli_outputs_json_stats(self):
        write_file(self.left, "a.txt", "hello")
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        stats = json.loads(result.stdout)
        self.assertEqual(stats, {"copied": 1, "deleted": 0, "conflicts": 0})

    def test_corrupt_state_exits_4(self):
        write_file(self.left, "a.txt", "hello")
        with open(self.state, "w", encoding="utf-8") as handle:
            handle.write("{not valid json")
        result = self.run_cli()
        self.assertEqual(result.returncode, 4)
        self.assertIn("error", result.stderr.lower())
        self.assertEqual(result.stdout, "")

    def test_structurally_invalid_state_exits_4(self):
        with open(self.state, "w", encoding="utf-8") as handle:
            json.dump({"files": {"a.txt": {"hash": 123}}}, handle)
        result = self.run_cli()
        self.assertEqual(result.returncode, 4)

    def test_missing_directory_is_an_error(self):
        os.rmdir(self.right)
        result = self.run_cli()
        self.assertEqual(result.returncode, 1)
        self.assertNotEqual(result.stderr, "")


class TestExhaustiveInterleaving(unittest.TestCase):
    """Acceptance A: enumerate small op sequences (add/del/mod, <= 2 steps
    per side, 6 op kinds) interleaved on both sides with a sync after each
    step; the two replicas must always converge and reruns must be stable."""

    OPS = {
        "add_a1": lambda root: write_file(root, "a.txt", "1"),
        "add_a2": lambda root: write_file(root, "a.txt", "2"),
        "add_b1": lambda root: write_file(root, "b.txt", "1"),
        "mod_a2": lambda root: write_file(root, "a.txt", "2"),
        "del_a": lambda root: _silent_unlink(root, "a.txt"),
        "del_b": lambda root: _silent_unlink(root, "b.txt"),
    }

    def _sequences(self, max_len=2):
        names = sorted(self.OPS)
        seqs = [()]
        for length in range(1, max_len + 1):
            seqs.extend(itertools.product(names, repeat=length))
        return seqs

    def test_interleaved_op_sequences_converge(self):
        sequences = self._sequences()
        failures = []
        for left_seq, right_seq in itertools.product(sequences, repeat=2):
            with tempfile.TemporaryDirectory() as base:
                left = os.path.join(base, "L")
                right = os.path.join(base, "R")
                state = os.path.join(base, "state.json")
                os.makedirs(left)
                os.makedirs(right)
                steps = max(len(left_seq), len(right_seq))
                for step in range(steps):
                    if step < len(left_seq):
                        self.OPS[left_seq[step]](left)
                    if step < len(right_seq):
                        self.OPS[right_seq[step]](right)
                    core.sync(left, right, state)
                core.sync(left, right, state)
                left_tree, right_tree = tree(left), tree(right)
                stats = core.sync(left, right, state)
                stable = (
                    stats == {"copied": 0, "deleted": 0, "conflicts": 0}
                    and tree(left) == left_tree
                    and tree(right) == right_tree
                )
                if left_tree != right_tree or not stable:
                    failures.append((left_seq, right_seq))
        self.assertEqual(failures, [])


def _silent_unlink(root, rel):
    try:
        os.unlink(os.path.join(root, rel))
    except FileNotFoundError:
        pass


if __name__ == "__main__":
    unittest.main()
