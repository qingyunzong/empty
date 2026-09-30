"""Acceptance C: interleaved undo-of-create and undo-of-delete is deterministic."""

import os
import shutil

from helpers import RepoTestCase, run_ok


class TestInterleavedUndo(RepoTestCase):
    def test_undo_delete_restores_file(self):
        self.write("f.txt", "content")
        run_ok(self.repo, self.snap)          # c1: create f
        os.remove(os.path.join(self.repo, "f.txt"))
        run_ok(self.repo, self.snap)          # c2: delete f
        out = run_ok(self.repo, self.snap, undo=1)  # undo the delete
        self.assertEqual(len(out["undone"]), 1)
        self.assertEqual(self.read("f.txt"), b"content")

    def test_undo_create_removes_file_and_dir(self):
        run_ok(self.repo, self.snap)          # c1: empty baseline
        self.write("d/f.txt", "x")
        run_ok(self.repo, self.snap)          # c2: create d/f.txt
        run_ok(self.repo, self.snap, undo=1)  # undo the create
        self.assertFalse(os.path.exists(os.path.join(self.repo, "d")))

    def test_undo_of_undo_is_deterministic(self):
        self.write("f.txt", "v1")
        run_ok(self.repo, self.snap)          # c1: create
        os.remove(os.path.join(self.repo, "f.txt"))
        run_ok(self.repo, self.snap)          # c2: delete
        run_ok(self.repo, self.snap, undo=1)  # c3: restore f
        self.assertEqual(self.read("f.txt"), b"v1")
        run_ok(self.repo, self.snap, undo=1)  # c4: undo c3 -> f gone again
        self.assertFalse(os.path.exists(os.path.join(self.repo, "f.txt")))
        run_ok(self.repo, self.snap, undo=1)  # c5: undo c4 -> f back
        self.assertEqual(self.read("f.txt"), b"v1")

    def test_interleaved_create_delete_sequence(self):
        self.write("f1.txt", "one")
        run_ok(self.repo, self.snap)          # c1: create f1
        self.write("f2.txt", "two")
        run_ok(self.repo, self.snap)          # c2: create f2
        os.remove(os.path.join(self.repo, "f1.txt"))
        run_ok(self.repo, self.snap)          # c3: delete f1
        # Undo c3 and c2: f1 restored (undo delete), f2 removed (undo create).
        run_ok(self.repo, self.snap, undo=2)
        self.assertEqual(self.read("f1.txt"), b"one")
        self.assertFalse(os.path.exists(os.path.join(self.repo, "f2.txt")))

    def test_sequence_replay_gives_identical_result(self):
        results = []
        for trial in range(2):
            repo = os.path.join(self.tmp, f"replay{trial}")
            snap = os.path.join(repo, ".hs")
            os.makedirs(repo)
            with open(os.path.join(repo, "f.txt"), "w") as fh:
                fh.write("data")
            run_ok(repo, snap)
            os.remove(os.path.join(repo, "f.txt"))
            run_ok(repo, snap)
            run_ok(repo, snap, undo=2)   # undo delete + create -> f gone
            run_ok(repo, snap, undo=2)   # undo the undo + the delete -> f restored
            entries = []
            for dirpath, dirnames, filenames in os.walk(repo):
                dirnames[:] = [d for d in dirnames if d != ".hs"]
                for name in sorted(filenames):
                    full = os.path.join(dirpath, name)
                    with open(full, "rb") as fh:
                        entries.append((os.path.relpath(full, repo), fh.read()))
            results.append(entries)
        self.assertEqual(results[0], results[1])
        self.assertEqual(results[0], [("f.txt", b"data")])
