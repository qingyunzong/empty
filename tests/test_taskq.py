"""Acceptance tests for taskq (run: python -m unittest discover -s tests -v)."""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(*argv, cwd=REPO):
    return subprocess.run(
        [sys.executable, "-m", "taskq", *argv],
        cwd=cwd, capture_output=True, text=True)


def enq(tid, **kw):
    return {"op": "enqueue", "task": tid, **kw}


def run(tid, **kw):
    return {"op": "run", "task": tid, **kw}


def crash(stage):
    return {"op": "crash", "stage": stage}


def reference(actions):
    """Independent file-state-machine reference: applies actions to a pure
    python state. A crash (any stage) stops execution; after recovery the db
    equals the state at the last commit, which is the state after all actions
    before the crash (every action commits immediately)."""
    pending, done = [], []
    for a in actions:
        if a["op"] == "enqueue":
            assert a["task"] not in pending + done
            pending.append(a["task"])
        elif a["op"] == "run":
            assert a["task"] in pending
            pending.remove(a["task"])
            done.append(a["task"])
        elif a["op"] == "crash":
            break
    return pending, done


class TaskqCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = os.path.join(self.tmp.name, "queue.json")
        self.out = os.path.join(self.tmp.name, "done.json")
        self.script = os.path.join(self.tmp.name, "script.json")

    def write_script(self, actions):
        with open(self.script, "w", encoding="utf-8") as fh:
            json.dump({"actions": actions}, fh)

    def write_db(self, state):
        with open(self.db, "w", encoding="utf-8") as fh:
            json.dump(state, fh)

    def read_db(self):
        if not os.path.exists(self.db):
            return {"pending": [], "done": []}
        with open(self.db, encoding="utf-8") as fh:
            return json.load(fh)

    def db_bytes(self):
        with open(self.db, "rb") as fh:
            return fh.read()

    def run_script(self, actions):
        self.write_script(actions)
        return run_cli("run", self.script, "--db", self.db, "--out", self.out)

    def recover(self):
        return run_cli("recover", "--db", self.db)

    def assert_recovered_state(self, pending_ids, done_ids):
        proc = self.recover()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        report = json.loads(proc.stdout)
        self.assertEqual([t["id"] for t in report["pending"]], list(pending_ids))
        self.assertEqual([t["id"] for t in report["done"]], list(done_ids))
        state = self.read_db()
        self.assertEqual([t["id"] for t in state["pending"]], list(pending_ids))
        self.assertEqual([t["id"] for t in state["done"]], list(done_ids))
        # invariant: nothing both done and pending
        self.assertFalse(set(pending_ids) & set(done_ids))
        return report


class TestCrashRecovery(TaskqCase):
    def test_a_crash_after_tmp_before_rename_no_duplicates(self):
        proc = self.run_script([enq("t1"), crash("after_tmp_before_rename")])
        self.assertEqual(proc.returncode, 3, proc.stderr)
        self.assertTrue(os.path.exists(self.db + ".tmp"))
        report = self.assert_recovered_state(["t1"], [])
        self.assertTrue(report["tmp_discarded"])
        self.assertFalse(os.path.exists(self.db + ".tmp"))

    def test_b_crash_after_rename_task_done_not_pending(self):
        proc = self.run_script([enq("t1"), run("t1"), crash("after_rename")])
        self.assertEqual(proc.returncode, 3, proc.stderr)
        self.assertFalse(os.path.exists(self.db + ".tmp"))
        report = self.assert_recovered_state([], ["t1"])
        self.assertFalse(report["tmp_discarded"])

    def test_crash_before_tmp_leaves_no_tmp(self):
        proc = self.run_script([enq("t1"), crash("before_tmp")])
        self.assertEqual(proc.returncode, 3, proc.stderr)
        self.assertFalse(os.path.exists(self.db + ".tmp"))
        self.assert_recovered_state(["t1"], [])

    def test_crash_skips_subsequent_actions(self):
        proc = self.run_script(
            [enq("a"), crash("after_rename"), enq("b"), run("a")])
        self.assertEqual(proc.returncode, 3, proc.stderr)
        self.assert_recovered_state(["a"], [])

    def test_e_recover_is_idempotent(self):
        self.run_script([enq("t1"), crash("after_tmp_before_rename")])
        first = self.recover()
        hash_after_first = hashlib.sha256(self.db_bytes()).hexdigest()
        second = self.recover()
        hash_after_second = hashlib.sha256(self.db_bytes()).hexdigest()
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(second.returncode, 0, second.stderr)
        # recovered state identical; only the tmp_discarded flag may differ
        first_state = json.loads(first.stdout)
        second_state = json.loads(second.stdout)
        self.assertEqual(first_state["pending"], second_state["pending"])
        self.assertEqual(first_state["done"], second_state["done"])
        self.assertEqual(hash_after_first, hash_after_second)


class TestConflictsAndErrors(TaskqCase):
    def test_c_duplicate_id_exit_2_db_unchanged(self):
        original = {"pending": [{"id": "x"}], "done": []}
        self.write_db(original)
        before = self.db_bytes()
        proc = self.run_script([enq("x")])
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertIn("duplicate", proc.stderr)
        self.assertEqual(self.db_bytes(), before)
        self.assertFalse(os.path.exists(self.db + ".tmp"))

    def test_c_duplicate_id_within_script_db_untouched(self):
        proc = self.run_script([enq("a"), enq("a")])
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertFalse(os.path.exists(self.db))  # never created
        self.assertFalse(os.path.exists(self.db + ".tmp"))

    def test_bad_json_exit_2(self):
        with open(self.script, "w", encoding="utf-8") as fh:
            fh.write("{not valid json")
        proc = run_cli("run", self.script, "--db", self.db, "--out", self.out)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("error:", proc.stderr)

    def test_unknown_op_exit_2(self):
        proc = self.run_script([{"op": "explode"}])
        self.assertEqual(proc.returncode, 2)
        self.assertIn("unknown op", proc.stderr)

    def test_negative_dur_exit_2(self):
        proc = self.run_script([enq("a", dur=-1)])
        self.assertEqual(proc.returncode, 2)
        self.assertIn("dur", proc.stderr)

    def test_run_of_missing_task_exit_2(self):
        proc = self.run_script([run("ghost")])
        self.assertEqual(proc.returncode, 2)
        self.assertFalse(os.path.exists(self.db))


class TestReferenceModel(TaskqCase):
    """D: for scripts of <= 8 actions, enumerate every crash point and stage,
    and compare the recovered db against an independent reference model."""

    SCRIPTS = [
        [enq("a")],
        [enq("a"), run("a")],
        [enq("a"), enq("b"), run("a")],
        [enq("a"), enq("b"), run("a"), run("b")],
        [enq("a"), enq("b"), enq("c"), run("b"), run("a"),
         enq("d"), run("d"), run("c")],
    ]

    def check_against_reference(self, actions):
        proc = self.run_script(actions)
        expect_crash = any(a["op"] == "crash" for a in actions)
        self.assertEqual(proc.returncode, 3 if expect_crash else 0,
                         proc.stderr)
        effective = []
        for a in actions:
            if a["op"] == "crash":
                break
            effective.append(a)
        pending, done = reference(effective)
        self.assert_recovered_state(pending, done)
        if not expect_crash:
            with open(self.out, encoding="utf-8") as fh:
                out = json.load(fh)
            self.assertEqual([t["id"] for t in out["done"]], done)

    def test_scripts_without_crash(self):
        for actions in self.SCRIPTS:
            with self.subTest(script=actions):
                self.setUp()
                self.check_against_reference(actions)

    def test_enumerate_crash_points(self):
        cases = 0
        for base in self.SCRIPTS:
            for pos in range(len(base) + 1):
                for stage in ("before_tmp", "after_tmp_before_rename",
                              "after_rename"):
                    with self.subTest(pos=pos, stage=stage, script=base):
                        self.setUp()
                        actions = base[:pos] + [crash(stage)] + base[pos:]
                        self.check_against_reference(actions)
                        cases += 1
        self.assertEqual(cases, 69)  # (2+3+4+5+9) positions x 3 stages

    def setUp(self):  # support nested setUp for subTest isolation
        if hasattr(self, "tmp"):
            self.tmp.cleanup()
        super().setUp()


if __name__ == "__main__":
    unittest.main()
