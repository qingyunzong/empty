import itertools
import json
import os
import subprocess
import sys
import tempfile
import unittest

from safedelsync import sync_dirs


def write(root, rel, data):
    path = os.path.join(root, *rel.split("/"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data if isinstance(data, bytes) else data.encode())


def remove(root, rel):
    os.remove(os.path.join(root, *rel.split("/")))


def tree(root):
    result = {}
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            with open(full, "rb") as f:
                result[rel] = f.read()
    return result


class SyncTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = self.tmp.name
        self.left = os.path.join(base, "L")
        self.right = os.path.join(base, "R")
        self.state = os.path.join(base, "state.json")
        os.makedirs(self.left)
        os.makedirs(self.right)

    def sync(self):
        return sync_dirs(self.left, self.right, self.state)

    def assert_converged_and_stable(self):
        self.assertEqual(tree(self.left), tree(self.right))
        stats = self.sync()
        self.assertEqual(stats, {"copied": 0, "deleted": 0, "conflicts": 0})
        self.assertEqual(tree(self.left), tree(self.right))

    # --- Acceptance B: single-side addition is never deleted -------------
    def test_b_new_file_not_deleted(self):
        write(self.left, "new.txt", "hello")
        stats = self.sync()
        self.assertEqual(stats["deleted"], 0)
        self.assertEqual(stats["copied"], 1)
        self.assertEqual(tree(self.right)["new.txt"], b"hello")
        self.assert_converged_and_stable()

    def test_b_new_file_with_existing_state(self):
        write(self.left, "a.txt", "a")
        self.sync()
        write(self.right, "b.txt", "b")
        stats = self.sync()
        self.assertEqual(stats["deleted"], 0)
        self.assertEqual(tree(self.left)["b.txt"], b"b")
        self.assert_converged_and_stable()

    # --- Delete propagation ----------------------------------------------
    def test_delete_propagates(self):
        write(self.left, "a.txt", "a")
        self.sync()
        remove(self.left, "a.txt")
        stats = self.sync()
        self.assertEqual(stats["deleted"], 1)
        self.assertNotIn("a.txt", tree(self.right))
        self.assert_converged_and_stable()

    # --- Acceptance C: late stale modify does not resurrect --------------
    def test_c_stale_echo_not_resurrected(self):
        write(self.left, "a.txt", "old-content")
        self.sync()
        remove(self.left, "a.txt")
        self.sync()  # deletion propagates, tombstone recorded
        self.assertNotIn("a.txt", tree(self.right))
        # A stale writer re-creates the exact old content on the right.
        write(self.right, "a.txt", "old-content")
        stats = self.sync()
        self.assertNotIn("a.txt", tree(self.left))
        self.assertNotIn("a.txt", tree(self.right))
        self.assertEqual(stats["deleted"], 1)
        self.assert_converged_and_stable()

    def test_c_genuinely_new_content_after_delete_is_added(self):
        write(self.left, "a.txt", "old-content")
        self.sync()
        remove(self.left, "a.txt")
        self.sync()
        write(self.right, "a.txt", "brand-new-content")
        stats = self.sync()
        self.assertEqual(stats["copied"], 1)
        self.assertEqual(tree(self.left)["a.txt"], b"brand-new-content")
        self.assert_converged_and_stable()

    # --- Rule 3: delete vs modify -> modify wins + .conflict -------------
    def test_delete_vs_modify_conflict(self):
        write(self.left, "a.txt", "v1")
        self.sync()
        remove(self.left, "a.txt")
        write(self.right, "a.txt", "v2")
        stats = self.sync()
        self.assertEqual(stats["conflicts"], 1)
        self.assertEqual(tree(self.left)["a.txt"], b"v2")
        self.assertEqual(tree(self.right)["a.txt"], b"v2")
        self.assertEqual(tree(self.left)["a.txt.conflict"], b"v2")
        self.assertEqual(tree(self.right)["a.txt.conflict"], b"v2")
        self.assert_converged_and_stable()

    # --- Rule 4: both modified -> lexicographically smaller wins ---------
    def test_both_modified_conflict(self):
        write(self.left, "a.txt", "base")
        self.sync()
        write(self.left, "a.txt", "zzz-larger")
        write(self.right, "a.txt", "aaa-smaller")
        stats = self.sync()
        self.assertEqual(stats["conflicts"], 1)
        self.assertEqual(tree(self.left)["a.txt"], b"aaa-smaller")
        self.assertEqual(tree(self.right)["a.txt"], b"aaa-smaller")
        self.assertEqual(tree(self.left)["a.txt.conflict"], b"zzz-larger")
        self.assertEqual(tree(self.right)["a.txt.conflict"], b"zzz-larger")
        # Idempotent rerun: conflict count must not grow.
        stats2 = self.sync()
        self.assertEqual(stats2["conflicts"], 0)
        self.assert_converged_and_stable()

    def test_both_added_different_content_conflict(self):
        write(self.left, "n.txt", "left-new")
        write(self.right, "n.txt", "right-new")
        stats = self.sync()
        self.assertEqual(stats["conflicts"], 1)
        self.assertEqual(tree(self.left)["n.txt"], b"left-new")
        self.assertEqual(tree(self.right)["n.txt"], b"left-new")
        self.assert_converged_and_stable()

    def test_same_change_both_sides_no_conflict(self):
        write(self.left, "a.txt", "v1")
        self.sync()
        write(self.left, "a.txt", "v2")
        write(self.right, "a.txt", "v2")
        stats = self.sync()
        self.assertEqual(stats, {"copied": 0, "deleted": 0, "conflicts": 0})
        self.assert_converged_and_stable()

    def test_nested_directories(self):
        write(self.left, "d1/d2/deep.txt", "deep")
        self.sync()
        self.assertEqual(tree(self.right)["d1/d2/deep.txt"], b"deep")
        remove(self.left, "d1/d2/deep.txt")
        self.sync()
        self.assertNotIn("d1/d2/deep.txt", tree(self.right))
        self.assert_converged_and_stable()

    # --- Acceptance A: enumerated interleaved op sequences converge ------
    def test_a_enumerated_operation_sequences(self):
        # Curated small op set: add/modify/delete on two paths, both sides.
        ops = [
            ("add", "L", "a", "a1"), ("add", "R", "a", "a2"),
            ("add", "L", "b", "b1"), ("add", "R", "b", "b2"),
            ("mod", "L", "a", "a3"), ("mod", "R", "a", "a4"),
            ("del", "L", "a", None), ("del", "R", "a", None),
            ("del", "L", "b", None), ("del", "R", "b", None),
        ]

        def apply(op):
            kind, side, path, content = op
            root = self.left if side == "L" else self.right
            full = os.path.join(root, path)
            if kind == "del":
                if os.path.exists(full):
                    os.remove(full)
            else:
                write(root, path, content)

        sequences = []
        for length in (1, 2, 3):
            sequences.extend(itertools.product(ops, repeat=length))
        # Deterministic sample of longer (<=6 step) sequences.
        for i, seq in enumerate(itertools.product(ops, repeat=6)):
            if i % 977 == 0:
                sequences.append(seq)

        checked = 0
        for seq in sequences:
            for d in (self.left, self.right):
                for dirpath, _dn, fn in os.walk(d, topdown=False):
                    for name in fn:
                        os.remove(os.path.join(dirpath, name))
            if os.path.exists(self.state):
                os.remove(self.state)
            for op in seq:
                apply(op)
                self.sync()
            self.sync()
            self.assertEqual(
                tree(self.left), tree(self.right),
                f"diverged after {seq}")
            stats = self.sync()
            self.assertEqual(
                stats, {"copied": 0, "deleted": 0, "conflicts": 0},
                f"not idempotent after {seq}")
            checked += 1
        self.assertGreater(checked, 1000)

    # --- Acceptance D: kill mid-sync, rerun is stable --------------------
    def test_d_crash_then_rerun_stable(self):
        write(self.left, "keep.txt", "keep")
        write(self.left, "gone.txt", "gone")
        self.sync()
        remove(self.left, "gone.txt")
        write(self.left, "new1.txt", "n1")
        write(self.right, "new2.txt", "n2")
        write(self.left, "keep.txt", "keep-v2")
        env = dict(os.environ, SAFEDELSYNC_CRASH_AFTER="1")
        crashed = subprocess.run(
            [sys.executable, "-m", "safedelsync", "sync",
             self.left, self.right, "--state", self.state],
            capture_output=True, env=env)
        self.assertNotEqual(crashed.returncode, 0)
        # Rerun to completion: must converge and then be a no-op.
        stats = self.sync()
        self.assertEqual(tree(self.left), tree(self.right))
        stats2 = self.sync()
        self.assertEqual(stats2, {"copied": 0, "deleted": 0, "conflicts": 0})
        self.assertEqual(tree(self.left), tree(self.right))
        self.assertNotIn("gone.txt", tree(self.left))
        self.assertEqual(tree(self.left)["keep.txt"], b"keep-v2")
        self.assertEqual(tree(self.left)["new1.txt"], b"n1")
        self.assertEqual(tree(self.left)["new2.txt"], b"n2")
        # Conflict count must not grow across reruns.
        self.assertEqual(stats["conflicts"], 0)

    def test_d_crash_at_every_step_recovers(self):
        write(self.left, "a.txt", "v1")
        write(self.left, "b.txt", "w1")
        self.sync()
        remove(self.left, "a.txt")
        write(self.right, "b.txt", "w2")
        write(self.left, "c.txt", "c1")
        for crash_at in (1, 2, 3):
            env = dict(os.environ, SAFEDELSYNC_CRASH_AFTER=str(crash_at))
            subprocess.run(
                [sys.executable, "-m", "safedelsync", "sync",
                 self.left, self.right, "--state", self.state],
                capture_output=True, env=env)
            self.sync()  # complete the interrupted sync
            self.assertEqual(tree(self.left), tree(self.right))
            stats = self.sync()
            self.assertEqual(
                stats, {"copied": 0, "deleted": 0, "conflicts": 0})

    # --- CLI / state corruption ------------------------------------------
    def test_cli_json_output(self):
        write(self.left, "x.txt", "x")
        proc = subprocess.run(
            [sys.executable, "-m", "safedelsync", "sync",
             self.left, self.right, "--state", self.state],
            capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(set(out), {"copied", "deleted", "conflicts"})
        self.assertEqual(out["copied"], 1)

    def test_corrupt_state_exit_code_4(self):
        with open(self.state, "w") as f:
            f.write("{not valid json")
        proc = subprocess.run(
            [sys.executable, "-m", "safedelsync", "sync",
             self.left, self.right, "--state", self.state],
            capture_output=True, text=True)
        self.assertEqual(proc.returncode, 4)
        self.assertTrue(proc.stderr.strip())
        self.assertEqual(proc.stdout, "")

    def test_wrong_version_state_exit_code_4(self):
        with open(self.state, "w") as f:
            json.dump({"version": 999, "entries": {}}, f)
        proc = subprocess.run(
            [sys.executable, "-m", "safedelsync", "sync",
             self.left, self.right, "--state", self.state],
            capture_output=True, text=True)
        self.assertEqual(proc.returncode, 4)


if __name__ == "__main__":
    unittest.main()
