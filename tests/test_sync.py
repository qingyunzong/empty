import hashlib
import json
import os
import random
import shutil
import string
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_NAME = ".treesync_state"
JOURNAL_NAME = STATE_NAME + ".journal"
TMP_DIR = ".treesync_tmp"


def run_sync(src, dst, state=None, env_extra=None):
    cmd = [sys.executable, "-m", "treesync", "sync", src, dst]
    if state:
        cmd += ["--state", state]
    env = dict(os.environ)
    env["PYTHONPATH"] = ROOT + os.pathsep + env.get("PYTHONPATH", "")
    if env_extra:
        env.update(env_extra)
    return subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT, env=env)


def snapshot(root):
    """Brute-force {relpath: sha256} for files plus set of dirs."""
    files, dirs = {}, set()
    for dirpath, dirnames, filenames in os.walk(root):
        for name in dirnames:
            rel = os.path.relpath(os.path.join(dirpath, name), root)
            dirs.add(rel.replace(os.sep, "/"))
        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            h = hashlib.sha256()
            with open(full, "rb") as f:
                for chunk in iter(lambda: f.read(65536), b""):
                    h.update(chunk)
            files[rel] = h.hexdigest()
    return files, dirs


def write_file(root, rel, data, rng=None):
    full = os.path.join(root, rel)
    os.makedirs(os.path.dirname(full) or root, exist_ok=True)
    with open(full, "wb") as f:
        f.write(data)
    if rng is not None:  # unique mtime so fingerprint changes are visible
        ns = rng.randrange(1_000_000_000, 9_000_000_000_000_000_000)
        os.utime(full, ns=(ns, ns))


class TreesyncCase(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.mkdtemp(prefix="treesync-test-")
        self.addCleanup(shutil.rmtree, self.td, True)
        self.src = os.path.join(self.td, "src")
        self.dst = os.path.join(self.td, "dst")
        os.makedirs(self.src)


class TestRandomTrees(TreesyncCase):
    """A: random small trees (n<=30 files) match brute-force hash sets."""

    def test_random_trees_match_bruteforce(self):
        rng = random.Random(20261001)
        for round_no in range(6):
            self._mutate(rng)
            res = run_sync(self.src, self.dst)
            self.assertEqual(res.returncode, 0, res.stderr)
            report = json.loads(res.stdout)
            self.assertEqual(report["status"], "ok")
            src_files, src_dirs = snapshot(self.src)
            dst_files, dst_dirs = snapshot(self.dst)
            dst_files.pop(STATE_NAME, None)
            self.assertEqual(src_files, dst_files, "round %d files" % round_no)
            self.assertEqual(src_dirs, dst_dirs, "round %d dirs" % round_no)

    def _mutate(self, rng):
        existing = []
        for dirpath, _, filenames in os.walk(self.src):
            for name in filenames:
                existing.append(
                    os.path.relpath(os.path.join(dirpath, name), self.src)
                )
        for _ in range(rng.randrange(4, 12)):
            action = rng.choice(["add", "add", "modify", "delete", "rename", "mkdir"])
            if action == "add" and len(existing) < 30:
                rel = self._rand_path(rng)
                write_file(self.src, rel, rng.randbytes(rng.randrange(0, 2000)), rng)
                existing.append(rel)
            elif action == "modify" and existing:
                rel = rng.choice(existing)
                write_file(self.src, rel, rng.randbytes(rng.randrange(1, 2000)), rng)
            elif action == "delete" and existing:
                rel = existing.pop(rng.randrange(len(existing)))
                os.remove(os.path.join(self.src, rel))
                self._prune_empty_dirs()
            elif action == "rename" and existing:
                old = existing.pop(rng.randrange(len(existing)))
                new = self._rand_path(rng)
                full_new = os.path.join(self.src, new)
                os.makedirs(os.path.dirname(full_new) or self.src, exist_ok=True)
                os.rename(os.path.join(self.src, old), full_new)
                existing.append(new)
                self._prune_empty_dirs()
            elif action == "mkdir":
                os.makedirs(
                    os.path.join(self.src, self._rand_path(rng)), exist_ok=True
                )

    def _rand_path(self, rng):
        depth = rng.randrange(0, 3)
        parts = [
            "".join(rng.choices(string.ascii_lowercase, k=rng.randrange(2, 7)))
            for _ in range(depth)
        ]
        parts.append("f%s.dat" % rng.randrange(100000))
        return "/".join(parts)

    def _prune_empty_dirs(self):
        for dirpath, dirnames, filenames in os.walk(self.src, topdown=False):
            if dirpath != self.src and not dirnames and not filenames:
                os.rmdir(dirpath)


class TestCrashRecovery(TreesyncCase):
    """B: kill mid-copy; recovery leaves no .tmp and a consistent state."""

    def test_kill_mid_copy_recovers_cleanly(self):
        rng = random.Random(7)
        for i in range(6):
            write_file(self.src, "small%d.txt" % i, rng.randbytes(64), rng)
        write_file(self.src, "zz_big.bin", rng.randbytes(8 * 1024 * 1024), rng)

        env = dict(os.environ)
        env["PYTHONPATH"] = ROOT + os.pathsep + env.get("PYTHONPATH", "")
        env["TREESYNC_OP_DELAY"] = "0.15"
        proc = subprocess.Popen(
            [sys.executable, "-m", "treesync", "sync", self.src, self.dst],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=ROOT,
            env=env,
        )
        journal = os.path.join(self.dst, JOURNAL_NAME)
        tmp_dir = os.path.join(self.dst, TMP_DIR)
        saw_journal = False
        saw_tmp = False
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            saw_journal = saw_journal or os.path.exists(journal)
            if os.path.isdir(tmp_dir) and any(
                n.endswith(".tmp") for n in os.listdir(tmp_dir)
            ):
                saw_tmp = True
                break
            time.sleep(0.01)
        proc.kill()
        proc.communicate()
        self.assertTrue(saw_journal, "journal should exist before the kill")
        self.assertTrue(saw_tmp, "should have killed during a temp-file copy")
        self.assertTrue(
            any(n.endswith(".tmp") for n in os.listdir(tmp_dir)),
            "half-finished temp file should be left behind by SIGKILL",
        )

        res = run_sync(self.src, self.dst)
        self.assertEqual(res.returncode, 0, res.stderr)
        report = json.loads(res.stdout)
        self.assertGreaterEqual(report["recovered_ops"], 1)

        for dirpath, dirnames, filenames in os.walk(self.dst):
            self.assertNotIn(TMP_DIR, dirpath)
            for name in filenames:
                self.assertFalse(name.endswith(".tmp"), "leftover tmp: " + name)
        src_files, src_dirs = snapshot(self.src)
        dst_files, dst_dirs = snapshot(self.dst)
        dst_files.pop(STATE_NAME, None)
        self.assertEqual(src_files, dst_files)
        self.assertEqual(src_dirs, dst_dirs)

        with open(os.path.join(self.dst, STATE_NAME)) as f:
            state = json.load(f)
        self.assertEqual(set(state["entries"]), set(src_files) | set(src_dirs))

        # A follow-up sync is a no-op: state is consistent.
        res = run_sync(self.src, self.dst)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(json.loads(res.stdout)["plan"]["op_count"], 0)


class TestRename(TreesyncCase):
    """C: a pure rename a->b produces a rename op, not delete+add/conflict."""

    def test_rename_only(self):
        write_file(self.src, "a.txt", b"hello rename")
        res = run_sync(self.src, self.dst)
        self.assertEqual(res.returncode, 0, res.stderr)

        os.rename(os.path.join(self.src, "a.txt"), os.path.join(self.src, "b.txt"))
        res = run_sync(self.src, self.dst)
        self.assertEqual(res.returncode, 0, res.stderr)
        report = json.loads(res.stdout)
        ops = [op for b in report["plan"]["batches"] for op in b["ops"]]
        self.assertEqual(
            ops, [{"op": "rename", "from": "a.txt", "to": "b.txt", "id": 0}]
        )
        self.assertEqual(report["result"]["renames"], 1)
        self.assertEqual(report["result"]["deletes"], 0)
        self.assertEqual(report["result"]["copies"], 0)
        self.assertFalse(os.path.exists(os.path.join(self.dst, "a.txt")))
        with open(os.path.join(self.dst, "b.txt"), "rb") as f:
            self.assertEqual(f.read(), b"hello rename")

        # Idempotent: a third sync plans zero ops.
        res = run_sync(self.src, self.dst)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(json.loads(res.stdout)["plan"]["op_count"], 0)


class TestConflict(TreesyncCase):
    """D: a foreign file in DST triggers conflict (exit 4), nothing changes."""

    def test_foreign_file_conflicts(self):
        write_file(self.src, "x.txt", b"version one")
        res = run_sync(self.src, self.dst)
        self.assertEqual(res.returncode, 0, res.stderr)

        write_file(self.src, "x.txt", b"version two")
        write_file(self.dst, "foreign.txt", b"not from src")
        res = run_sync(self.src, self.dst)
        self.assertEqual(res.returncode, 4, res.stderr)
        report = json.loads(res.stdout)
        self.assertEqual(report["status"], "conflict")
        self.assertEqual(report["conflicts"], ["foreign.txt"])
        self.assertIn("foreign.txt", res.stderr)

        # Nothing was applied: foreign file intact, pending copy not done.
        with open(os.path.join(self.dst, "foreign.txt"), "rb") as f:
            self.assertEqual(f.read(), b"not from src")
        with open(os.path.join(self.dst, "x.txt"), "rb") as f:
            self.assertEqual(f.read(), b"version one")

        # Removing the foreign file lets the sync proceed.
        os.remove(os.path.join(self.dst, "foreign.txt"))
        res = run_sync(self.src, self.dst)
        self.assertEqual(res.returncode, 0, res.stderr)
        with open(os.path.join(self.dst, "x.txt"), "rb") as f:
            self.assertEqual(f.read(), b"version two")


class TestEmptyAndBatching(TreesyncCase):
    def test_empty_source_clears_destination_but_keeps_state(self):
        write_file(self.src, "d1/d2/f.txt", b"data")
        write_file(self.src, "top.txt", b"data")
        res = run_sync(self.src, self.dst)
        self.assertEqual(res.returncode, 0, res.stderr)

        shutil.rmtree(self.src)
        os.makedirs(self.src)
        res = run_sync(self.src, self.dst)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(os.listdir(self.dst), [STATE_NAME])
        with open(os.path.join(self.dst, STATE_NAME)) as f:
            self.assertEqual(json.load(f)["entries"], {})

    def test_batches_of_at_most_64_ops(self):
        rng = random.Random(11)
        for i in range(70):
            write_file(self.src, "f%03d.txt" % i, rng.randbytes(32), rng)
        res = run_sync(self.src, self.dst)
        self.assertEqual(res.returncode, 0, res.stderr)
        report = json.loads(res.stdout)
        self.assertEqual(report["plan"]["op_count"], 70)
        self.assertEqual(len(report["plan"]["batches"]), 2)
        sizes = [len(b["ops"]) for b in report["plan"]["batches"]]
        self.assertEqual(sizes, [64, 6])
        src_files, _ = snapshot(self.src)
        dst_files, _ = snapshot(self.dst)
        dst_files.pop(STATE_NAME, None)
        self.assertEqual(src_files, dst_files)

    def test_custom_state_path_outside_dst(self):
        state = os.path.join(self.td, "state.json")
        write_file(self.src, "f.txt", b"x")
        res = run_sync(self.src, self.dst, state=state)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertTrue(os.path.exists(state))
        self.assertEqual(os.listdir(self.dst), ["f.txt"])


if __name__ == "__main__":
    unittest.main()
