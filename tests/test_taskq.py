import hashlib
import itertools
import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STAGES = ("before_tmp", "after_tmp_before_rename", "after_rename")


# ---------------------------------------------------------------------------
# Independent reference file-state machine (acceptance D).
# Models db/tmp files and the commit protocol without using taskq's code.
# ---------------------------------------------------------------------------
class RefMachine:
    def __init__(self, initial_db):
        self.state = {"pending": list(initial_db["pending"]),
                      "done": list(initial_db["done"])}
        self.db = json.loads(json.dumps(initial_db))  # committed file image
        self.tmp = None                               # tmp file image or None
        self.exit_code = 0

    def _commit(self, stage):
        # stage: crash injection point of THIS commit, or None
        if stage == "before_tmp":
            self.exit_code = 3
            return False
        self.tmp = json.loads(json.dumps(self.state))
        if stage == "after_tmp_before_rename":
            self.exit_code = 3
            return False
        self.db = self.tmp  # rename: commit point
        self.tmp = None
        if stage == "after_rename":
            self.exit_code = 3
            return False
        return True

    def run(self, actions):
        i = 0
        while i < len(actions):
            action = actions[i]
            op = action["op"]
            stage = None
            if i + 1 < len(actions) and actions[i + 1].get("op") == "crash":
                stage = actions[i + 1]["stage"]
            if op == "enqueue":
                task = dict(action.get("task") or {})
                task.setdefault("id", f"auto-{i}")
                ids = {t["id"] for t in self.state["pending"]} | \
                      {t["id"] for t in self.state["done"]}
                if task["id"] in ids:
                    self.exit_code = 2
                    return
                self.state["pending"].append(task)
                if not self._commit(stage):
                    return
            elif op == "run":
                if self.state["pending"]:
                    self.state["done"].append(self.state["pending"].pop(0))
                    if not self._commit(stage):
                        return
                # else: noop, no commit; a following crash is unconsumed
            elif op == "crash":
                # unconsumed crash: checkpoint commit of current state
                if not self._commit(action["stage"]):
                    return
                raise AssertionError("unreachable")
            else:
                self.exit_code = 2
                return
            i += 1

    def recover(self):
        if self.tmp is not None:
            self.tmp = None  # rename never happened -> db not updated -> discard
        return self.db


def run_cli(args, cwd=REPO_ROOT):
    return subprocess.run(
        [sys.executable, "-m", "taskq"] + args,
        cwd=cwd, capture_output=True, text=True,
    )


def sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def read_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


class TaskqCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.db = os.path.join(self.dir.name, "queue.json")
        self.tmp = self.db + ".tmp"
        self.script = os.path.join(self.dir.name, "script.json")
        self.out = os.path.join(self.dir.name, "done.json")

    def write_script(self, actions):
        with open(self.script, "w", encoding="utf-8") as f:
            json.dump({"actions": actions}, f)

    def write_db(self, state):
        with open(self.db, "w", encoding="utf-8") as f:
            json.dump(state, f)

    def summary_of(self, proc):
        lines = [json.loads(l) for l in proc.stdout.splitlines() if l.strip()]
        summaries = [l for l in lines if l.get("type") == "summary"]
        self.assertTrue(summaries, f"no summary in stdout: {proc.stdout!r}")
        return summaries[-1]

    # -- Acceptance A: crash after_tmp_before_rename -> recover, no dup ----
    def test_a_crash_after_tmp_before_rename_recovers_without_duplicates(self):
        self.write_db({"pending": [], "done": []})
        self.write_script([
            {"op": "enqueue", "task": {"id": "T1"}},
            {"op": "crash", "stage": "after_tmp_before_rename"},
            {"op": "enqueue", "task": {"id": "T2"}},
        ])
        proc = run_cli(["run", self.script, "--db", self.db, "--out", self.out])
        self.assertEqual(proc.returncode, 3, proc.stderr)
        self.assertIn("after_tmp_before_rename", proc.stderr)
        # tmp holds the uncommitted state; db was never updated
        self.assertTrue(os.path.exists(self.tmp))
        self.assertEqual(read_json(self.tmp)["pending"], [{"id": "T1"}])
        self.assertEqual(read_json(self.db), {"pending": [], "done": []})
        self.assertFalse(os.path.exists(self.out))

        rec = run_cli(["recover", "--db", self.db])
        self.assertEqual(rec.returncode, 0, rec.stderr)
        self.assertFalse(os.path.exists(self.tmp))
        summary = self.summary_of(rec)
        ids = [t["id"] for t in summary["pending"]] + [t["id"] for t in summary["done"]]
        self.assertEqual(len(ids), len(set(ids)), "duplicate task ids after recover")
        self.assertEqual(summary["pending"], [])
        self.assertEqual(summary["done"], [])

    # -- Acceptance B: crash after_rename -> task done, not pending --------
    def test_b_crash_after_rename_task_done_not_pending(self):
        self.write_script([
            {"op": "enqueue", "task": {"id": "T1"}},
            {"op": "run"},
            {"op": "crash", "stage": "after_rename"},
        ])
        proc = run_cli(["run", self.script, "--db", self.db, "--out", self.out])
        self.assertEqual(proc.returncode, 3, proc.stderr)
        self.assertIn("after_rename", proc.stderr)
        # rename completed -> commit point reached -> db has the done record
        self.assertFalse(os.path.exists(self.tmp))
        db = read_json(self.db)
        self.assertEqual([t["id"] for t in db["done"]], ["T1"])
        self.assertEqual(db["pending"], [])

        rec = run_cli(["recover", "--db", self.db])
        self.assertEqual(rec.returncode, 0, rec.stderr)
        summary = self.summary_of(rec)
        self.assertEqual([t["id"] for t in summary["done"]], ["T1"])
        self.assertEqual(summary["pending"], [])

    # -- Acceptance C: duplicate id -> exit 2, db unchanged ----------------
    def test_c_duplicate_id_exit2_db_unchanged(self):
        self.write_script([{"op": "enqueue", "task": {"id": "T1", "dur": 1}}])
        proc = run_cli(["run", self.script, "--db", self.db])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        before = sha256(self.db)

        proc2 = run_cli(["run", self.script, "--db", self.db])
        self.assertEqual(proc2.returncode, 2, proc2.stderr)
        self.assertIn("duplicate", proc2.stderr)
        self.assertEqual(sha256(self.db), before, "db changed on conflict")
        self.assertFalse(os.path.exists(self.tmp))

        # duplicate within a single script: also exit 2, and the failed
        # action must not modify the db
        self.write_script([
            {"op": "enqueue", "task": {"id": "T2"}},
            {"op": "enqueue", "task": {"id": "T2"}},
        ])
        proc3 = run_cli(["run", self.script, "--db", self.db])
        self.assertEqual(proc3.returncode, 2, proc3.stderr)
        db = read_json(self.db)
        self.assertEqual([t["id"] for t in db["pending"]], ["T1", "T2"])

    # -- Acceptance D: enumerate crash points vs reference machine ---------
    def test_d_enumerate_crash_points_against_reference(self):
        def enq(k):
            return {"op": "enqueue", "task": {"id": f"T{k}"}}

        scripts = []
        # exhaustive short scripts over {enqueue, run}
        for n in (1, 2):
            for combo in itertools.product(("e", "r"), repeat=n):
                scripts.append(
                    [enq(k) if c == "e" else {"op": "run"}
                     for k, c in enumerate(combo)])
        # seeded random scripts up to 8 actions
        rng = random.Random(20261001)
        for _ in range(12):
            n = rng.randint(3, 8)
            scripts.append([
                enq(k) if rng.random() < 0.6 else {"op": "run"}
                for k in range(n)])

        checked = 0
        for actions in scripts:
            # crash insertion points: before each action and at the end
            for pos in range(len(actions) + 1):
                for stage in STAGES:
                    with self.subTest(actions=actions, pos=pos, stage=stage):
                        self._check_scenario(actions, pos, stage)
                        checked += 1
            # control: no crash at all
            with self.subTest(actions=actions, pos=None):
                self._check_scenario(actions, None, None)
                checked += 1
        self.assertGreater(checked, 100)

    def _check_scenario(self, actions, pos, stage):
        initial = {"pending": [], "done": []}
        full = list(actions)
        if pos is not None:
            full = full[:pos] + [{"op": "crash", "stage": stage}] + full[pos:]

        ref = RefMachine(initial)
        ref.run(full)

        with tempfile.TemporaryDirectory() as d:
            db = os.path.join(d, "queue.json")
            script = os.path.join(d, "script.json")
            with open(db, "w") as f:
                json.dump(initial, f)
            with open(script, "w") as f:
                json.dump({"actions": full}, f)

            proc = run_cli(["run", script, "--db", db])
            self.assertEqual(proc.returncode, ref.exit_code,
                             f"exit mismatch; stderr={proc.stderr!r}")
            # file state after the (possibly crashed) run
            self.assertEqual(read_json(db), ref.db, "db file mismatch")
            tmp = db + ".tmp"
            if ref.tmp is None:
                self.assertFalse(os.path.exists(tmp), "unexpected tmp file")
            else:
                self.assertEqual(read_json(tmp), ref.tmp, "tmp file mismatch")

            rec = run_cli(["recover", "--db", db])
            self.assertEqual(rec.returncode, 0, rec.stderr)
            expected = ref.recover()
            self.assertEqual(read_json(db), expected, "db mismatch after recover")
            self.assertFalse(os.path.exists(tmp))
            summary = [json.loads(l) for l in rec.stdout.splitlines()
                       if json.loads(l).get("type") == "summary"][-1]
            self.assertEqual(summary["pending"], expected["pending"])
            self.assertEqual(summary["done"], expected["done"])
            # invariant: no task both done and pending
            pend = {t["id"] for t in expected["pending"]}
            done = {t["id"] for t in expected["done"]}
            self.assertFalse(pend & done)

    # -- Acceptance E: recover is idempotent -------------------------------
    def test_e_recover_twice_is_idempotent(self):
        self.write_script([
            {"op": "enqueue", "task": {"id": "T1"}},
            {"op": "enqueue", "task": {"id": "T2"}},
            {"op": "run"},
            {"op": "crash", "stage": "after_tmp_before_rename"},
        ])
        proc = run_cli(["run", self.script, "--db", self.db])
        self.assertEqual(proc.returncode, 3, proc.stderr)
        self.assertTrue(os.path.exists(self.tmp))

        rec1 = run_cli(["recover", "--db", self.db])
        self.assertEqual(rec1.returncode, 0, rec1.stderr)
        hash1 = sha256(self.db)
        summary1 = self.summary_of(rec1)

        rec2 = run_cli(["recover", "--db", self.db])
        self.assertEqual(rec2.returncode, 0, rec2.stderr)
        self.assertEqual(sha256(self.db), hash1, "second recover changed db")
        summary2 = self.summary_of(rec2)
        self.assertEqual(summary1, summary2)
        self.assertFalse(os.path.exists(self.tmp))
        # the crash interrupted run's commit before rename, so the run never
        # committed: T1 and T2 are both still pending, nothing done, no dup
        self.assertEqual(summary2["done"], [])
        self.assertEqual([t["id"] for t in summary2["pending"]], ["T1", "T2"])

    # -- Error handling: exit code 2 ---------------------------------------
    def test_error_bad_script_json_exit2(self):
        with open(self.script, "w") as f:
            f.write("{not valid json")
        proc = run_cli(["run", self.script, "--db", self.db])
        self.assertEqual(proc.returncode, 2)
        self.assertIn("invalid JSON", proc.stderr)

    def test_error_unknown_op_exit2(self):
        self.write_script([{"op": "explode"}])
        proc = run_cli(["run", self.script, "--db", self.db])
        self.assertEqual(proc.returncode, 2)
        self.assertIn("unknown op", proc.stderr)

    def test_error_negative_dur_exit2(self):
        self.write_script([{"op": "enqueue", "task": {"id": "T1"}, "dur": -1}])
        proc = run_cli(["run", self.script, "--db", self.db])
        self.assertEqual(proc.returncode, 2)
        self.assertIn("negative dur", proc.stderr)
        self.assertFalse(os.path.exists(self.db))
        self.assertFalse(os.path.exists(self.tmp))

    def test_error_bad_db_json_exit2(self):
        with open(self.db, "w") as f:
            f.write("][")
        self.write_script([])
        proc = run_cli(["run", self.script, "--db", self.db])
        self.assertEqual(proc.returncode, 2)
        rec = run_cli(["recover", "--db", self.db])
        self.assertEqual(rec.returncode, 2)

    # -- Happy path: per-action results, out file, summary ------------------
    def test_run_success_outputs_actions_and_out_file(self):
        self.write_script([
            {"op": "enqueue", "task": {"id": "T1"}, "dur": 2, "at": 100},
            {"op": "enqueue", "task": {"id": "T2"}},
            {"op": "run"},
        ])
        proc = run_cli(["run", self.script, "--db", self.db, "--out", self.out])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = [json.loads(l) for l in proc.stdout.splitlines()]
        actions = [l for l in lines if l.get("type") == "action"]
        self.assertEqual([a["op"] for a in actions], ["enqueue", "enqueue", "run"])
        self.assertTrue(all(a["status"] == "ok" for a in actions))
        summary = self.summary_of(proc)
        self.assertEqual([t["id"] for t in summary["done"]], ["T1"])
        self.assertEqual([t["id"] for t in summary["pending"]], ["T2"])
        out = read_json(self.out)
        self.assertEqual(out["done"], summary["done"])
        self.assertEqual(out["pending"], summary["pending"])

    def test_crash_before_tmp_leaves_no_trace(self):
        self.write_db({"pending": [{"id": "T0"}], "done": []})
        before = sha256(self.db)
        self.write_script([
            {"op": "enqueue", "task": {"id": "T1"}},
            {"op": "crash", "stage": "before_tmp"},
        ])
        proc = run_cli(["run", self.script, "--db", self.db])
        self.assertEqual(proc.returncode, 3, proc.stderr)
        self.assertIn("before_tmp", proc.stderr)
        self.assertFalse(os.path.exists(self.tmp))
        self.assertEqual(sha256(self.db), before)
        rec = run_cli(["recover", "--db", self.db])
        self.assertEqual(rec.returncode, 0)
        summary = self.summary_of(rec)
        self.assertEqual([t["id"] for t in summary["pending"]], ["T0"])


if __name__ == "__main__":
    unittest.main()
