"""End-to-end tests for minigit.py (Python 3.11 stdlib, unittest)."""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.abspath(__file__))
CLI = [sys.executable, os.path.join(ROOT, "minigit.py")]


class MiniGitCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="minigit-test-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.cli("init")

    # ---------- CLI helpers ----------

    def cli(self, *args, expect=0):
        proc = subprocess.run(CLI + list(args), cwd=self.dir,
                              capture_output=True, text=True)
        if expect is not None:
            self.assertEqual(proc.returncode, expect,
                             f"args={args}\nstdout={proc.stdout}\n"
                             f"stderr={proc.stderr}")
        return proc

    def commit(self, message, **files):
        args = ["commit", "-m", message]
        for path, text in files.items():
            args += ["--file", f"{path}={text}"]
        return self.cli(*args).stdout.strip()

    def filt(self, *extra, expect=0):
        return self.cli("filter", *extra, expect=expect)

    # ---------- repo inspection helpers ----------

    def cat(self, oid):
        proc = self.cli("cat-file", oid)
        obj_type, _, data = proc.stdout.partition("\n")
        return obj_type, data

    def commit_info(self, oid):
        obj_type, data = self.cat(oid)
        self.assertEqual(obj_type, "commit")
        header, _, message = data.partition("\n\n")
        info = {"tree": None, "parents": [], "message": message}
        for line in header.splitlines():
            key, _, value = line.partition(" ")
            if key == "tree":
                info["tree"] = value
            elif key == "parent":
                info["parents"].append(value)
        return info

    def tree_files(self, tree_oid, prefix=""):
        obj_type, data = self.cat(tree_oid)
        self.assertEqual(obj_type, "tree")
        files = {}
        for line in data.splitlines():
            kind, oid, name = line.split(" ", 2)
            if kind == "blob":
                btype, text = self.cat(oid)
                self.assertEqual(btype, "blob")
                files[prefix + name] = text
            else:
                files.update(self.tree_files(oid, prefix + name + "/"))
        return files

    def history(self):
        """List of (oid, commit_info) from HEAD backwards (tip first)."""
        out = self.cli("log").stdout.splitlines()
        result = []
        for line in out:
            oid = line.split(" ", 1)[0]
            result.append((oid, self.commit_info(oid)))
        return result

    def head_oid(self):
        with open(os.path.join(self.dir, ".minigit", "refs", "heads",
                               "main")) as fh:
            return fh.read().strip()

    def all_object_ids(self):
        ids = set()
        objects = os.path.join(self.dir, ".minigit", "objects")
        for root, _dirs, names in os.walk(objects):
            for name in names:
                ids.add(os.path.basename(root) + name)
        return ids

    def staging_exists(self):
        return os.path.exists(os.path.join(self.dir, ".minigit",
                                           "filter-staging"))


class TestCommitAndLog(MiniGitCase):
    def test_commit_multiple_paths_and_message(self):
        c1 = self.commit("first commit", **{"a.txt": "alpha",
                                            "dir/b.txt": "beta"})
        c2 = self.commit("second commit", **{"a.txt": "alpha2",
                                             "dir/b.txt": "beta",
                                             "dir/c.txt": "gamma"})
        hist = self.history()
        self.assertEqual([oid for oid, _ in hist], [c2, c1])
        self.assertEqual(hist[0][1]["parents"], [c1])
        self.assertEqual(hist[1][1]["parents"], [])
        self.assertEqual(hist[0][1]["message"], "second commit")
        self.assertEqual(self.tree_files(hist[0][1]["tree"]),
                         {"a.txt": "alpha2", "dir/b.txt": "beta",
                          "dir/c.txt": "gamma"})
        self.assertEqual(self.tree_files(hist[1][1]["tree"]),
                         {"a.txt": "alpha", "dir/b.txt": "beta"})


class TestFilterStripPrefix(MiniGitCase):
    def test_strip_prefix_across_commits(self):
        # 4 commits (<= 5), each a full snapshot.
        self.commit("add src files", **{
            "README.md": "readme", "src/a.txt": "a1", "src/b.txt": "b1"})
        self.commit("update a", **{
            "README.md": "readme", "src/a.txt": "a2", "src/b.txt": "b1"})
        self.commit("add docs", **{
            "README.md": "r2", "src/a.txt": "a2", "src/b.txt": "b1",
            "docs/d.txt": "doc"})
        self.commit("add c", **{
            "README.md": "r2", "src/a.txt": "a2", "src/b.txt": "b1",
            "docs/d.txt": "doc", "src/c.txt": "c"})

        self.filt("--strip-prefix", "src/")

        hist = self.history()
        self.assertEqual(len(hist), 4)
        # Parent chain is remapped to the new commits, tip-first order.
        for i in range(len(hist) - 1):
            self.assertEqual(hist[i][1]["parents"], [hist[i + 1][0]])
        self.assertEqual(hist[-1][1]["parents"], [])
        # Expected trees enumerated independently per node (oldest first).
        nodes = list(reversed(hist))
        self.assertEqual(self.tree_files(nodes[0][1]["tree"]),
                         {"README.md": "readme"})
        self.assertEqual(self.tree_files(nodes[1][1]["tree"]),
                         {"README.md": "readme"})
        self.assertEqual(self.tree_files(nodes[2][1]["tree"]),
                         {"README.md": "r2", "docs/d.txt": "doc"})
        self.assertEqual(self.tree_files(nodes[3][1]["tree"]),
                         {"README.md": "r2", "docs/d.txt": "doc"})
        # Messages untouched when no --message-regex is given.
        self.assertEqual([info["message"] for _, info in nodes],
                         ["add src files", "update a", "add docs", "add c"])

    def test_message_regex_replacement(self):
        self.commit("fix bug 123 and bug 456", **{"f.txt": "x"})
        self.commit("no match here", **{"f.txt": "y"})
        self.filt("--message-regex", r"bug (\d+)", "--replacement",
                  r"issue-\1")
        hist = self.history()
        # One re.sub pass: every occurrence replaced exactly once.
        self.assertEqual(hist[1][1]["message"],
                         "fix issue-123 and issue-456")
        self.assertEqual(hist[0][1]["message"], "no match here")


class TestFilterIdentity(MiniGitCase):
    def test_no_change_keeps_refs_and_object_ids(self):
        c1 = self.commit("keep me", **{"a.txt": "1", "d/b.txt": "2"})
        c2 = self.commit("keep me too", **{"a.txt": "1", "d/b.txt": "3"})
        c3 = self.commit("and me", **{"a.txt": "4", "d/b.txt": "3"})
        ref_before = self.head_oid()
        objects_before = self.all_object_ids()

        self.filt("--strip-prefix", "nosuchdir/",
                  "--message-regex", "zzz-not-present",
                  "--replacement", "x")

        self.assertEqual(self.head_oid(), ref_before)
        self.assertEqual(self.all_object_ids(), objects_before)
        self.assertFalse(self.staging_exists())
        self.assertEqual([oid for oid, _ in self.history()], [c3, c2, c1])


class TestFilterStaging(MiniGitCase):
    def build_history(self):
        self.commit("one", **{"keep.txt": "k1", "dir/x.txt": "x1"})
        self.commit("two", **{"keep.txt": "k1", "dir/x.txt": "x2",
                              "dir/y.txt": "y"})
        return self.commit("three", **{"keep.txt": "k2", "dir/x.txt": "x2",
                                       "dir/y.txt": "y"})

    def test_fail_after_objects_then_rerun(self):
        tip = self.build_history()
        objects_before = self.all_object_ids()

        proc = self.filt("--strip-prefix", "dir/", "--fail-after-objects",
                         expect=3)
        self.assertIn("fail-after-objects", proc.stdout)
        # Original ref untouched, staging present, main store untouched.
        self.assertEqual(self.head_oid(), tip)
        self.assertTrue(self.staging_exists())
        self.assertEqual(self.all_object_ids(), objects_before)

        # Rerun recovers from staging and completes.
        self.filt()
        self.assertFalse(self.staging_exists())
        hist = self.history()
        self.assertEqual(len(hist), 3)
        nodes = list(reversed(hist))
        self.assertEqual(self.tree_files(nodes[0][1]["tree"]),
                         {"keep.txt": "k1"})
        self.assertEqual(self.tree_files(nodes[1][1]["tree"]),
                         {"keep.txt": "k1"})
        self.assertEqual(self.tree_files(nodes[2][1]["tree"]),
                         {"keep.txt": "k2"})
        # No duplicate commits: 3 original + 3 rewritten, all distinct.
        commit_ids = [oid for oid in self.all_object_ids()
                      if self.cat(oid)[0] == "commit"]
        self.assertEqual(len(commit_ids), 6)
        self.assertEqual(len({oid for oid, _ in hist}), 3)
        self.assertTrue(tip in commit_ids)  # old objects still present
        # Running the same filter again is now an identity rewrite.
        ref_now = self.head_oid()
        objects_now = self.all_object_ids()
        self.filt("--strip-prefix", "dir/")
        self.assertEqual(self.head_oid(), ref_now)
        self.assertEqual(self.all_object_ids(), objects_now)

    def test_abort_clears_staging_and_keeps_history(self):
        tip = self.build_history()
        objects_before = self.all_object_ids()

        self.filt("--strip-prefix", "dir/", "--fail-after-objects", expect=3)
        self.assertTrue(self.staging_exists())

        self.filt("--abort")
        self.assertFalse(self.staging_exists())
        self.assertEqual(self.head_oid(), tip)
        self.assertEqual(self.all_object_ids(), objects_before)
        hist = self.history()
        self.assertEqual(len(hist), 3)
        self.assertEqual(self.tree_files(hist[0][1]["tree"]),
                         {"keep.txt": "k2", "dir/x.txt": "x2",
                          "dir/y.txt": "y"})
        self.assertEqual([info["message"] for _, info in hist],
                         ["three", "two", "one"])


class TestInvalidRegex(MiniGitCase):
    def test_invalid_regex_exits_2(self):
        tip = self.commit("msg", **{"a.txt": "1"})
        objects_before = self.all_object_ids()
        for bad in ("[", "(", "\\"):
            proc = self.filt("--message-regex", bad, expect=2)
            self.assertIn("invalid regex", proc.stderr)
        self.assertEqual(self.head_oid(), tip)
        self.assertEqual(self.all_object_ids(), objects_before)
        self.assertFalse(self.staging_exists())


if __name__ == "__main__":
    unittest.main()
