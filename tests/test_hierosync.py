"""Acceptance and unit tests for hierosync.

Acceptance coverage:
  A  TestRandomModel   - random op sequences (n <= 200) vs a reference model
  B  TestSiblingUndo   - undo spanning sibling branches leaves siblings intact
  C  TestInterleaved   - undo-create / undo-delete interleavings are deterministic
  D  TestCorruption    - corrupt parent pointers -> exit code 5, no new snapshot
"""

from __future__ import annotations

import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from hierosync import core  # noqa: E402

EXIT_CORRUPTION = 5


def run_cli(root, snap, undo=None):
    cmd = [sys.executable, "-m", "hierosync", "commit", str(root), str(snap)]
    if undo is not None:
        cmd += ["--undo", str(undo)]
    proc = subprocess.run(
        cmd, cwd=REPO_ROOT, capture_output=True, text=True, timeout=60
    )
    return proc


def snapshot_disk(root):
    """Map every node under root to ('dir',) or ('file', bytes)."""
    state = {}
    root = Path(root)
    if not root.exists():
        return state
    for dirpath, dirnames, filenames in os.walk(root):
        for name in dirnames:
            rel = (Path(dirpath) / name).relative_to(root).as_posix()
            state[rel] = ("dir",)
        for name in filenames:
            full = Path(dirpath) / name
            rel = full.relative_to(root).as_posix()
            state[rel] = ("file", full.read_bytes())
    return state


class HierosyncCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="hierosync-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.root = self.tmp / "root"
        self.snap = self.tmp / "snap"
        self.root.mkdir()

    def commit(self, undo=None, expect_code=0):
        proc = run_cli(self.root, self.snap, undo)
        self.assertEqual(
            proc.returncode,
            expect_code,
            f"stdout={proc.stdout!r} stderr={proc.stderr!r}",
        )
        if expect_code == 0:
            self.assertEqual(proc.stderr, "")
            return json.loads(proc.stdout)
        self.assertNotEqual(proc.stderr, "")
        return None

    def write(self, rel, content):
        path = self.root.joinpath(*rel.split("/"))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content if isinstance(content, bytes) else content.encode())

    def head_nodes(self):
        store = core.Store(self.snap)
        chain = store.load_chain()
        return store.read_tree(chain[-1]["id"])


# ---------------------------------------------------------------------------
# Acceptance A: random operation sequences vs a reference model


class TestRandomModel(HierosyncCase):
    def test_random_ops_against_reference_model(self):
        for seed in (20260930, 7):
            with self.subTest(seed=seed):
                self._run_random_sequence(seed)
                # reset the sandbox for the next seed
                shutil.rmtree(self.root, ignore_errors=True)
                shutil.rmtree(self.snap, ignore_errors=True)
                self.root.mkdir()

    def _run_random_sequence(self, seed):
        rng = random.Random(seed)
        states = []  # committed states, oldest..newest
        noop = []  # per commit: True if the commit introduced no change
        ids = []
        current = {}  # model of the working tree

        def model_write():
            parent_pool = ["", "a", "b", "a/x", "b/y", "c", "c/d"]
            parent = rng.choice(parent_pool)
            if parent and parent not in current:
                return
            if parent and current[parent][0] != "dir":
                return
            name = rng.choice(["f1", "f2", "f3", "f4"])
            rel = f"{parent}/{name}" if parent else name
            if rel in current and current[rel][0] == "dir":
                return
            content = f"data-{rng.randrange(1000)}".encode()
            self.write(rel, content)
            current[rel] = ("file", content)

        def model_mkdir():
            parent_pool = ["", "a", "b", "c"]
            parent = rng.choice(parent_pool)
            if parent and parent not in current:
                return
            name = rng.choice(["a", "b", "c", "d", "x", "y", "empty"])
            rel = f"{parent}/{name}" if parent else name
            if rel in current:
                return
            (self.root / rel).mkdir(parents=True)
            current[rel] = ("dir",)

        def model_delete():
            if not current:
                return
            rel = rng.choice(sorted(current))
            kind = current[rel][0]
            if kind == "file":
                (self.root / rel).unlink()
                del current[rel]
            else:
                shutil.rmtree(self.root / rel)
                doomed = [p for p in current if p == rel or p.startswith(rel + "/")]
                for p in doomed:
                    del current[p]

        def model_commit():
            result = self.commit()
            prev = states[-1] if states else {}
            noop.append(current == prev)
            states.append(dict(current))
            ids.append(result["committed"])
            self.assertEqual(result["undone"], [])
            self.assertEqual(result["skipped"], [])

        def model_undo():
            nonlocal current
            n = rng.randrange(1, 6)
            result = self.commit(undo=n)
            if not states:
                # no history: undo degenerates to a plain commit
                noop.append(current == {})
                states.append(dict(current))
                ids.append(result["committed"])
                self.assertEqual(result["undone"], [])
                self.assertEqual(result["skipped"], [])
                return
            n_eff = min(n, len(states))
            base = states[len(states) - n_eff - 1] if n_eff < len(states) else {}
            window_ids = ids[len(ids) - n_eff :]
            window_noop = noop[len(noop) - n_eff :]
            expected_undone = [
                cid for cid, flag in zip(window_ids, window_noop) if not flag
            ][::-1]
            expected_skipped = [
                cid for cid, flag in zip(window_ids, window_noop) if flag
            ][::-1]
            self.assertEqual(result["undone"], expected_undone)
            self.assertEqual(result["skipped"], expected_skipped)
            noop.append(base == states[-1])
            states.append(dict(base))
            ids.append(result["committed"])
            current = dict(base)

        ops = [model_write] * 6 + [model_mkdir] * 3 + [model_delete] * 3
        ops += [model_commit] * 5 + [model_undo] * 3
        for _step in range(200):
            rng.choice(ops)()
            # node-by-node comparison of the working tree against the model
            self.assertEqual(snapshot_disk(self.root), current)

        # final full comparison, including the committed head snapshot
        self.assertEqual(snapshot_disk(self.root), current)
        store = core.Store(self.snap)
        chain = store.load_chain()
        self.assertEqual(len(chain), len(states))
        head_nodes = store.read_tree(chain[-1]["id"])
        model_nodes = {
            path: (kind, core.hash_file(self.root / path) if kind == "file" else None)
            for path, (kind, *_) in current.items()
        }
        for path, (kind, _) in model_nodes.items():
            self.assertIn(path, head_nodes)
            self.assertEqual(head_nodes[path][0], kind)
        self.assertEqual(len(head_nodes), len(model_nodes))


# ---------------------------------------------------------------------------
# Acceptance B: undo across sibling branches


class TestSiblingUndo(HierosyncCase):
    def test_sibling_branches_untouched(self):
        self.write("a/file.txt", "a-v1")
        self.write("b/file.txt", "b-v1")
        self.commit()

        self.write("a/file.txt", "a-v2")
        self.commit()  # touches only branch a

        self.write("b/file.txt", "b-v2")
        result_c3 = self.commit()  # touches only branch b

        # Undo the last commit (branch b change): branch a must keep its
        # v2 content, branch b returns to v1.
        result = self.commit(undo=1)
        self.assertEqual(result["undone"], [result_c3["committed"]])
        self.assertEqual((self.root / "a/file.txt").read_text(), "a-v2")
        self.assertEqual((self.root / "b/file.txt").read_text(), "b-v1")

        # Undo the three most recent commits (the undo commit itself, c3
        # and c2): a's change is reverted as well, and the sibling of
        # ROOT on disk is never touched.
        outside = self.tmp / "outside.txt"
        outside.write_text("untouched")
        result = self.commit(undo=3)
        self.assertEqual(len(result["undone"]), 3)
        self.assertEqual((self.root / "a/file.txt").read_text(), "a-v1")
        self.assertEqual((self.root / "b/file.txt").read_text(), "b-v1")
        self.assertEqual(outside.read_text(), "untouched")

        # head snapshot agrees with the working tree, node by node
        nodes = self.head_nodes()
        self.assertEqual(
            sorted(nodes), ["a", "a/file.txt", "b", "b/file.txt"]
        )


# ---------------------------------------------------------------------------
# Acceptance C: interleaved undo of creates and deletes is deterministic


class TestInterleaved(HierosyncCase):
    def build_sequence(self):
        # c1: create dir d/ with a file, plus empty dir e/
        self.write("d/keep.txt", "keep")
        (self.root / "e").mkdir()
        c1 = self.commit()
        # c2: delete d/keep.txt (d becomes empty), create y.txt inside e/
        (self.root / "d/keep.txt").unlink()
        self.write("e/y.txt", "y")
        c2 = self.commit()
        # undo c2: keep.txt restored, e/y.txt removed, e/ kept (pre-existing)
        u1 = self.commit(undo=1)
        self.assertEqual(u1["undone"], [c2["committed"]])
        self.assertTrue((self.root / "d/keep.txt").is_file())
        self.assertTrue((self.root / "e").is_dir())
        self.assertEqual(list((self.root / "e").iterdir()), [])
        # undo the whole interleaved window (u1, c2, c1): d/ and e/ were
        # created by the undone commit c1 -> removed entirely
        u2 = self.commit(undo=3)
        self.assertEqual(
            u2["undone"], [u1["committed"], c2["committed"], c1["committed"]]
        )
        self.assertFalse((self.root / "d").exists())
        self.assertFalse((self.root / "e").exists())
        store = core.Store(self.snap)
        chain = store.load_chain()
        return snapshot_disk(self.root), [m["tree_hash"] for m in chain]

    def test_interleaved_sequence_is_deterministic(self):
        final_state, chain_hashes = self.build_sequence()
        self.assertEqual(final_state, {})
        self.assertEqual(len(chain_hashes), 4)  # c1, c2, u1, u2

    def test_replay_gives_identical_result(self):
        first = self.build_sequence()
        # replay in a second, independent sandbox
        replay_root = self.tmp / "root2"
        replay_snap = self.tmp / "snap2"
        replay_root.mkdir()
        saved_root, saved_snap = self.root, self.snap
        self.root, self.snap = replay_root, replay_snap
        try:
            second = self.build_sequence()
        finally:
            self.root, self.snap = saved_root, saved_snap
        self.assertEqual(first, second)

    def test_empty_dir_created_by_undone_commit_removed_otherwise_kept(self):
        # empty dir created by an undone commit -> deleted
        (self.root / "fresh").mkdir()
        self.commit()
        self.write("fresh/f.txt", "f")
        self.commit()
        self.commit(undo=2)
        self.assertFalse((self.root / "fresh").exists())

        # empty dir that predates the undone commits -> preserved
        (self.root / "old").mkdir()
        self.commit()
        self.write("old/g.txt", "g")
        self.commit()
        self.commit(undo=1)
        self.assertTrue((self.root / "old").is_dir())
        self.assertEqual(list((self.root / "old").iterdir()), [])


# ---------------------------------------------------------------------------
# Acceptance D: corrupt parent pointers -> exit code 5, no new snapshot


class TestCorruption(HierosyncCase):
    def make_history(self):
        self.write("a.txt", "1")
        self.commit()
        self.write("a.txt", "2")
        self.commit()
        self.write("a.txt", "3")
        self.commit()

    def commit_files(self):
        return sorted(p.name for p in (self.snap / "commits").iterdir())

    def test_cyclic_parent_pointer(self):
        self.make_history()
        before = self.commit_files()
        head_id = (self.snap / "HEAD").read_text().strip()
        meta_path = self.snap / "commits" / f"{head_id}.json"
        meta = json.loads(meta_path.read_text())
        meta["parent"] = head_id  # self-cycle
        meta_path.write_text(json.dumps(meta))

        self.commit(expect_code=EXIT_CORRUPTION)
        self.assertEqual(self.commit_files(), before)  # no new snapshot
        self.assertEqual((self.snap / "HEAD").read_text().strip(), head_id)

    def test_dangling_parent_pointer(self):
        self.make_history()
        before = self.commit_files()
        head_id = (self.snap / "HEAD").read_text().strip()
        meta_path = self.snap / "commits" / f"{head_id}.json"
        meta = json.loads(meta_path.read_text())
        meta["parent"] = "0" * 16  # dangling
        meta_path.write_text(json.dumps(meta))

        self.commit(expect_code=EXIT_CORRUPTION)
        self.assertEqual(self.commit_files(), before)

    def test_malformed_commit_file(self):
        self.make_history()
        before = self.commit_files()
        head_id = (self.snap / "HEAD").read_text().strip()
        (self.snap / "commits" / f"{head_id}.json").write_text("{not json")

        proc = run_cli(self.root, self.snap, undo=1)
        self.assertEqual(proc.returncode, EXIT_CORRUPTION)
        self.assertIn("corrupt", proc.stderr)
        self.assertEqual(self.commit_files(), before)

    def test_corrupt_head_file(self):
        self.make_history()
        before = self.commit_files()
        (self.snap / "HEAD").write_text("deadbeefdeadbeef\n")
        self.commit(expect_code=EXIT_CORRUPTION)
        self.assertEqual(self.commit_files(), before)

    def test_tampered_tree_hash(self):
        self.make_history()
        before = self.commit_files()
        head_id = (self.snap / "HEAD").read_text().strip()
        meta_path = self.snap / "commits" / f"{head_id}.json"
        meta = json.loads(meta_path.read_text())
        meta["tree_hash"] = "0" * 64
        meta_path.write_text(json.dumps(meta))
        self.commit(expect_code=EXIT_CORRUPTION)
        self.assertEqual(self.commit_files(), before)


# ---------------------------------------------------------------------------
# Unit tests


class TestUnits(HierosyncCase):
    def test_hash_dir_entries_deterministic_order(self):
        kids = [("b", "file", "1"), ("a", "dir", "2")]
        self.assertEqual(
            core.hash_dir_entries(kids), core.hash_dir_entries(list(reversed(kids)))
        )

    def test_scan_tree_includes_empty_dirs(self):
        (self.root / "empty" / "nested").mkdir(parents=True)
        self.write("f.txt", "x")
        nodes, tree_hash = core.scan_tree(self.root)
        self.assertIn("empty", nodes)
        self.assertIn("empty/nested", nodes)
        core.verify_nodes(nodes, tree_hash)  # must not raise

    def test_undo_beyond_history_clamps_to_empty(self):
        self.write("a.txt", "1")
        self.commit()
        result = self.commit(undo=99)
        self.assertEqual(len(result["undone"]), 1)
        self.assertEqual(snapshot_disk(self.root), {})

    def test_noop_commit_lands_in_skipped_on_undo(self):
        self.write("a.txt", "1")
        self.commit()
        noop_commit = self.commit()  # no changes
        result = self.commit(undo=1)
        self.assertEqual(result["undone"], [])
        self.assertEqual(result["skipped"], [noop_commit["committed"]])

    def test_undo_with_no_history_is_plain_commit(self):
        self.write("a.txt", "1")
        result = self.commit(undo=3)
        self.assertEqual(result["undone"], [])
        self.assertEqual(result["skipped"], [])
        self.assertIsNotNone(result["committed"])

    def test_store_inside_root_rejected(self):
        proc = run_cli(self.root, self.root / "snap")
        self.assertEqual(proc.returncode, 2)
        self.assertNotEqual(proc.stderr, "")

    def test_missing_root_rejected(self):
        proc = run_cli(self.tmp / "nope", self.snap)
        self.assertEqual(proc.returncode, 2)

    def test_negative_undo_rejected(self):
        proc = run_cli(self.root, self.snap, undo=-1)
        self.assertEqual(proc.returncode, 2)

    def test_timestamps_strictly_increase(self):
        self.write("a.txt", "1")
        for _ in range(5):
            self.commit()
        store = core.Store(self.snap)
        chain = store.load_chain()
        stamps = [m["timestamp"] for m in chain]
        self.assertEqual(stamps, sorted(stamps))
        self.assertEqual(len(set(stamps)), len(stamps))
        self.assertEqual([m["seq"] for m in chain], list(range(len(chain))))

    def test_stdout_json_shape(self):
        self.write("a.txt", "1")
        proc = run_cli(self.root, self.snap)
        payload = json.loads(proc.stdout)
        self.assertEqual(set(payload), {"committed", "undone", "skipped"})


if __name__ == "__main__":
    unittest.main()
