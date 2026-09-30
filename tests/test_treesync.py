import hashlib
import json
import os
import random
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_NAME = ".treesync_state"


def run_cli(src, dst, state=None, env_extra=None):
    cmd = [sys.executable, "-m", "treesync", "sync", src, dst]
    if state is not None:
        cmd += ["--state", state]
    env = dict(os.environ)
    env["PYTHONPATH"] = REPO_ROOT + os.pathsep + env.get("PYTHONPATH", "")
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        cmd, capture_output=True, text=True, env=env, cwd=REPO_ROOT
    )


def hash_set(root, skip_state=True):
    result = {}
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root)
            if skip_state and rel == STATE_NAME:
                continue
            with open(full, "rb") as fh:
                result[rel] = hashlib.sha256(fh.read()).hexdigest()
    return result


def list_all(root):
    entries = []
    for dirpath, dirnames, filenames in os.walk(root):
        for name in dirnames:
            entries.append(os.path.relpath(os.path.join(dirpath, name), root) + "/")
        for name in filenames:
            entries.append(os.path.relpath(os.path.join(dirpath, name), root))
    return sorted(entries)


def write_file(root, rel, content, mtime_ns=None):
    full = os.path.join(root, rel)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "wb") as fh:
        fh.write(content)
    if mtime_ns is not None:
        os.utime(full, ns=(mtime_ns, mtime_ns))


def build_random_tree(rng, root, n):
    for i in range(n):
        depth = rng.randint(0, 2)
        parts = ["d%d" % rng.randint(0, 3) for _ in range(depth)]
        parts.append("f%02d_%d.bin" % (i, rng.randint(0, 4)))
        rel = os.path.join(*parts)
        content = rng.randbytes(rng.randint(0, 200))
        write_file(root, rel, content, mtime_ns=rng.randint(1, 10**15))


def mutate_tree(rng, root, n):
    files = [
        os.path.relpath(os.path.join(dp, f), root)
        for dp, _dn, fs in os.walk(root)
        for f in fs
    ]
    for rel in rng.sample(files, k=min(len(files), rng.randint(1, 4))):
        action = rng.choice(["delete", "modify", "rename"])
        full = os.path.join(root, rel)
        if action == "delete":
            os.remove(full)
        elif action == "modify":
            write_file(root, rel, rng.randbytes(rng.randint(1, 200)),
                       mtime_ns=rng.randint(1, 10**15))
        else:
            target = os.path.join(root, "renamed_%d.bin" % rng.randint(0, 999))
            os.rename(full, target)
    build_random_tree(rng, root, rng.randint(0, 4))
    # prune empty dirs left behind
    for dirpath, dirnames, filenames in os.walk(root, topdown=False):
        if not dirnames and not filenames and dirpath != root:
            os.rmdir(dirpath)


class SyncTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="treesync_test_")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.src = os.path.join(self.tmp, "src")
        self.dst = os.path.join(self.tmp, "dst")
        self.state = os.path.join(self.tmp, "state.json")
        os.makedirs(self.src)

    def assert_trees_equal(self):
        self.assertEqual(
            hash_set(self.src), hash_set(self.dst),
            "DST hash set differs from SRC hash set",
        )


class TestRandomTrees(SyncTestBase):
    def test_random_trees_match_bruteforce(self):
        for seed in range(6):
            with self.subTest(seed=seed):
                rng = random.Random(seed)
                shutil.rmtree(self.src, ignore_errors=True)
                shutil.rmtree(self.dst, ignore_errors=True)
                os.makedirs(self.src)
                build_random_tree(rng, self.src, rng.randint(0, 30))
                for round_no in range(3):
                    proc = run_cli(self.src, self.dst, state=self.state)
                    self.assertEqual(proc.returncode, 0, proc.stderr)
                    report = json.loads(proc.stdout)
                    self.assertEqual(report["result"]["status"], "ok")
                    self.assert_trees_equal()
                    # brute-force reference: plain copy must hash-identical
                    ref = os.path.join(self.tmp, "ref")
                    shutil.rmtree(ref, ignore_errors=True)
                    shutil.copytree(self.src, ref)
                    self.assertEqual(hash_set(ref), hash_set(self.dst))
                    # idempotent: second run has empty plan
                    again = run_cli(self.src, self.dst, state=self.state)
                    self.assertEqual(again.returncode, 0, again.stderr)
                    self.assertEqual(
                        json.loads(again.stdout)["plan"]["op_count"], 0
                    )
                    if round_no < 2:
                        mutate_tree(rng, self.src, 30)


class TestCrashRecovery(SyncTestBase):
    def _populate(self, n=6):
        for i in range(n):
            write_file(self.src, "file%d.dat" % i,
                       b"payload-%d-" % i + bytes([i]) * 120)

    def test_kill_during_copy_recovers_without_temp(self):
        self._populate()
        proc = run_cli(self.src, self.dst, state=self.state,
                       env_extra={"TREESYNC_TEST_CRASH_IN_COPY": "1"})
        self.assertEqual(proc.returncode, -signal.SIGKILL)
        leftovers = [e for e in list_all(self.dst) if ".tmp" in e]
        self.assertTrue(leftovers, "expected a half-written temp file")
        # plant an additional stale temp not covered by the journal
        write_file(self.dst, "stale.treesync.tmp", b"orphan")

        proc = run_cli(self.src, self.dst, state=self.state)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        report = json.loads(proc.stdout)
        self.assertGreater(report["result"]["resumed_from_journal"], 0)
        self.assertIn("stale.treesync.tmp", report["result"]["cleaned_temp"])
        self.assertEqual([e for e in list_all(self.dst) if ".tmp" in e], [])
        self.assert_trees_equal()

        again = run_cli(self.src, self.dst, state=self.state)
        self.assertEqual(json.loads(again.stdout)["plan"]["op_count"], 0)

    def test_kill_between_op_and_journal_mark_recovers(self):
        self._populate(n=5)
        proc = run_cli(self.src, self.dst, state=self.state,
                       env_extra={"TREESYNC_TEST_KILL_AFTER_OP": "2"})
        self.assertEqual(proc.returncode, -signal.SIGKILL)
        self.assertTrue(os.path.exists(self.state + ".journal"))

        proc = run_cli(self.src, self.dst, state=self.state)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertFalse(os.path.exists(self.state + ".journal"))
        self.assertEqual([e for e in list_all(self.dst) if ".tmp" in e], [])
        self.assert_trees_equal()


class TestRename(SyncTestBase):
    def test_pure_rename_is_not_delete_plus_create(self):
        write_file(self.src, "a.txt", b"rename-me" * 10)
        proc = run_cli(self.src, self.dst, state=self.state)
        self.assertEqual(proc.returncode, 0, proc.stderr)

        os.rename(os.path.join(self.src, "a.txt"), os.path.join(self.src, "b.txt"))
        proc = run_cli(self.src, self.dst, state=self.state)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        report = json.loads(proc.stdout)
        ops = report["plan"]["ops"]
        renames = [o for o in ops if o["op"] == "rename"]
        self.assertEqual(len(renames), 1)
        self.assertEqual(renames[0]["old"], "a.txt")
        self.assertEqual(renames[0]["new"], "b.txt")
        self.assertFalse(any(
            o["op"] == "delete" and o["path"] == "a.txt" for o in ops
        ))
        self.assertFalse(any(
            o["op"] == "copy" and o["dst"] == "b.txt" for o in ops
        ))
        self.assert_trees_equal()
        self.assertFalse(os.path.exists(os.path.join(self.dst, "a.txt")))
        with open(os.path.join(self.dst, "b.txt"), "rb") as fh:
            self.assertEqual(fh.read(), b"rename-me" * 10)


class TestConflict(SyncTestBase):
    def test_foreign_file_in_dst_conflicts_and_is_untouched(self):
        write_file(self.src, "tracked.txt", b"tracked")
        proc = run_cli(self.src, self.dst, state=self.state)
        self.assertEqual(proc.returncode, 0, proc.stderr)

        write_file(self.dst, "foreign.txt", b"precious foreign data")
        write_file(self.src, "newfile.txt", b"new in src")
        proc = run_cli(self.src, self.dst, state=self.state)
        self.assertEqual(proc.returncode, 4, proc.stderr)
        self.assertIn("foreign.txt", proc.stderr)
        report = json.loads(proc.stdout)
        self.assertEqual(report["result"]["status"], "conflict")
        self.assertIn("foreign.txt", report["result"]["conflicts"])
        # foreign file untouched, nothing else applied
        with open(os.path.join(self.dst, "foreign.txt"), "rb") as fh:
            self.assertEqual(fh.read(), b"precious foreign data")
        self.assertFalse(os.path.exists(os.path.join(self.dst, "newfile.txt")))

    def test_foreign_file_shadowing_new_src_file_not_overwritten(self):
        write_file(self.src, "kept.txt", b"kept")
        proc = run_cli(self.src, self.dst, state=self.state)
        self.assertEqual(proc.returncode, 0, proc.stderr)

        write_file(self.dst, "same_name.txt", b"foreign content")
        write_file(self.src, "same_name.txt", b"src content")
        proc = run_cli(self.src, self.dst, state=self.state)
        self.assertEqual(proc.returncode, 4, proc.stderr)
        with open(os.path.join(self.dst, "same_name.txt"), "rb") as fh:
            self.assertEqual(fh.read(), b"foreign content")


class TestEmptyAndBatching(SyncTestBase):
    def test_empty_source_clears_dst_but_keeps_state(self):
        write_file(self.src, "sub/x.txt", b"x")
        write_file(self.src, "y.txt", b"y")
        proc = run_cli(self.src, self.dst)  # default state inside DST
        self.assertEqual(proc.returncode, 0, proc.stderr)
        state_path = os.path.join(self.dst, STATE_NAME)
        self.assertTrue(os.path.exists(state_path))

        shutil.rmtree(self.src)
        os.makedirs(self.src)
        proc = run_cli(self.src, self.dst)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(list_all(self.dst), [STATE_NAME])
        self.assertTrue(os.path.exists(state_path))

    def test_batches_of_at_most_64_ops(self):
        for i in range(70):
            write_file(self.src, "f%03d.txt" % i, b"data%d" % i)
        proc = run_cli(self.src, self.dst, state=self.state)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        report = json.loads(proc.stdout)
        self.assertEqual(report["plan"]["op_count"], 70)
        self.assertEqual(report["plan"]["batches"], 2)
        self.assertEqual(report["result"]["applied"], 70)
        self.assert_trees_equal()


if __name__ == "__main__":
    unittest.main()
