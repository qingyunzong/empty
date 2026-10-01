import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from ilog import (  # noqa: E402
    BAD_INTERVAL,
    IO,
    ILogError,
    InjectedFault,
    IntervalStore,
    clear_fault,
    set_fault,
)


class StoreTestCase(unittest.TestCase):
    def setUp(self):
        clear_fault()
        self.tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpdir.cleanup)
        self.path = os.path.join(self.tmpdir.name, "intervals.json")
        self.tmp_path = self.path + ".tmp"
        self.marker_path = self.path + ".commit"

    def tearDown(self):
        clear_fault()

    def reopen(self):
        return IntervalStore(self.path)


class CommitTests(StoreTestCase):
    def test_commit_persists_state(self):
        store = self.reopen()
        store.add(0, 5)
        store.add(10, 20)
        store.commit()
        again = self.reopen()
        self.assertEqual(again.intervals(), [(0, 5), (10, 20)])
        self.assertIsNone(again.recovered)
        self.assertFalse(os.path.exists(self.tmp_path))
        self.assertFalse(os.path.exists(self.marker_path))

    def test_uncommitted_changes_stay_in_memory(self):
        store = self.reopen()
        store.add(0, 10)
        store.commit()
        store.add(20, 30)  # never committed
        self.assertEqual(store.intervals(), [(0, 10), (20, 30)])
        again = self.reopen()
        self.assertEqual(again.intervals(), [(0, 10)])

    def test_add_merges_overlapping(self):
        store = self.reopen()
        store.add(0, 5)
        store.add(3, 8)
        store.add(20, 25)
        store.add(7, 21)
        self.assertEqual(store.intervals(), [(0, 25)])

    def test_remove_splits_and_trims(self):
        store = self.reopen()
        store.add(0, 10)
        store.remove(3, 7)
        self.assertEqual(store.intervals(), [(0, 3), (7, 10)])
        store.remove(-5, 1)
        store.remove(9, 100)
        self.assertEqual(store.intervals(), [(1, 3), (7, 9)])


class FaultInjectionTests(StoreTestCase):
    def committed_base(self):
        store = self.reopen()
        store.add(0, 10)
        store.commit()
        return store

    def test_fault_after_tmp_write_keeps_old_state(self):
        store = self.committed_base()
        store.add(100, 200)
        set_fault("after_tmp_write")
        with self.assertRaises(InjectedFault) as ctx:
            store.commit()
        self.assertEqual(ctx.exception.point, "after_tmp_write")
        # Crash left a tmp file but no marker: main file stays authoritative.
        self.assertTrue(os.path.exists(self.tmp_path))
        self.assertFalse(os.path.exists(self.marker_path))
        again = self.reopen()
        self.assertEqual(again.intervals(), [(0, 10)])
        self.assertIsNone(again.recovered)
        self.assertFalse(os.path.exists(self.tmp_path))  # stale tmp cleaned up

    def test_fault_after_marker_write_adopts_new_state(self):
        store = self.committed_base()
        store.add(100, 200)
        set_fault("after_marker_write")
        with self.assertRaises(InjectedFault):
            store.commit()
        # Marker + intact tmp: recovery completes the interrupted commit.
        self.assertTrue(os.path.exists(self.marker_path))
        self.assertTrue(os.path.exists(self.tmp_path))
        again = self.reopen()
        self.assertEqual(again.recovered, "committed")
        self.assertEqual(again.intervals(), [(0, 10), (100, 200)])
        self.assertFalse(os.path.exists(self.marker_path))
        # The adopted state is now durable.
        third = self.reopen()
        self.assertEqual(third.intervals(), [(0, 10), (100, 200)])
        self.assertIsNone(third.recovered)

    def test_fault_after_replace_adopts_new_state(self):
        store = self.committed_base()
        store.add(100, 200)
        set_fault("after_replace")
        with self.assertRaises(InjectedFault):
            store.commit()
        # Replace already happened; only the marker cleanup was lost.
        self.assertTrue(os.path.exists(self.marker_path))
        self.assertFalse(os.path.exists(self.tmp_path))
        again = self.reopen()
        self.assertEqual(again.recovered, "committed")
        self.assertEqual(again.intervals(), [(0, 10), (100, 200)])
        self.assertFalse(os.path.exists(self.marker_path))

    def test_corrupt_tmp_with_marker_rolls_back(self):
        store = self.committed_base()
        store.add(100, 200)
        set_fault("after_marker_write")
        with self.assertRaises(InjectedFault):
            store.commit()
        # The tmp file is damaged after the crash (e.g. torn sector).
        with open(self.tmp_path, "wb") as fh:
            fh.write(b"{not json")
        again = self.reopen()
        self.assertEqual(again.recovered, "rollback")
        self.assertEqual(again.intervals(), [(0, 10)])
        self.assertFalse(os.path.exists(self.tmp_path))
        self.assertFalse(os.path.exists(self.marker_path))

    def test_tmp_digest_mismatch_rolls_back(self):
        store = self.committed_base()
        store.add(100, 200)
        set_fault("after_marker_write")
        with self.assertRaises(InjectedFault):
            store.commit()
        # Valid JSON but not the state the marker vouches for.
        with open(self.tmp_path, "w", encoding="utf-8") as fh:
            json.dump({"version": 1, "intervals": [[1, 2]]}, fh)
        again = self.reopen()
        self.assertEqual(again.recovered, "rollback")
        self.assertEqual(again.intervals(), [(0, 10)])


class CompactTests(StoreTestCase):
    def test_remove_then_compact_merges_adjacent_boundaries(self):
        store = self.reopen()
        store.add(0, 10)
        store.commit()
        store.remove(3, 7)
        store.commit()
        self.assertEqual(store.intervals(), [(0, 3), (7, 10)])
        store.add(3, 7)  # touches both neighbours without overlapping
        store.commit()
        again = self.reopen()
        self.assertEqual(again.intervals(), [(0, 3), (3, 7), (7, 10)])
        again.compact()
        self.assertEqual(again.intervals(), [(0, 10)])
        third = self.reopen()
        self.assertEqual(third.intervals(), [(0, 10)])

    def test_compact_uses_the_commit_flow(self):
        store = self.reopen()
        store.add(0, 3)
        store.add(3, 6)
        store.commit()
        set_fault("after_marker_write")
        with self.assertRaises(InjectedFault):
            store.compact()
        # compact staged its result through tmp+marker like any commit.
        again = self.reopen()
        self.assertEqual(again.recovered, "committed")
        self.assertEqual(again.intervals(), [(0, 6)])


class ErrorTests(StoreTestCase):
    def test_corrupt_main_file_raises_io(self):
        with open(self.path, "wb") as fh:
            fh.write(b"this is not json")
        with self.assertRaises(ILogError) as ctx:
            self.reopen()
        self.assertEqual(ctx.exception.code, IO)

    def test_bad_intervals_rejected(self):
        store = self.reopen()
        for lo, hi in [(5, 5), (10, 3), (0, 0)]:
            with self.assertRaises(ILogError) as ctx:
                store.add(lo, hi)
            self.assertEqual(ctx.exception.code, BAD_INTERVAL)
            with self.assertRaises(ILogError) as ctx:
                store.remove(lo, hi)
            self.assertEqual(ctx.exception.code, BAD_INTERVAL)
        for lo, hi in [("a", 5), (0, None), (True, 5), (0, float("inf"))]:
            with self.assertRaises(ILogError) as ctx:
                store.add(lo, hi)
            self.assertEqual(ctx.exception.code, BAD_INTERVAL)

    def test_permission_failure_raises_io(self):
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            self.skipTest("root bypasses file permission checks")
        store = self.reopen()
        store.add(0, 10)
        store.commit()
        os.chmod(self.tmpdir.name, 0o555)
        self.addCleanup(os.chmod, self.tmpdir.name, 0o755)
        store.add(1, 2)
        with self.assertRaises(ILogError) as ctx:
            store.commit()
        self.assertEqual(ctx.exception.code, IO)


class CliTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpdir.cleanup)
        self.path = os.path.join(self.tmpdir.name, "cli.json")

    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, "-m", "ilog.cli", "-f", self.path, *args],
            cwd=REPO_ROOT, capture_output=True, text=True,
        )

    def test_add_compact_list_across_processes(self):
        result = self.run_cli("add", "0", "5")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["intervals"], [[0, 5]])
        result = self.run_cli("add", "5", "8")
        self.assertEqual(json.loads(result.stdout)["intervals"], [[0, 5], [5, 8]])
        result = self.run_cli("compact")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["intervals"], [[0, 8]])
        result = self.run_cli("list")
        self.assertEqual(json.loads(result.stdout)["intervals"], [[0, 8]])

    def test_remove_via_cli(self):
        self.run_cli("add", "0", "10")
        result = self.run_cli("remove", "3", "7")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["intervals"], [[0, 3], [7, 10]])

    def test_bad_interval_exits_2(self):
        result = self.run_cli("add", "5", "5")
        self.assertEqual(result.returncode, 2)
        self.assertIn(BAD_INTERVAL, result.stderr)
        result = self.run_cli("add", "x", "5")
        self.assertEqual(result.returncode, 2)
        self.assertIn(BAD_INTERVAL, result.stderr)

    def test_non_json_file_exits_2(self):
        with open(self.path, "wb") as fh:
            fh.write(b"not json at all")
        result = self.run_cli("list")
        self.assertEqual(result.returncode, 2)
        self.assertIn(IO, result.stderr)

    def test_cli_reports_rollback_recovery(self):
        # Craft an interrupted commit: valid main, corrupt tmp, marker present.
        store = IntervalStore(self.path)
        store.add(0, 10)
        store.commit()
        store.add(50, 60)
        set_fault("after_marker_write")
        with self.assertRaises(InjectedFault):
            store.commit()
        clear_fault()
        with open(self.path + ".tmp", "wb") as fh:
            fh.write(b"garbage")
        result = self.run_cli("list")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["recovered"], "rollback")
        self.assertEqual(payload["intervals"], [[0, 10]])


if __name__ == "__main__":
    unittest.main()
