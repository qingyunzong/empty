#!/usr/bin/env python3
"""Tests for minivcs. Run: python3 -m unittest -v"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(HERE, "minivcs.py")
sys.path.insert(0, HERE)

import minivcs
from minivcs import Repo, ancestors, find_lca, merge_trees


def run_cli(repo_dir, *args):
    proc = subprocess.run(
        [sys.executable, CLI, "--repo", repo_dir, *args],
        capture_output=True, text=True)
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


class CliTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.repo = Repo(self.dir)
        code, _, _ = run_cli(self.dir, "init")
        self.assertEqual(code, 0)

    def tearDown(self):
        self.tmp.cleanup()

    def commit(self, branch, message, sets=None, dels=None, parents=None):
        args = ["commit", "--branch", branch, "-m", message]
        for path, value in (sets or {}).items():
            args += ["--set", "%s=%s" % (path, value)]
        for path in (dels or []):
            args += ["--del", path]
        for parent in (parents or []):
            args += ["--parent", parent]
        code, out, err = run_cli(self.dir, *args)
        self.assertEqual(code, 0, err)
        return out  # commit hash

    def tree_of(self, h):
        return self.repo.load_commit(h)["tree"]

    def history_messages(self, tip):
        msgs = []
        h = tip
        while h:
            obj = self.repo.load_commit(h)
            msgs.append(obj["message"])
            h = obj["parents"][0] if obj["parents"] else None
        return msgs


class TestInitAndCommit(CliTestCase):
    def test_commit_object_shape(self):
        h = self.commit("main", "first", sets={"a.txt": "hello"})
        obj = self.repo.load_commit(h)
        self.assertEqual(obj["parents"], [])
        self.assertEqual(obj["message"], "first")
        self.assertEqual(obj["tree"], {"a.txt": "hello"})
        self.assertEqual(self.repo.read_ref("main"), h)

    def test_commit_chains_on_branch_tip(self):
        h1 = self.commit("main", "c1", sets={"a": "1"})
        h2 = self.commit("main", "c2", sets={"b": "2"})
        obj = self.repo.load_commit(h2)
        self.assertEqual(obj["parents"], [h1])
        self.assertEqual(obj["tree"], {"a": "1", "b": "2"})

    def test_commit_delete_path(self):
        self.commit("main", "c1", sets={"a": "1", "b": "2"})
        h2 = self.commit("main", "c2", dels=["a"])
        self.assertEqual(self.tree_of(h2), {"b": "2"})

    def test_commit_outside_repo_errors(self):
        with tempfile.TemporaryDirectory() as bare:
            code, _, _ = run_cli(bare, "commit", "--branch", "x", "-m", "m")
            self.assertEqual(code, 2)


class TestAncestorEnumeration(CliTestCase):
    """Independently enumerate ancestors for a diamond DAG of 8 commits."""

    def setUp(self):
        super().setUp()
        # a -> b -> d -> f -+
        #  \-> c -> e -> g -+-> h (merge)
        self.a = self.commit("main", "a", sets={"x": "a"})
        self.b = self.commit("main", "b", sets={"x": "b"}, parents=[self.a])
        self.c = self.commit("main", "c", sets={"x": "c"}, parents=[self.a])
        self.d = self.commit("main", "d", parents=[self.b])
        self.e = self.commit("main", "e", parents=[self.c])
        self.f = self.commit("main", "f", parents=[self.d])
        self.g = self.commit("main", "g", parents=[self.e])
        self.h = self.commit("main", "h", parents=[self.f, self.g])
        self.all = {"a": self.a, "b": self.b, "c": self.c, "d": self.d,
                    "e": self.e, "f": self.f, "g": self.g, "h": self.h}

    def naive_ancestors(self, tip):
        seen, stack = set(), [tip]
        while stack:
            h = stack.pop()
            if h in seen:
                continue
            seen.add(h)
            stack.extend(self.repo.load_commit(h)["parents"])
        return seen

    def test_ancestor_sets_match_independent_enumeration(self):
        for name, h in self.all.items():
            self.assertEqual(ancestors(self.repo, h), self.naive_ancestors(h),
                             "ancestor set mismatch at %s" % name)

    def test_expected_ancestor_sets(self):
        self.assertEqual(ancestors(self.repo, self.f),
                         {self.a, self.b, self.d, self.f})
        self.assertEqual(ancestors(self.repo, self.h), set(self.all.values()))

    def test_lca(self):
        self.assertEqual(find_lca(self.repo, self.f, self.g), self.a)
        self.assertEqual(find_lca(self.repo, self.h, self.d), self.d)
        self.assertEqual(find_lca(self.repo, self.b, self.c), self.a)

    def test_no_common_ancestor(self):
        other = self.commit("side", "root2", sets={"y": "1"}, parents=[])
        self.assertIsNone(find_lca(self.repo, self.h, other))


class TestThreeWayMerge(unittest.TestCase):
    def test_merge_expectations(self):
        cases = [
            # (base, ours, theirs, expected_tree, expected_conflicts)
            ({}, {}, {}, {}, []),
            ({"p": "b"}, {"p": "b"}, {"p": "t"}, {"p": "t"}, []),
            ({"p": "b"}, {"p": "o"}, {"p": "b"}, {"p": "o"}, []),
            ({"p": "b"}, {"p": "x"}, {"p": "x"}, {"p": "x"}, []),
            ({"p": "b"}, {"p": "o"}, {"p": "t"}, {}, ["p"]),
            ({"p": "b"}, {}, {"p": "t"}, {}, ["p"]),      # delete vs modify
            ({"p": "b"}, {"p": "o"}, {}, {}, ["p"]),      # modify vs delete
            ({"p": "b"}, {}, {}, {}, []),                 # both deleted
            ({}, {"p": "o"}, {}, {"p": "o"}, []),         # add on ours
            ({}, {}, {"p": "t"}, {"p": "t"}, []),         # add on theirs
            ({}, {"p": "x"}, {"p": "y"}, {}, ["p"]),      # add/add conflict
            ({"a": "1"}, {"a": "1", "b": "2"}, {"a": "1", "c": "3"},
             {"a": "1", "b": "2", "c": "3"}, []),         # disjoint adds
        ]
        for base, ours, theirs, want_tree, want_conf in cases:
            got_tree, got_conf = merge_trees(base, ours, theirs)
            self.assertEqual(got_tree, want_tree, (base, ours, theirs))
            self.assertEqual(got_conf, want_conf, (base, ours, theirs))


class TestFastForward(CliTestCase):
    def test_fast_forward(self):
        c1 = self.commit("F", "c1", sets={"a": "1"})
        c2 = self.commit("M", "c2", sets={"b": "2"}, parents=[c1])
        code, out, _ = run_cli(self.dir, "rebase", "--branch", "F",
                               "--onto", "M")
        self.assertEqual(code, 0)
        self.assertIn("fast-forward", out)
        self.assertEqual(self.repo.read_ref("F"), c2)
        self.assertFalse(self.repo.has_state())


class TestRebaseMerge(CliTestCase):
    def test_conflict_free_rebase(self):
        base = self.commit("main", "base", sets={"shared": "0"})
        f1 = self.commit("F", "f1", sets={"fa": "1"}, parents=[base])
        f2 = self.commit("F", "f2", sets={"fb": "2"}, parents=[f1])
        m1 = self.commit("M", "m1", sets={"ma": "9"}, parents=[base])

        code, _, _ = run_cli(self.dir, "rebase", "--branch", "F", "--onto", "M")
        self.assertEqual(code, 0)

        tip = self.repo.read_ref("F")
        self.assertEqual(self.history_messages(tip), ["f2", "f1", "m1", "base"])
        # independent merge expectation: union of disjoint changes
        self.assertEqual(self.tree_of(tip),
                         {"shared": "0", "fa": "1", "fb": "2", "ma": "9"})
        # replayed commits sit on top of the onto tip
        obj = self.repo.load_commit(tip)
        mid = obj["parents"][0]
        self.assertEqual(self.repo.load_commit(mid)["parents"], [m1])
        self.assertFalse(self.repo.has_state())
        # original commits untouched
        self.assertEqual(self.repo.load_commit(f2)["parents"], [f1])

    def test_no_common_ancestor_empty_base(self):
        f1 = self.commit("F", "f1", sets={"x": "1"})
        m1 = self.commit("M", "m1", sets={"y": "2"}, parents=[])
        code, _, _ = run_cli(self.dir, "rebase", "--branch", "F", "--onto", "M")
        self.assertEqual(code, 0)
        tip = self.repo.read_ref("F")
        self.assertEqual(self.tree_of(tip), {"x": "1", "y": "2"})
        self.assertEqual(self.history_messages(tip), ["f1", "m1"])


class TestConflictResolveContinue(CliTestCase):
    def setUp(self):
        super().setUp()
        self.base = self.commit("main", "base", sets={"p": "base", "q": "keep"})
        self.f1 = self.commit("F", "f1", sets={"p": "fval"}, parents=[self.base])
        self.m1 = self.commit("M", "m1", sets={"p": "mval"}, parents=[self.base])

    def test_conflict_then_resolve_then_continue(self):
        code, out, _ = run_cli(self.dir, "rebase", "--branch", "F",
                               "--onto", "M")
        self.assertEqual(code, 1)
        self.assertIn("p", out)
        self.assertTrue(self.repo.has_state())
        state = self.repo.load_state()
        self.assertEqual(state["current"], self.f1)
        self.assertEqual(state["conflicts"], ["p"])
        self.assertEqual(state["replayed"], [])
        # branch not moved yet
        self.assertEqual(self.repo.read_ref("F"), self.f1)

        code, _, _ = run_cli(self.dir, "resolve", "--set", "p=resolved")
        self.assertEqual(code, 0)
        code, _, _ = run_cli(self.dir, "continue")
        self.assertEqual(code, 0)

        tip = self.repo.read_ref("F")
        self.assertEqual(self.tree_of(tip),
                         {"p": "resolved", "q": "keep"})
        self.assertEqual(self.history_messages(tip), ["f1", "m1", "base"])
        self.assertFalse(self.repo.has_state())

    def test_continue_with_unresolved_conflict_stays_conflicted(self):
        run_cli(self.dir, "rebase", "--branch", "F", "--onto", "M")
        code, out, _ = run_cli(self.dir, "continue")
        self.assertEqual(code, 1)
        self.assertIn("p", out)
        self.assertTrue(self.repo.has_state())

    def test_modify_delete_conflict_resolved_by_delete(self):
        f_del = self.commit("F2", "fdel", dels=["p"], parents=[self.base])
        code, out, _ = run_cli(self.dir, "rebase", "--branch", "F2",
                               "--onto", "M")
        self.assertEqual(code, 1)
        self.assertIn("p", out)
        code, _, _ = run_cli(self.dir, "resolve", "--del", "p")
        self.assertEqual(code, 0)
        code, _, _ = run_cli(self.dir, "continue")
        self.assertEqual(code, 0)
        self.assertEqual(self.tree_of(self.repo.read_ref("F2")), {"q": "keep"})

    def test_abort_restores_branch_and_clears_state(self):
        run_cli(self.dir, "rebase", "--branch", "F", "--onto", "M")
        self.assertTrue(self.repo.has_state())
        code, _, _ = run_cli(self.dir, "abort")
        self.assertEqual(code, 0)
        self.assertEqual(self.repo.read_ref("F"), self.f1)
        self.assertFalse(self.repo.has_state())


class TestFailBeforeRef(CliTestCase):
    def setUp(self):
        super().setUp()
        self.base = self.commit("main", "base", sets={"s": "0"})
        self.f1 = self.commit("F", "f1", sets={"a": "1"}, parents=[self.base])
        self.f2 = self.commit("F", "f2", sets={"b": "2"}, parents=[self.f1])
        self.m1 = self.commit("M", "m1", sets={"c": "3"}, parents=[self.base])

    def crash_rebase(self):
        code, _, err = run_cli(self.dir, "rebase", "--branch", "F",
                               "--onto", "M", "--fail-before-ref", "1")
        self.assertEqual(code, 2)
        self.assertIn("simulated crash", err)
        # branch ref not written
        self.assertEqual(self.repo.read_ref("F"), self.f2)
        # state persisted with the first replayed commit recorded
        state = self.repo.load_state()
        self.assertEqual(len(state["replayed"]), 1)
        self.assertEqual(state["remaining"], [self.f2])
        return state

    def test_crash_then_continue_does_not_duplicate(self):
        state = self.crash_rebase()
        objects_before = set(self.repo.list_objects())
        self.assertIn(state["replayed"][0], objects_before)

        code, _, _ = run_cli(self.dir, "continue")
        self.assertEqual(code, 0)
        tip = self.repo.read_ref("F")
        # exactly one commit per original message: no duplicate replay
        self.assertEqual(self.history_messages(tip),
                         ["f2", "f1", "m1", "base"])
        self.assertEqual(self.tree_of(tip),
                         {"s": "0", "a": "1", "b": "2", "c": "3"})
        # the persisted pre-crash commit is reused as f1's replay
        parent_of_f2 = self.repo.load_commit(tip)["parents"][0]
        self.assertEqual(parent_of_f2, state["replayed"][0])
        self.assertFalse(self.repo.has_state())

    def test_crash_then_abort_restores(self):
        self.crash_rebase()
        code, _, _ = run_cli(self.dir, "abort")
        self.assertEqual(code, 0)
        self.assertEqual(self.repo.read_ref("F"), self.f2)
        self.assertFalse(self.repo.has_state())


class TestErrorExitCodes(CliTestCase):
    def test_continue_without_rebase(self):
        code, _, err = run_cli(self.dir, "continue")
        self.assertEqual(code, 2)
        self.assertIn("no rebase in progress", err)

    def test_abort_without_rebase(self):
        code, _, _ = run_cli(self.dir, "abort")
        self.assertEqual(code, 2)

    def test_rebase_unknown_branch(self):
        self.commit("M", "m1", sets={"a": "1"})
        code, _, _ = run_cli(self.dir, "rebase", "--branch", "NOPE",
                             "--onto", "M")
        self.assertEqual(code, 2)

    def test_rebase_while_in_progress(self):
        base = self.commit("main", "base", sets={"p": "b"})
        self.commit("F", "f1", sets={"p": "f"}, parents=[base])
        self.commit("M", "m1", sets={"p": "m"}, parents=[base])
        code, _, _ = run_cli(self.dir, "rebase", "--branch", "F", "--onto", "M")
        self.assertEqual(code, 1)
        code, _, err = run_cli(self.dir, "rebase", "--branch", "F",
                               "--onto", "M")
        self.assertEqual(code, 2)
        self.assertIn("already in progress", err)

    def test_resolve_without_conflict(self):
        code, _, _ = run_cli(self.dir, "resolve", "--set", "p=v")
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
