"""Acceptance B: undo spanning sibling branches leaves siblings untouched."""

import os

from helpers import RepoTestCase, run_ok


class TestSiblingIsolation(RepoTestCase):
    def test_undo_spans_sibling_commit_but_preserves_it(self):
        self.write("a/x.txt", "a-v1")
        self.write("b/y.txt", "b-v1")
        run_ok(self.repo, self.snap)  # c1: baseline

        self.write("a/x.txt", "a-v2")
        c2 = run_ok(self.repo, self.snap)["committed"]  # c2: touches a only

        self.write("b/y.txt", "b-v2")
        c3 = run_ok(self.repo, self.snap)["committed"]  # c3: touches b only

        self.write("a/x.txt", "a-v3")
        c4 = run_ok(self.repo, self.snap)["committed"]  # c4: touches a only

        # Undo the last 2 commits (c4, c3) restricted to subtree a.
        out = run_ok(os.path.join(self.repo, "a"), self.snap, undo=2)
        self.assertEqual(out["undone"], [c4])
        self.assertEqual(out["skipped"], [c3])

        # Subtree a rolled back to its state as of c2.
        self.assertEqual(self.read("a/x.txt"), b"a-v2")
        # Sibling b keeps c3's change.
        self.assertEqual(self.read("b/y.txt"), b"b-v2")

    def test_deep_nesting_sibling_untouched(self):
        self.write("p/q/r/file.txt", "deep-v1")
        self.write("p/s/other.txt", "sib-v1")
        run_ok(self.repo, self.snap)
        self.write("p/q/r/file.txt", "deep-v2")
        self.write("p/s/other.txt", "sib-v2")
        run_ok(self.repo, self.snap)
        run_ok(os.path.join(self.repo, "p", "q"), self.snap, undo=1)
        self.assertEqual(self.read("p/q/r/file.txt"), b"deep-v1")
        self.assertEqual(self.read("p/s/other.txt"), b"sib-v2")

    def test_root_undo_affects_everything(self):
        self.write("a/x.txt", "1")
        self.write("b/y.txt", "1")
        run_ok(self.repo, self.snap)
        self.write("a/x.txt", "2")
        self.write("b/y.txt", "2")
        run_ok(self.repo, self.snap)
        run_ok(self.repo, self.snap, undo=1)
        self.assertEqual(self.read("a/x.txt"), b"1")
        self.assertEqual(self.read("b/y.txt"), b"1")
