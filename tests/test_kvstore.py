import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

sys.path.insert(0, REPO_ROOT)

from kvstore import FaultInjector, Store, TxnError, recover  # noqa: E402


def run_cli(script, faults=None, replay=False, log_name="store.log"):
    """Run the CLI in a fresh temp dir; return (exit_code, stdout_lines, log_path, tmpdir)."""
    tmpdir = tempfile.mkdtemp()
    script_path = os.path.join(tmpdir, "script.json")
    with open(script_path, "w", encoding="utf-8") as fh:
        json.dump({"steps": script}, fh)
    log_path = os.path.join(tmpdir, log_name)
    cmd = [sys.executable, "-m", "kvstore", "run", script_path, "--log", log_path]
    if faults is not None:
        faults_path = os.path.join(tmpdir, "faults.json")
        with open(faults_path, "w", encoding="utf-8") as fh:
            json.dump(faults, fh)
        cmd += ["--inject", faults_path]
    if replay:
        cmd += ["--replay"]
    proc = subprocess.run(cmd, cwd=REPO_ROOT, capture_output=True, text=True)
    lines = [json.loads(l) for l in proc.stdout.splitlines() if l.strip()]
    return proc.returncode, lines, log_path, tmpdir, proc.stderr


class TestNestedRollback(unittest.TestCase):
    """Acceptance A: 3-level nesting, rollback of the middle level."""

    STEPS = [
        {"op": "begin"},                    # 0  T1
        {"op": "put", "key": "a", "value": 1},
        {"op": "begin"},                    # 2  T2
        {"op": "put", "key": "b", "value": 2},
        {"op": "put", "key": "a", "value": 20},
        {"op": "begin"},                    # 5  T3
        {"op": "put", "key": "c", "value": 3},
        {"op": "commit"},                   # 7  T3 merges into T2
        {"op": "rollback"},                 # 8  T2 (incl. merged T3) discarded
        {"op": "put", "key": "d", "value": 4},
        {"op": "commit"},                   # 10 T1 durable
    ]

    def test_views_match_manual_reference(self):
        code, lines, log_path, _, _ = run_cli(self.STEPS, replay=True)
        self.assertEqual(code, 0, lines)
        self.assertTrue(all(l["ok"] for l in lines if "step" in l))
        # Manual reference views at key steps.
        by_step = {l["step"]: l["view"] for l in lines if "step" in l}
        self.assertEqual(by_step[7], {"a": 20, "b": 2, "c": 3})
        # Middle rollback undoes only its own level (incl. merged T3 writes).
        self.assertEqual(by_step[8], {"a": 1})
        self.assertEqual(by_step[10], {"a": 1, "d": 4})
        # Replay after clean run agrees with the committed reference.
        replay = [l for l in lines if l.get("event") == "replay"][0]
        self.assertEqual(replay["view"], {"a": 1, "d": 4})
        self.assertFalse(replay["corrupt_tail_truncated"])

    def test_fourth_level_rejected(self):
        code, lines, *_ = run_cli([
            {"op": "begin"}, {"op": "begin"}, {"op": "begin"}, {"op": "begin"},
        ])
        self.assertEqual(code, 3)
        self.assertEqual(lines[3]["ok"], False)
        self.assertEqual(lines[3]["error"], "E_TXN")

    def test_inner_commit_visible_to_outer_rollback_scope(self):
        # Inner rollback only undoes its own level; outer committed data stays.
        code, lines, *_ = run_cli([
            {"op": "begin"},
            {"op": "put", "key": "x", "value": 1},
            {"op": "commit"},               # durable: x=1
            {"op": "begin"},
            {"op": "begin"},
            {"op": "put", "key": "x", "value": 99},
            {"op": "rollback"},             # inner rollback: only this level
            {"op": "commit"},               # outer (empty) commit
        ], replay=True)
        self.assertEqual(code, 0, lines)
        replay = [l for l in lines if l.get("event") == "replay"][0]
        self.assertEqual(replay["view"], {"x": 1})


class TestFsyncFail(unittest.TestCase):
    """Acceptance B: fsync_fail aborts the whole txn; old value survives."""

    STEPS = [
        {"op": "begin"},
        {"op": "put", "key": "k", "value": "old"},
        {"op": "commit"},                   # 2: durable k=old
        {"op": "begin"},
        {"op": "put", "key": "k", "value": "new"},
        {"op": "put", "key": "extra", "value": 1},
        {"op": "commit"},                   # 6: fsync_fail injected here
    ]

    def test_old_value_remains_and_no_partial_visibility(self):
        code, lines, log_path, _, _ = run_cli(
            self.STEPS, faults={"fsync_fail": 6}, replay=True)
        self.assertEqual(code, 3)
        failed = [l for l in lines if l.get("step") == 6][0]
        self.assertEqual(failed["ok"], False)
        self.assertEqual(failed["error"], "E_IO")
        # In-session view after abort: old value, no partial new writes.
        self.assertEqual(failed["view"], {"k": "old"})
        # After replay: nothing of the aborted txn is visible.
        replay = [l for l in lines if l.get("event") == "replay"][0]
        self.assertEqual(replay["view"], {"k": "old"})

    def test_fsync_fail_fires_only_once(self):
        steps = self.STEPS + [
            {"op": "begin"},
            {"op": "put", "key": "k", "value": "new2"},
            {"op": "commit"},               # 9: fault already spent
        ]
        code, lines, *_ = run_cli(steps, faults={"fsync_fail": 6}, replay=True)
        self.assertEqual(code, 3)
        by_step = {l["step"]: l for l in lines if "step" in l}
        self.assertEqual(by_step[6]["ok"], False)
        self.assertEqual(by_step[9]["ok"], True)
        replay = [l for l in lines if l.get("event") == "replay"][0]
        self.assertEqual(replay["view"], {"k": "new2"})


class TestCrashAfterCommit(unittest.TestCase):
    """Acceptance C: crash_after_commit, replay shows all keys of the txn."""

    def test_replay_shows_committed_keys(self):
        steps = [
            {"op": "begin"},
            {"op": "put", "key": "k1", "value": "v1"},
            {"op": "put", "key": "k2", "value": "v2"},
            {"op": "del", "key": "k1"},
            {"op": "put", "key": "k3", "value": 3},
            {"op": "commit"},               # 5: crash after this commit
            {"op": "begin"},                # never executed
            {"op": "put", "key": "lost", "value": 1},
            {"op": "commit"},
        ]
        code, lines, log_path, _, _ = run_cli(
            steps, faults={"crash_after_commit": 5}, replay=True)
        self.assertEqual(code, 3)
        crash = [l for l in lines if l.get("event") == "crash"]
        self.assertEqual(len(crash), 1)
        self.assertEqual(crash[0]["step"], 5)
        replay = [l for l in lines if l.get("event") == "replay"][0]
        self.assertEqual(replay["view"], {"k2": "v2", "k3": 3})


class TestCorruptTail(unittest.TestCase):
    """Acceptance D: half-written tail record is truncated; committed data kept."""

    def test_half_written_tail_truncated(self):
        steps = [
            {"op": "begin"},
            {"op": "put", "key": "a", "value": 1},
            {"op": "commit"},
            {"op": "begin"},
            {"op": "put", "key": "b", "value": 2},
            {"op": "commit"},
        ]
        code, lines, log_path, _, _ = run_cli(steps)
        self.assertEqual(code, 0, lines)
        good_size = os.path.getsize(log_path)
        # Simulate a half-written record (torn write) at the tail.
        with open(log_path, "ab") as fh:
            fh.write(b'{"op": "put", "txn": 9, "ke')
        self.assertGreater(os.path.getsize(log_path), good_size)
        view, truncated = recover(log_path)
        self.assertTrue(truncated)
        # Reference enumeration: exactly the two committed puts.
        self.assertEqual(view, {"a": 1, "b": 2})
        # File truncated back to the valid prefix.
        self.assertEqual(os.path.getsize(log_path), good_size)

    def test_cli_replay_reports_truncation(self):
        steps = [
            {"op": "begin"},
            {"op": "put", "key": "a", "value": 1},
            {"op": "commit"},
        ]
        code, lines, log_path, tmpdir, _ = run_cli(steps)
        self.assertEqual(code, 0, lines)
        with open(log_path, "ab") as fh:
            fh.write(b'{"op": "begin", "txn": 2}\n{"op": "put", "txn": 2, "key": "z"')
        script_path = os.path.join(tmpdir, "empty.json")
        with open(script_path, "w", encoding="utf-8") as fh:
            json.dump({"steps": []}, fh)
        proc = subprocess.run(
            [sys.executable, "-m", "kvstore", "run", script_path,
             "--log", log_path, "--replay"],
            cwd=REPO_ROOT, capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = [json.loads(l) for l in proc.stdout.splitlines() if l.strip()]
        replay = [l for l in out if l.get("event") == "replay"][0]
        self.assertTrue(replay["corrupt_tail_truncated"])
        self.assertEqual(replay["view"], {"a": 1})
        self.assertIn("E_CORRUPT", proc.stderr)


class TestFaultPoints(unittest.TestCase):
    def test_append_before_fails_operation_and_is_one_shot(self):
        steps = [
            {"op": "begin"},
            {"op": "put", "key": "a", "value": 1},   # 1: append_before fires
            {"op": "put", "key": "b", "value": 2},   # 2: fault spent, succeeds
            {"op": "commit"},
        ]
        code, lines, *_ = run_cli(steps, faults={"append_before": 1}, replay=True)
        self.assertEqual(code, 3)
        by_step = {l["step"]: l for l in lines if "step" in l}
        self.assertEqual(by_step[1]["error"], "E_IO")
        self.assertEqual(by_step[1]["view"], {})
        self.assertEqual(by_step[2]["ok"], True)
        replay = [l for l in lines if l.get("event") == "replay"][0]
        self.assertEqual(replay["view"], {"b": 2})

    def test_append_after_writes_record_but_reports_error(self):
        steps = [
            {"op": "begin"},
            {"op": "put", "key": "a", "value": 1},   # 1: append_after fires
            {"op": "commit"},
        ]
        code, lines, *_ = run_cli(steps, faults={"append_after": 1}, replay=True)
        self.assertEqual(code, 3)
        by_step = {l["step"]: l for l in lines if "step" in l}
        self.assertEqual(by_step[1]["error"], "E_IO")
        # Record was appended before the fault: visible in-session and on replay.
        self.assertEqual(by_step[1]["view"], {"a": 1})
        replay = [l for l in lines if l.get("event") == "replay"][0]
        self.assertEqual(replay["view"], {"a": 1})


class TestTxnErrors(unittest.TestCase):
    def test_commit_without_txn_exits_3(self):
        code, lines, *_ = run_cli([{"op": "commit"}])
        self.assertEqual(code, 3)
        self.assertEqual(lines[0]["error"], "E_TXN")

    def test_put_outside_txn(self):
        code, lines, *_ = run_cli([{"op": "put", "key": "a", "value": 1}])
        self.assertEqual(code, 3)
        self.assertEqual(lines[0]["error"], "E_TXN")

    def test_rollback_without_txn(self):
        code, lines, *_ = run_cli([{"op": "rollback"}])
        self.assertEqual(code, 3)
        self.assertEqual(lines[0]["error"], "E_TXN")


class TestStoreApi(unittest.TestCase):
    def test_delete_semantics(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "s.log")
            with Store(log) as store:
                store.begin()
                store.put("a", 1)
                store.commit()
                store.begin()
                store.delete("a")
                self.assertEqual(store.view(), {})
                store.rollback()
                self.assertEqual(store.view(), {"a": 1})
            view, truncated = recover(log)
            self.assertEqual(view, {"a": 1})
            self.assertFalse(truncated)

    def test_nesting_limit_api(self):
        with tempfile.TemporaryDirectory() as tmp:
            with Store(os.path.join(tmp, "s.log")) as store:
                store.begin()
                store.begin()
                store.begin()
                with self.assertRaises(TxnError):
                    store.begin()

    def test_injector_rejects_unknown_fault(self):
        with self.assertRaises(ValueError):
            FaultInjector({"not_a_fault": 0})


if __name__ == "__main__":
    unittest.main()
