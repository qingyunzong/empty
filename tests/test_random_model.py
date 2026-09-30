"""Acceptance A: random operation sequences (n <= 200) checked node-by-node
against an independent in-memory reference model."""

import hashlib
import json
import os
import random
import shutil
import sys

from helpers import RepoTestCase, run_ok

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from hierosync.core import scan_manifest  # noqa: E402


def _under(path, root):
    return root == "" or path == root or path.startswith(root + "/")


class Model:
    """Reference model: current tree + list of committed tree states."""

    def __init__(self):
        self.current = {"": ("dir", None)}
        self.commits = []

    def commit(self):
        self.commits.append(dict(self.current))

    def undo(self, root, n):
        if not self.commits:
            self.commits.append(dict(self.current))
            return
        head = self.commits[-1]
        base = self.commits[-1 - n] if len(self.commits) > n else {"": ("dir", None)}
        merged = {p: v for p, v in head.items() if not _under(p, root)}
        merged.update({p: v for p, v in base.items() if _under(p, root)})
        self.current = merged
        self.commits.append(dict(self.current))

    def add_file(self, path, content):
        parts = path.split("/")
        for i in range(1, len(parts)):
            self.current.setdefault("/".join(parts[:i]), ("dir", None))
        self.current[path] = ("file", content)

    def add_dir(self, path):
        parts = path.split("/")
        for i in range(1, len(parts) + 1):
            self.current.setdefault("/".join(parts[:i]), ("dir", None))

    def remove_subtree(self, root):
        self.current = {p: v for p, v in self.current.items() if not _under(p, root)}

    def files(self):
        return [p for p, v in self.current.items() if v[0] == "file"]

    def dirs(self):
        return [p for p, v in self.current.items() if v[0] == "dir" and p]


class TestRandomModel(RepoTestCase):
    def _random_path(self, rng):
        names = ["a", "b", "c", "d", "e"]
        return "/".join(rng.choice(names) for _ in range(rng.randint(1, 3)))

    def _prefix_blocked(self, model, path):
        parts = path.split("/")
        for i in range(1, len(parts)):
            prefix = "/".join(parts[:i])
            entry = model.current.get(prefix)
            if entry is not None and entry[0] == "file":
                return True
        return False

    def _run_sequence(self, seed, n_ops):
        rng = random.Random(seed)
        model = Model()
        ops = ["mkfile", "modify", "mkdir", "rmfile", "rmdir", "commit", "undo"]
        weights = [30, 20, 10, 10, 5, 15, 10]
        for _ in range(n_ops):
            op = rng.choices(ops, weights)[0]
            if op == "mkfile":
                path = self._random_path(rng)
                if self._prefix_blocked(model, path):
                    continue
                existing = model.current.get(path)
                if existing is not None and existing[0] == "dir":
                    continue
                content = rng.randbytes(rng.randint(1, 64))
                model.add_file(path, content)
                full = os.path.join(self.repo, path)
                os.makedirs(os.path.dirname(full), exist_ok=True)
                with open(full, "wb") as fh:
                    fh.write(content)
            elif op == "modify":
                files = model.files()
                if not files:
                    continue
                path = rng.choice(files)
                extra = rng.randbytes(rng.randint(1, 16))
                model.current[path] = ("file", model.current[path][1] + extra)
                with open(os.path.join(self.repo, path), "ab") as fh:
                    fh.write(extra)
            elif op == "mkdir":
                path = self._random_path(rng)
                if self._prefix_blocked(model, path):
                    continue
                existing = model.current.get(path)
                if existing is not None and existing[0] == "file":
                    continue
                model.add_dir(path)
                os.makedirs(os.path.join(self.repo, path), exist_ok=True)
            elif op == "rmfile":
                files = model.files()
                if not files:
                    continue
                path = rng.choice(files)
                del model.current[path]
                os.remove(os.path.join(self.repo, path))
            elif op == "rmdir":
                dirs = model.dirs()
                if not dirs:
                    continue
                path = rng.choice(dirs)
                model.remove_subtree(path)
                shutil.rmtree(os.path.join(self.repo, path))
            elif op == "commit":
                out = run_ok(self.repo, self.snap)
                self.assertEqual(out["undone"], [])
                self.assertEqual(out["skipped"], [])
                model.commit()
            elif op == "undo":
                n = rng.randint(1, 5)
                root = rng.choice([""] + model.dirs())
                before = len(model.commits)
                target = self.repo if root == "" else os.path.join(self.repo, root)
                out = run_ok(target, self.snap, undo=n)
                model.undo(root, n)
                examined = min(n, before)
                self.assertEqual(len(out["undone"]) + len(out["skipped"]), examined)
        # Finish with a clean commit so HEAD must match the working tree.
        run_ok(self.repo, self.snap)
        model.commit()
        return model

    def _check_against_model(self, model):
        disk = scan_manifest(self.repo, exclude=os.path.abspath(self.snap))
        # Node-by-node comparison: identical path sets, types and file hashes.
        self.assertEqual(set(disk), set(model.current))
        for path, entry in disk.items():
            want_type, want_content = model.current[path]
            self.assertEqual(entry["type"], want_type, path)
            if want_type == "file":
                self.assertEqual(
                    entry["hash"], hashlib.sha256(want_content).hexdigest(), path
                )
        # HEAD snapshot manifest matches the recomputed on-disk hashes.
        with open(os.path.join(self.snap, "HEAD")) as fh:
            head_id = fh.read().strip()
        with open(os.path.join(self.snap, "snapshots", head_id + ".json")) as fh:
            head_snap = json.load(fh)
        self.assertEqual(head_snap["manifest"], disk)
        self.assertEqual(head_snap["root_hash"], disk[""]["hash"])
        # Chain length and total ordering by (seq, time_ns).
        chain, seen, current = [], set(), head_id
        while current is not None:
            self.assertNotIn(current, seen)
            seen.add(current)
            with open(os.path.join(self.snap, "snapshots", current + ".json")) as fh:
                snap = json.load(fh)
            chain.append(snap)
            current = snap["parent"]
        self.assertEqual(len(chain), len(model.commits))
        seqs = [s["seq"] for s in chain]
        self.assertEqual(seqs, sorted(seqs, reverse=True))
        self.assertEqual(len(set(seqs)), len(seqs))

    def test_random_seed_1(self):
        model = self._run_sequence(seed=20240901, n_ops=200)
        self._check_against_model(model)

    def test_random_seed_2(self):
        model = self._run_sequence(seed=777, n_ops=200)
        self._check_against_model(model)

    def test_random_seed_3(self):
        model = self._run_sequence(seed=42, n_ops=200)
        self._check_against_model(model)
