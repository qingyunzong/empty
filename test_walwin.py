"""End-to-end tests for walwin: fault injection, recovery, idempotency."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

import walwin

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
WIN = 60000

# seq, key, ts, delta
RECORDS = [
    {"seq": 1, "key": "a", "ts": 1000, "delta": 5},
    {"seq": 2, "key": "a", "ts": 20000, "delta": 7},
    {"seq": 3, "key": "b", "ts": 30000, "delta": 1},
    {"seq": 4, "key": "a", "ts": 70000, "delta": 2},
    {"seq": 5, "key": "b", "ts": 95000, "delta": 4},
]

# win=60000: a -> end 70000, ts in (10000, 70000]: 7 + 2 = 9
#            b -> end 95000, ts in (35000, 95000]: 4
EXPECTED_OUTPUT = (
    '{"key": "a", "sum": 9, "window_end": 70000}\n'
    '{"key": "b", "sum": 4, "window_end": 95000}\n'
)


def run_cli(input_path, state_dir, win=WIN, fault=None):
    env = dict(os.environ)
    if fault is not None:
        env[walwin.FAULT_ENV] = fault
    else:
        env.pop(walwin.FAULT_ENV, None)
    return subprocess.run(
        [sys.executable, "-m", "walwin",
         "--in", str(input_path), "--dir", str(state_dir), "--win", str(win)],
        capture_output=True, text=True, env=env, cwd=REPO_ROOT,
    )


class WalwinTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="walwin-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def write_input(self, records, name="e.jsonl"):
        path = os.path.join(self.tmp, name)
        with open(path, "w", encoding="utf-8") as fh:
            for rec in records:
                fh.write(json.dumps(rec) + "\n")
        return path

    def state_dir(self, name="state"):
        return os.path.join(self.tmp, name)

    def read_snapshot(self, state_dir):
        with open(os.path.join(state_dir, walwin.SNAPSHOT_NAME),
                  encoding="utf-8") as fh:
            return json.load(fh)


class TestWindowMath(WalwinTestBase):
    def test_final_window_sums(self):
        inp = self.write_input(RECORDS)
        proc = run_cli(inp, self.state_dir())
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, EXPECTED_OUTPUT)


class TestFaultInjection(WalwinTestBase):
    """Acceptance 1: each fault point P1..P4 injected, then resumed, must
    match the no-fault reference run exactly (output and snapshot)."""

    def test_fault_points_match_reference(self):
        inp = self.write_input(RECORDS)

        ref_dir = self.state_dir("ref")
        ref = run_cli(inp, ref_dir)
        self.assertEqual(ref.returncode, 0, ref.stderr)
        self.assertEqual(ref.stdout, EXPECTED_OUTPUT)
        ref_snapshot = self.read_snapshot(ref_dir)

        for point in ("P1", "P2", "P3", "P4"):
            with self.subTest(fault=point):
                state_dir = self.state_dir(f"fault-{point}")
                crashed = run_cli(inp, state_dir, fault=point)
                self.assertNotEqual(crashed.returncode, 0,
                                    f"{point} should crash the process")

                resumed = run_cli(inp, state_dir)
                self.assertEqual(resumed.returncode, 0, resumed.stderr)
                self.assertEqual(resumed.stdout, ref.stdout,
                                 f"{point}: output diverged from reference")
                self.assertEqual(self.read_snapshot(state_dir), ref_snapshot,
                                 f"{point}: snapshot diverged from reference")

    def test_p1_p2_leave_record_unapplied(self):
        # P1/P2: the in-flight record is equivalent to never having happened.
        inp = self.write_input(RECORDS)
        for point in ("P1", "P2"):
            with self.subTest(fault=point):
                state_dir = self.state_dir(f"partial-{point}")
                run_cli(inp, state_dir, fault=point)
                state = walwin.recover(state_dir)
                self.assertEqual(state.committed, set(),
                                 f"{point}: no record may be committed")

    def test_p3_leaves_wal_but_recovers_without_double_count(self):
        inp = self.write_input(RECORDS)
        state_dir = self.state_dir("p3")
        run_cli(inp, state_dir, fault="P3")
        # Snapshot renamed, WAL not yet deleted.
        self.assertTrue(os.path.exists(
            os.path.join(state_dir, walwin.SNAPSHOT_NAME)))
        self.assertTrue(os.path.exists(
            os.path.join(state_dir, walwin.WAL_NAME)))
        # Recovery must not double-apply the stale WAL.
        state = walwin.recover(state_dir)
        self.assertEqual(state.window_sums(WIN),
                         {"a": {"window_end": 70000, "sum": 9},
                          "b": {"window_end": 95000, "sum": 4}})


class TestCrcBadTail(WalwinTestBase):
    """Acceptance 2: CRC-corrupt WAL tail is truncated; valid committed
    prefix is still applied."""

    def test_crc_bad_tail_truncated(self):
        state_dir = self.state_dir()
        os.makedirs(state_dir)
        wal_path = os.path.join(state_dir, walwin.WAL_NAME)
        good = [
            walwin.encode_data(RECORDS[0]),
            walwin.encode_commit(1),
            walwin.encode_data(RECORDS[1]),
            walwin.encode_commit(2),
        ]
        bad_commit = walwin.encode_commit(3)[:-2] + "XX"  # corrupt CRC
        lines = good + [
            walwin.encode_data(RECORDS[2]),  # data without commit: pending
            bad_commit,
            "this is not json at all",
        ]
        with open(wal_path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")

        inp = self.write_input([], name="empty.jsonl")
        proc = run_cli(inp, state_dir)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        # Only seq 1 and 2 were committed before the corruption.
        self.assertEqual(proc.stdout,
                         '{"key": "a", "sum": 12, "window_end": 20000}\n')
        # Snapshot reflects exactly the committed prefix.
        snapshot = self.read_snapshot(state_dir)
        self.assertEqual(snapshot["committed_seqs"], [1, 2])
        self.assertEqual(snapshot["committed_upto"], 2)
        self.assertEqual(snapshot["events"], {"a": [[1000, 5], [20000, 7]]})

    def test_recovery_truncates_corrupt_tail_on_disk(self):
        state_dir = self.state_dir()
        os.makedirs(state_dir)
        wal_path = os.path.join(state_dir, walwin.WAL_NAME)
        valid = walwin.encode_data(RECORDS[0]) + "\n" \
            + walwin.encode_commit(1) + "\n"
        with open(wal_path, "w", encoding="utf-8") as fh:
            fh.write(valid)
            fh.write('{"type": "commit", "seq": 9, "crc": "deadbeef"}\n')
        walwin.recover(state_dir)
        with open(wal_path, "r", encoding="utf-8") as fh:
            self.assertEqual(fh.read(), valid)


class TestDuplicateSeq(WalwinTestBase):
    """Acceptance 3: duplicate seqs (even out of order, even with a
    different payload) are applied at most once."""

    def test_duplicate_seqs_skipped(self):
        records = [
            {"seq": 1, "key": "a", "ts": 1000, "delta": 5},
            {"seq": 2, "key": "a", "ts": 20000, "delta": 7},
            {"seq": 1, "key": "a", "ts": 1000, "delta": 5},      # exact dup
            {"seq": 3, "key": "b", "ts": 30000, "delta": 1},
            {"seq": 2, "key": "a", "ts": 99999, "delta": 999},   # conflicting dup
        ]
        inp = self.write_input(records)
        proc = run_cli(inp, self.state_dir())
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout,
                         '{"key": "a", "sum": 12, "window_end": 20000}\n'
                         '{"key": "b", "sum": 1, "window_end": 30000}\n')

    def test_duplicate_seq_across_runs(self):
        inp = self.write_input(RECORDS)
        state_dir = self.state_dir()
        first = run_cli(inp, state_dir)
        self.assertEqual(first.returncode, 0, first.stderr)
        second = run_cli(inp, state_dir)  # full replay of the same input
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(second.stdout, first.stdout)


class TestColdStart(WalwinTestBase):
    """Acceptance 4: cold start on an empty/nonexistent state directory."""

    def test_empty_dir_cold_start(self):
        inp = self.write_input(RECORDS)
        state_dir = self.state_dir()  # does not exist yet
        proc = run_cli(inp, state_dir)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, EXPECTED_OUTPUT)
        self.assertTrue(os.path.exists(
            os.path.join(state_dir, walwin.SNAPSHOT_NAME)))
        # WAL is cleared after a successful snapshot.
        self.assertFalse(os.path.exists(
            os.path.join(state_dir, walwin.WAL_NAME)))

    def test_empty_input_cold_start(self):
        inp = self.write_input([], name="empty.jsonl")
        proc = run_cli(inp, self.state_dir())
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, "")


class TestErrorsAndPending(WalwinTestBase):
    def test_unwritable_state_dir_exits_3(self):
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            self.skipTest("root bypasses file permission checks")
        state_dir = self.state_dir()
        os.makedirs(state_dir)
        os.chmod(state_dir, 0o555)
        self.addCleanup(os.chmod, state_dir, 0o755)
        inp = self.write_input(RECORDS)
        proc = run_cli(inp, state_dir)
        self.assertEqual(proc.returncode, 3)
        self.assertIn("not writable", proc.stderr)

    def test_pending_record_is_not_an_error(self):
        # An uncommitted (pending) WAL record must not be reported as
        # unsatisfiable; it is simply ignored.
        state_dir = self.state_dir()
        os.makedirs(state_dir)
        wal_path = os.path.join(state_dir, walwin.WAL_NAME)
        with open(wal_path, "w", encoding="utf-8") as fh:
            fh.write(walwin.encode_data(RECORDS[0]) + "\n")  # no commit
        inp = self.write_input([], name="empty.jsonl")
        proc = run_cli(inp, state_dir)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, "")


if __name__ == "__main__":
    unittest.main()
