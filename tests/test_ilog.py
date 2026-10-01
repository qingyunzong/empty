import contextlib
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from ilog import FaultInjected, IlogError, IntervalStore, set_fault_hook

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@contextlib.contextmanager
def fail_at(point):
    """Simulate a crash at the given commit fault point."""

    def hook(name):
        if name == point:
            raise FaultInjected(name)

    set_fault_hook(hook)
    try:
        yield
    finally:
        set_fault_hook(None)


class IlogTestCase(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpdir.cleanup)
        self.path = os.path.join(self.tmpdir.name, "intervals.json")
        self.tmp_path = self.path + ".tmp"
        self.marker_path = self.path + ".commit"

    def read_main(self):
        with open(self.path, "r", encoding="utf-8") as fh:
            return json.load(fh)


class TestBasicOps(IlogTestCase):
    def test_add_merges_overlapping_and_adjacent(self):
        store = IntervalStore(self.path)
        store.add(0, 5)
        store.add(3, 8)
        store.add(8, 10)
        store.add(20, 25)
        self.assertEqual(store.intervals, [(0, 10), (20, 25)])

    def test_remove_splits_and_trims(self):
        store = IntervalStore(self.path)
        store.add(0, 10)
        store.add(20, 30)
        store.remove(3, 5)
        store.remove(25, 40)
        self.assertEqual(store.intervals, [(0, 3), (5, 10), (20, 25)])

    def test_uncommitted_changes_stay_in_memory(self):
        store = IntervalStore(self.path)
        store.add(0, 5)
        store.commit()
        store.add(10, 20)
        store.remove(0, 2)
        # No commit: reopening must see only the committed state.
        reopened = IntervalStore(self.path)
        self.assertEqual(reopened.intervals, [(0, 5)])
        self.assertEqual(reopened.recovered, "clean")

    def test_normal_commit_persists(self):
        store = IntervalStore(self.path)
        store.add(0, 5)
        store.add(5, 10)
        store.commit()
        self.assertEqual(self.read_main()["intervals"], [[0, 10]])
        self.assertFalse(os.path.exists(self.tmp_path))
        self.assertFalse(os.path.exists(self.marker_path))
        reopened = IntervalStore(self.path)
        self.assertEqual(reopened.intervals, [(0, 10)])
        self.assertEqual(reopened.recovered, "clean")

    def test_remove_then_compact_merges_adjacent_boundaries(self):
        store = IntervalStore(self.path)
        store.add(0, 5)
        store.add(5, 10)
        store.add(20, 30)
        store.commit()
        store.remove(10, 20)  # touches both edges, removes nothing inside
        store.compact()
        store.commit()
        self.assertEqual(self.read_main()["intervals"], [[0, 10], [20, 30]])
        reopened = IntervalStore(self.path)
        self.assertEqual(reopened.intervals, [(0, 10), (20, 30)])

    def test_compact_goes_through_commit_flow(self):
        store = IntervalStore(self.path)
        store.add(0, 5)
        store.add(5, 10)
        store.compact()
        # compact alone must not persist
        self.assertFalse(os.path.exists(self.path))
        store.commit()
        self.assertEqual(self.read_main()["intervals"], [[0, 10]])


class TestFaultInjection(IlogTestCase):
    def committed_base(self):
        store = IntervalStore(self.path)
        store.add(0, 5)
        store.commit()
        return store

    def test_crash_after_tmp_write_keeps_old_state(self):
        store = self.committed_base()
        store.add(10, 20)
        with fail_at("after_tmp_write"):
            with self.assertRaises(FaultInjected):
                store.commit()
        reopened = IntervalStore(self.path)
        self.assertEqual(reopened.recovered, "clean")
        self.assertEqual(reopened.intervals, [(0, 5)])
        self.assertFalse(os.path.exists(self.tmp_path))

    def test_crash_after_marker_adopts_new_state(self):
        store = self.committed_base()
        store.add(10, 20)
        with fail_at("after_marker"):
            with self.assertRaises(FaultInjected):
                store.commit()
        self.assertTrue(os.path.exists(self.marker_path))
        reopened = IntervalStore(self.path)
        self.assertEqual(reopened.recovered, "committed")
        self.assertEqual(reopened.intervals, [(0, 5), (10, 20)])
        self.assertFalse(os.path.exists(self.marker_path))
        self.assertFalse(os.path.exists(self.tmp_path))
        # The adopted state is durable now.
        again = IntervalStore(self.path)
        self.assertEqual(again.intervals, [(0, 5), (10, 20)])
        self.assertEqual(again.recovered, "clean")

    def test_crash_after_replace_is_idempotent(self):
        store = self.committed_base()
        store.add(10, 20)
        with fail_at("after_replace"):
            with self.assertRaises(FaultInjected):
                store.commit()
        self.assertTrue(os.path.exists(self.marker_path))
        reopened = IntervalStore(self.path)
        self.assertEqual(reopened.recovered, "clean")
        self.assertEqual(reopened.intervals, [(0, 5), (10, 20)])
        self.assertFalse(os.path.exists(self.marker_path))

    def test_corrupted_tmp_rolls_back(self):
        store = self.committed_base()
        store.add(10, 20)
        with fail_at("after_marker"):
            with self.assertRaises(FaultInjected):
                store.commit()
        # Corrupt the staged tmp file before recovery.
        garbage = b"{not valid json!!!"
        with open(self.tmp_path, "wb") as fh:
            fh.write(garbage)
        with open(self.marker_path, "w", encoding="utf-8") as fh:
            fh.write(hashlib.sha256(garbage).hexdigest())
        reopened = IntervalStore(self.path)
        self.assertEqual(reopened.recovered, "rollback")
        self.assertEqual(reopened.intervals, [(0, 5)])
        self.assertFalse(os.path.exists(self.tmp_path))
        self.assertFalse(os.path.exists(self.marker_path))
        # Main file untouched.
        self.assertEqual(self.read_main()["intervals"], [[0, 5]])

    def test_no_half_committed_intervals(self):
        # A torn tmp file (valid JSON prefix of a larger state) must never
        # partially apply: recovery is all-or-nothing.
        store = self.committed_base()
        store.add(10, 20)
        store.add(30, 40)
        with fail_at("after_marker"):
            with self.assertRaises(FaultInjected):
                store.commit()
        with open(self.tmp_path, "r+", encoding="utf-8") as fh:
            fh.truncate(10)  # tear the staged file
        reopened = IntervalStore(self.path)
        self.assertEqual(reopened.recovered, "rollback")
        self.assertEqual(reopened.intervals, [(0, 5)])


class TestErrors(IlogTestCase):
    def test_bad_interval_rejected(self):
        store = IntervalStore(self.path)
        for lo, hi in [(5, 5), (7, 3), (0, 0)]:
            with self.assertRaises(IlogError) as ctx:
                store.add(lo, hi)
            self.assertEqual(ctx.exception.code, "BAD_INTERVAL")
        with self.assertRaises(IlogError) as ctx:
            store.remove(4, 4)
        self.assertEqual(ctx.exception.code, "BAD_INTERVAL")

    def test_non_json_main_file_raises_io(self):
        with open(self.path, "w", encoding="utf-8") as fh:
            fh.write("this is not json")
        with self.assertRaises(IlogError) as ctx:
            IntervalStore(self.path)
        self.assertEqual(ctx.exception.code, "IO")

    def test_malformed_intervals_in_file_raise_io(self):
        with open(self.path, "w", encoding="utf-8") as fh:
            json.dump({"version": 1, "intervals": [[5, 2]]}, fh)
        with self.assertRaises(IlogError) as ctx:
            IntervalStore(self.path)
        self.assertEqual(ctx.exception.code, "IO")

    def test_permission_failure_raises_io(self):
        store = IntervalStore(self.path)
        store.add(0, 5)
        with mock.patch("os.replace", side_effect=PermissionError("denied")):
            with self.assertRaises(IlogError) as ctx:
                store.commit()
        self.assertEqual(ctx.exception.code, "IO")


class TestCli(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpdir.cleanup)
        self.path = os.path.join(self.tmpdir.name, "intervals.json")

    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, "-m", "ilog.cli", "--file", self.path, *args],
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
        )

    def test_cli_add_compact_commit(self):
        proc = self.run_cli("add", "0", "5", "add", "5", "10", "compact", "commit")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out, {"committed": True, "intervals": [[0, 10]]})
        with open(self.path, "r", encoding="utf-8") as fh:
            self.assertEqual(json.load(fh)["intervals"], [[0, 10]])

    def test_cli_without_commit_persists_nothing(self):
        proc = self.run_cli("add", "0", "5")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertFalse(os.path.exists(self.path))

    def test_cli_remove_and_compact(self):
        self.run_cli("add", "0", "10", "commit")
        proc = self.run_cli("remove", "3", "5", "compact", "commit", "show")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = [json.loads(line) for line in proc.stdout.splitlines()]
        self.assertEqual(lines[-1]["intervals"], [[0, 3], [5, 10]])

    def test_cli_bad_interval_exit_2(self):
        proc = self.run_cli("add", "5", "5", "commit")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("code=BAD_INTERVAL", proc.stderr)

    def test_cli_non_json_file_exit_2(self):
        with open(self.path, "w", encoding="utf-8") as fh:
            fh.write("not json at all")
        proc = self.run_cli("show")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("code=IO", proc.stderr)


if __name__ == "__main__":
    unittest.main()
