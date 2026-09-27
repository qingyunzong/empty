#!/usr/bin/env python3
"""Acceptance tests for minigit (run with: python3 -m unittest -v)."""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(HERE, "minigit.py")
sys.path.insert(0, HERE)
import minigit  # noqa: E402


def run(root, *args):
    return subprocess.run(
        [sys.executable, CLI, "-C", root, *args],
        capture_output=True, text=True)


class MinigitTestCase(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="minigit-test-")
        self.addCleanup(shutil.rmtree, self.root, True)
        result = run(self.root, "init")
        self.assertEqual(result.returncode, 0, result.stderr)

    # ------------------------------------------------------------ helpers

    def commit(self, message, **path_texts):
        args = ["commit", "-m", message]
        for path, text in path_texts.items():
            args += ["-f", f"{path}={text}"]
        result = run(self.root, *args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def head(self):
        return minigit.read_ref(self.root)

    def objdir(self):
        return minigit.repo_path(self.root, "objects")

    def tree_paths(self, commit_oid):
        """{path: blob_text} for a commit's tree."""
        tree, _, _ = minigit.decode_commit(
            minigit.read_object(self.objdir(), commit_oid)[1])
        flat = minigit.flatten_tree(self.objdir(), tree)
        return {p: minigit.read_object(self.objdir(), b)[1].decode()
                for p, b in flat.items()}

    def commit_info(self, oid):
        tree, parents, message = minigit.decode_commit(
            minigit.read_object(self.objdir(), oid)[1])
        return parents, message

    def history(self, head=None):
        """Commit ids from head back to the root (linear history)."""
        head = head or self.head()
        chain = []
        oid = head
        while oid:
            chain.append(oid)
            parents, _ = self.commit_info(oid)
            self.assertLessEqual(len(parents), 1)
            oid = parents[0] if parents else None
        return chain

    def all_objects(self):
        found = {}
        for dirpath, _, filenames in os.walk(self.objdir()):
            for name in filenames:
                if name.endswith(".tmp"):
                    continue
                fanout = os.path.basename(dirpath)
                oid = fanout + name
                found[oid] = minigit.read_object(self.objdir(), oid)[0]
        return found

    def staging_exists(self):
        return os.path.exists(minigit.repo_path(self.root, "staging"))

    # ------------------------------------------------------------ tests

    def test_commit_multi_path_and_message(self):
        c1 = self.commit("first", **{"a.txt": "A", "dir/b.txt": "B"})
        self.assertEqual(self.head(), c1)
        self.assertEqual(self.tree_paths(c1),
                         {"a.txt": "A", "dir/b.txt": "B"})
        parents, message = self.commit_info(c1)
        self.assertEqual(parents, [])
        self.assertEqual(message, "first")
        c2 = self.commit("second", **{"dir/c.txt": "C"})
        self.assertEqual(self.tree_paths(c2),
                         {"a.txt": "A", "dir/b.txt": "B", "dir/c.txt": "C"})
        parents, message = self.commit_info(c2)
        self.assertEqual(parents, [c1])
        self.assertEqual(message, "second")

    def test_filter_strip_prefix_across_commits(self):
        c1 = self.commit("one", **{"dir/a.txt": "A", "keep1.txt": "K1"})
        c2 = self.commit("two", **{"dir/b.txt": "B"})
        c3 = self.commit("three", **{"keep2.txt": "K2"})
        c4 = self.commit("four", **{"dir/a.txt": "A2"})
        old_head = self.head()
        self.assertEqual(old_head, c4)

        result = run(self.root, "filter", "--strip-prefix", "dir/")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.staging_exists())

        chain = self.history()  # head-first
        self.assertEqual(len(chain), 4)
        self.assertNotEqual(self.head(), old_head)

        # Enumerate the expected tree of every node, root to head.
        expected = [
            (c1, {"keep1.txt": "K1"}, "one"),
            (c2, {"keep1.txt": "K1"}, "two"),
            (c3, {"keep1.txt": "K1", "keep2.txt": "K2"}, "three"),
            (c4, {"keep1.txt": "K1", "keep2.txt": "K2"}, "four"),
        ]
        for new_oid, (old_oid, want_tree, want_msg) in zip(
                reversed(chain), expected):
            self.assertNotEqual(new_oid, old_oid)
            self.assertEqual(self.tree_paths(new_oid), want_tree)
            _, message = self.commit_info(new_oid)
            self.assertEqual(message, want_msg)
        # Parent references must be remapped to the new commits.
        for child, parent in zip(chain, chain[1:]):
            parents, _ = self.commit_info(child)
            self.assertEqual(parents, [parent])
        parents, _ = self.commit_info(chain[-1])
        self.assertEqual(parents, [])

    def test_no_change_filter_preserves_ref_and_object_ids(self):
        self.commit("one", **{"a.txt": "A"})
        self.commit("two", **{"b.txt": "B"})
        self.commit("three", **{"c.txt": "C"})
        head_before = self.head()
        objects_before = self.all_objects()

        result = run(self.root, "filter",
                     "--strip-prefix", "absent/",
                     "--message-regex", "zzz",
                     "--replacement", "x")
        self.assertEqual(result.returncode, 0, result.stderr)

        self.assertEqual(self.head(), head_before)
        self.assertEqual(self.all_objects(), objects_before)
        self.assertFalse(self.staging_exists())

    def test_message_regex_replaced_once(self):
        self.commit("foo foo foo", **{"a.txt": "A"})
        self.commit("say foo and foo", **{"b.txt": "B"})
        result = run(self.root, "filter",
                     "--message-regex", "foo",
                     "--replacement", "bar")
        self.assertEqual(result.returncode, 0, result.stderr)
        chain = self.history()
        _, msg_head = self.commit_info(chain[0])
        _, msg_root = self.commit_info(chain[1])
        self.assertEqual(msg_head, "say bar and foo")  # exactly one sub
        self.assertEqual(msg_root, "bar foo foo")

    def test_fail_after_objects_then_resume(self):
        c1 = self.commit("one", **{"dir/a.txt": "A", "keep.txt": "K"})
        c2 = self.commit("two", **{"dir/b.txt": "B"})
        c3 = self.commit("three", **{"dir/c.txt": "C", "x.txt": "X"})
        old_head = self.head()
        old_objects = self.all_objects()

        result = run(self.root, "filter", "--strip-prefix", "dir/",
                     "--fail-after-objects")
        self.assertEqual(result.returncode, 3)
        self.assertEqual(self.head(), old_head)      # ref untouched
        self.assertTrue(self.staging_exists())
        self.assertEqual(self.all_objects(), old_objects)  # store untouched

        # Re-run resumes from the staging area and completes.
        result = run(self.root, "filter", "--strip-prefix", "dir/")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.staging_exists())

        chain = self.history()
        self.assertEqual(len(chain), 3)
        expected = [
            {"keep.txt": "K"},
            {"keep.txt": "K"},
            {"keep.txt": "K", "x.txt": "X"},
        ]
        for new_oid, want_tree in zip(reversed(chain), expected):
            self.assertEqual(self.tree_paths(new_oid), want_tree)

        # No duplicate commits: exactly the 3 old + 3 new commit objects,
        # old and new sets disjoint, each new commit unique.
        commits = {oid for oid, t in self.all_objects().items()
                   if t == "commit"}
        old_commits = {oid for oid, t in old_objects.items()
                       if t == "commit"}
        new_commits = commits - old_commits
        self.assertEqual(old_commits, {c1, c2, c3})
        self.assertEqual(new_commits, set(chain))
        self.assertEqual(len(commits), 6)

    def test_abort_discards_staging_and_keeps_history(self):
        self.commit("one", **{"dir/a.txt": "A"})
        self.commit("two", **{"dir/b.txt": "B"})
        old_head = self.head()
        old_objects = self.all_objects()

        result = run(self.root, "filter", "--strip-prefix", "dir/",
                     "--fail-after-objects")
        self.assertEqual(result.returncode, 3)
        self.assertTrue(self.staging_exists())

        result = run(self.root, "abort")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.staging_exists())
        self.assertEqual(self.head(), old_head)
        self.assertEqual(self.all_objects(), old_objects)
        # Original history still fully intact.
        chain = self.history(old_head)
        self.assertEqual(len(chain), 2)
        self.assertEqual(self.tree_paths(chain[0]),
                         {"dir/a.txt": "A", "dir/b.txt": "B"})

    def test_invalid_regex_exits_2(self):
        self.commit("one", **{"dir/a.txt": "A"})
        old_head = self.head()
        result = run(self.root, "filter", "--message-regex", "[")
        self.assertEqual(result.returncode, 2)
        self.assertIn("invalid regex", result.stderr)
        self.assertEqual(self.head(), old_head)
        self.assertFalse(self.staging_exists())


if __name__ == "__main__":
    unittest.main()
