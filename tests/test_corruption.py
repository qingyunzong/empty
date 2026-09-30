"""Acceptance D: corrupted parent pointers -> exit code 5, no new snapshot."""

import json
import os

from helpers import RepoTestCase, run_cli, run_ok


class TestCorruption(RepoTestCase):
    def setUp(self):
        super().setUp()
        self.write("f.txt", "v1")
        self.c1 = run_ok(self.repo, self.snap)["committed"]
        self.write("f.txt", "v2")
        self.c2 = run_ok(self.repo, self.snap)["committed"]

    def _rewrite_snapshot(self, snap_id, mutate):
        path = os.path.join(self.snap, "snapshots", snap_id + ".json")
        with open(path) as fh:
            data = json.load(fh)
        mutate(data)
        with open(path, "w") as fh:
            fh.write(data if isinstance(data, str) else json.dumps(data))

    def _assert_exit5_no_write(self, before_snaps, before_head, undo=None):
        proc = run_cli(self.repo, self.snap, undo=undo)
        self.assertEqual(proc.returncode, 5, proc.stderr)
        self.assertNotEqual(proc.stderr, "")
        self.assertEqual(proc.stdout, "")
        self.assertEqual(self.snapshot_ids(), before_snaps)
        self.assertEqual(self.head_id(), before_head)

    def test_garbage_snapshot_file(self):
        path = os.path.join(self.snap, "snapshots", self.c2 + ".json")
        with open(path, "w") as fh:
            fh.write("not valid json {{{")
        before, head = self.snapshot_ids(), self.head_id()
        self._assert_exit5_no_write(before, head)
        self._assert_exit5_no_write(before, head, undo=1)

    def test_cyclic_parent_pointer(self):
        self._rewrite_snapshot(self.c2, lambda d: d.update(parent=self.c2))
        before, head = self.snapshot_ids(), self.head_id()
        self._assert_exit5_no_write(before, head)
        self._assert_exit5_no_write(before, head, undo=1)

    def test_two_node_cycle(self):
        self._rewrite_snapshot(self.c1, lambda d: d.update(parent=self.c2))
        before, head = self.snapshot_ids(), self.head_id()
        self._assert_exit5_no_write(before, head)

    def test_dangling_parent_pointer(self):
        self._rewrite_snapshot(self.c2, lambda d: d.update(parent="0" * 32))
        before, head = self.snapshot_ids(), self.head_id()
        self._assert_exit5_no_write(before, head)

    def test_corrupt_head_file(self):
        with open(os.path.join(self.snap, "HEAD"), "w") as fh:
            fh.write("garbage-not-a-hash")
        before = self.snapshot_ids()
        proc = run_cli(self.repo, self.snap)
        self.assertEqual(proc.returncode, 5)
        self.assertNotEqual(proc.stderr, "")
        self.assertEqual(self.snapshot_ids(), before)
