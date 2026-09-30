"""Basic commit/undo semantics, JSON output, empty-dir rule, total order."""

import os

from helpers import RepoTestCase, run_cli, run_ok


class TestBasicCommit(RepoTestCase):
    def test_commit_output_and_store(self):
        self.write("f.txt", "hello")
        out = run_ok(self.repo, self.snap)
        self.assertEqual(out["undone"], [])
        self.assertEqual(out["skipped"], [])
        self.assertIn(out["committed"] + ".json", self.snapshot_ids())
        self.assertEqual(self.head_id(), out["committed"])
        snap = self.read_snapshot(out["committed"])
        self.assertIsNone(snap["parent"])
        self.assertIn("f.txt", snap["manifest"])

    def test_undo_restores_previous_state(self):
        self.write("f.txt", "v1")
        run_ok(self.repo, self.snap)
        self.write("f.txt", "v2")
        run_ok(self.repo, self.snap)
        out = run_ok(self.repo, self.snap, undo=1)
        self.assertEqual(len(out["undone"]), 1)
        self.assertEqual(self.read("f.txt"), b"v1")

    def test_undo_more_than_history_empties_tree(self):
        self.write("d/f.txt", "x")
        run_ok(self.repo, self.snap)
        self.write("g.txt", "y")
        run_ok(self.repo, self.snap)
        out = run_ok(self.repo, self.snap, undo=99)
        self.assertEqual(len(out["undone"]), 2)
        self.assertEqual(os.listdir(self.repo), [".hs"])

    def test_undo_zero_is_plain_commit(self):
        self.write("f.txt", "a")
        run_ok(self.repo, self.snap)
        self.write("f.txt", "b")
        out = run_ok(self.repo, self.snap, undo=0)
        self.assertEqual(out["undone"], [])
        self.assertEqual(self.read("f.txt"), b"b")

    def test_root_outside_repo_rejected(self):
        proc = run_cli(self.tmp, self.snap)
        self.assertEqual(proc.returncode, 2)
        self.assertNotEqual(proc.stderr, "")


class TestEmptyDirRule(RepoTestCase):
    def test_empty_dir_created_by_undone_commit_is_deleted(self):
        self.write("base.txt", "base")
        run_ok(self.repo, self.snap)
        self.write("d/f.txt", "x")  # creates dir d and file d/f.txt
        run_ok(self.repo, self.snap)
        run_ok(self.repo, self.snap, undo=1)
        self.assertFalse(os.path.exists(os.path.join(self.repo, "d")))

    def test_empty_dir_not_created_by_undone_commit_is_kept(self):
        self.mkdir("d")  # empty dir committed before the undone commit
        run_ok(self.repo, self.snap)
        self.write("d/f.txt", "x")
        run_ok(self.repo, self.snap)
        run_ok(self.repo, self.snap, undo=1)
        self.assertTrue(os.path.isdir(os.path.join(self.repo, "d")))
        self.assertEqual(os.listdir(os.path.join(self.repo, "d")), [])


class TestTotalOrder(RepoTestCase):
    def test_commits_totally_ordered_by_timestamp_and_seq(self):
        self.write("f.txt", "1")
        c1 = run_ok(self.repo, self.snap)["committed"]
        self.write("f.txt", "2")
        c2 = run_ok(self.repo, self.snap)["committed"]
        s1, s2 = self.read_snapshot(c1), self.read_snapshot(c2)
        self.assertNotEqual(c1, c2)
        self.assertLess((s1["time_ns"], s1["seq"]), (s2["time_ns"], s2["seq"]))
        self.assertEqual(s2["parent"], c1)
        self.assertIsNone(s1["parent"])
