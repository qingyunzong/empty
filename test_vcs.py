#!/usr/bin/env python3
"""Tests for vcs.py. Ancestor enumeration and merge expectations are
computed independently here (not via vcs.py internals)."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

VCS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vcs.py")


# ---------- independent reference implementations ----------

def indep_ancestors(commits, cid):
    seen, stack = set(), [cid]
    while stack:
        cur = stack.pop()
        if cur not in seen:
            seen.add(cur)
            stack.extend(commits[cur]["parents"])
    return seen


def indep_lca(commits, a, b):
    common = indep_ancestors(commits, a) & indep_ancestors(commits, b)
    lowest = [c for c in common
              if not any(c != d and c in indep_ancestors(commits, d)
                         for d in common)]
    assert len(lowest) <= 1, "test graph must have a unique LCA"
    return lowest[0] if lowest else None


def indep_merge(base, ours, theirs):
    merged, conflicts = {}, []
    for p in set(base) | set(ours) | set(theirs):
        b, o, t = base.get(p), ours.get(p), theirs.get(p)
        if o == t:
            if o is not None:
                merged[p] = o
        elif b == o:
            if t is not None:
                merged[p] = t
        elif b == t:
            if o is not None:
                merged[p] = o
        else:
            conflicts.append(p)
    return merged, sorted(conflicts)


# ---------- test harness ----------

class VcsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = os.path.join(self.tmp.name, "repo")

    def cli(self, *args, check=None):
        proc = subprocess.run(
            [sys.executable, VCS, *args, "--repo", self.repo],
            capture_output=True, text=True)
        if check is not None:
            self.assertEqual(proc.returncode, check,
                             "args=%r\nstdout=%s\nstderr=%s"
                             % (args, proc.stdout, proc.stderr))
        return proc

    def init(self):
        self.cli("init", check=0)

    def commit(self, branch, message, parents=None, sets=None, deletes=None):
        args = ["commit", "--branch", branch, "-m", message]
        for p in parents or []:
            args += ["--parent", p]
        for kv in (sets or {}).items():
            args += ["--set", "%s=%s" % kv]
        for d in deletes or []:
            args += ["--delete", d]
        return self.cli(*args, check=0).stdout.strip()

    def ref(self, name):
        with open(os.path.join(self.repo, "refs", name)) as f:
            return f.read().strip()

    def commits(self):
        d = os.path.join(self.repo, "commits")
        result = {}
        for c in os.listdir(d):
            with open(os.path.join(d, c)) as f:
                result[c] = json.load(f)
        return result

    def tree(self, cid):
        return self.commits()[cid]["tree"]

    def state_exists(self):
        return os.path.exists(os.path.join(self.repo, "rebase_state.json"))

    def state(self):
        with open(os.path.join(self.repo, "rebase_state.json")) as f:
            return json.load(f)

    # ---------- tests ----------

    def test_init_and_commit_chain(self):
        self.init()
        c1 = self.cli("commit", "--branch", "main", "-m", "root",
                      "--set", "a=1", check=0).stdout.strip()
        c2 = self.commit("main", "second", sets={"b": "2"})
        commits = self.commits()
        self.assertEqual(commits[c1]["parents"], [])
        self.assertEqual(commits[c2]["parents"], [c1])
        self.assertEqual(commits[c2]["tree"], {"a": "1", "b": "2"})
        self.assertEqual(self.ref("main"), c2)

    def test_fast_forward(self):
        self.init()
        c1 = self.commit("main", "c1", sets={"a": "1"})
        c2 = self.commit("main", "c2", sets={"b": "2"})
        # feature points at c1 via a ref file written through a commit
        # on a fresh branch then rewound: simplest is direct ref write.
        with open(os.path.join(self.repo, "refs", "feature"), "w") as f:
            f.write(c1 + "\n")
        before = len(self.commits())
        out = self.cli("rebase", "--branch", "feature", "--onto", "main",
                       check=0)
        self.assertIn("fast-forward", out.stdout)
        self.assertEqual(self.ref("feature"), c2)
        self.assertEqual(len(self.commits()), before)  # no new commits
        self.assertFalse(self.state_exists())

    def test_up_to_date_noop(self):
        self.init()
        c1 = self.commit("main", "c1", sets={"a": "1"})
        c2 = self.commit("main", "c2", sets={"b": "2"})
        with open(os.path.join(self.repo, "refs", "old"), "w") as f:
            f.write(c1 + "\n")
        before = len(self.commits())
        self.cli("rebase", "--branch", "main", "--onto", "old", check=0)
        self.assertEqual(self.ref("main"), c2)
        self.assertEqual(len(self.commits()), before)

    def test_lca_with_merge_commit(self):
        # Diamond: c1 -> c2, c1 -> c3, c4 merges c2+c3; F = c5 on top of c2.
        self.init()
        c1 = self.commit("main", "c1", sets={"a": "1"})
        c2 = self.commit("main", "c2", sets={"a": "2"})
        c3 = self.commit("side", "c3", parents=[c1], sets={"b": "1"})
        c4 = self.commit("main", "c4", parents=[c2, c3])
        c5 = self.commit("feat", "c5", parents=[c2], sets={"c": "1"})
        commits = self.commits()
        # independent ancestor enumeration
        self.assertEqual(indep_ancestors(commits, c4),
                         {c1, c2, c3, c4})
        self.assertEqual(indep_lca(commits, c5, c4), c2)
        # rebase feat onto main: replay c5; base=tree(c2)
        self.cli("rebase", "--branch", "feat", "--onto", "main", check=0)
        expected, conflicts = indep_merge(commits[c2]["tree"],
                                          commits[c4]["tree"],
                                          commits[c5]["tree"])
        self.assertEqual(conflicts, [])
        self.assertEqual(self.tree(self.ref("feat")), expected)
        self.assertEqual(self.tree(self.ref("feat")),
                         {"a": "2", "b": "1", "c": "1"})

    def test_divergent_no_conflict(self):
        self.init()
        c1 = self.commit("main", "base", sets={"shared": "0", "k": "k"})
        m = self.commit("main", "m", sets={"mfile": "m", "shared": "m"})
        f1 = self.commit("feat", "f1", parents=[c1], sets={"f1": "1"})
        f2 = self.commit("feat", "f2", sets={"f2": "2"}, deletes=["k"])
        self.cli("rebase", "--branch", "feat", "--onto", "main", check=0)
        commits = self.commits()
        head = self.ref("feat")
        # independent expectation for the two replay steps
        exp1, c1_conf = indep_merge(commits[c1]["tree"], commits[m]["tree"],
                                    {"shared": "0", "k": "k", "f1": "1"})
        self.assertEqual(c1_conf, [])
        exp2, c2_conf = indep_merge({"shared": "0", "k": "k", "f1": "1"},
                                    exp1, {"shared": "0", "f1": "1", "f2": "2"})
        self.assertEqual(c2_conf, [])
        self.assertEqual(commits[head]["tree"], exp2)
        self.assertEqual(commits[head]["tree"],
                         {"shared": "m", "mfile": "m", "f1": "1", "f2": "2"})
        # replayed commits form a chain rooted at m
        new_f1 = [c for c, o in commits.items()
                  if o["message"] == "f1" and o["parents"] == [m]][0]
        self.assertEqual(commits[head]["parents"], [new_f1])

    def test_same_path_conflict_resolve_continue(self):
        self.init()
        c1 = self.commit("main", "base", sets={"x": "base", "keep": "1"})
        m = self.commit("main", "m", sets={"x": "theirs"})
        f = self.commit("feat", "f", parents=[c1], sets={"x": "ours"})
        proc = self.cli("rebase", "--branch", "feat", "--onto", "main",
                        check=1)
        self.assertIn("x", proc.stdout)
        # state saved: replayed commits, current commit, conflict paths
        st = self.state()
        self.assertEqual(st["done"], [])
        self.assertEqual(st["current"], f)
        self.assertEqual(st["conflicts"], ["x"])
        self.assertEqual(st["original_head"], f)
        self.assertEqual(self.ref("feat"), f)  # branch not moved
        # resolve then continue
        self.cli("resolve", "--set", "x=resolved", check=0)
        self.cli("continue", check=0)
        self.assertFalse(self.state_exists())
        head = self.ref("feat")
        self.assertNotEqual(head, f)
        self.assertEqual(self.tree(head), {"x": "resolved", "keep": "1"})
        self.assertEqual(self.commits()[head]["parents"], [m])
        self.assertEqual(self.commits()[head]["message"], "f")

    def test_modify_delete_conflict(self):
        self.init()
        c1 = self.commit("main", "base", sets={"f": "v", "g": "1"})
        m = self.commit("main", "m", deletes=["f"])
        f = self.commit("feat", "f", parents=[c1], sets={"f": "changed"})
        self.cli("rebase", "--branch", "feat", "--onto", "main", check=1)
        self.assertEqual(self.state()["conflicts"], ["f"])
        self.cli("resolve", "--set", "f=final", check=0)
        self.cli("continue", check=0)
        self.assertEqual(self.tree(self.ref("feat")), {"f": "final", "g": "1"})

    def test_abort_during_conflict(self):
        self.init()
        c1 = self.commit("main", "base", sets={"x": "0"})
        self.commit("main", "m", sets={"x": "m"})
        f = self.commit("feat", "f", parents=[c1], sets={"x": "f"})
        self.cli("rebase", "--branch", "feat", "--onto", "main", check=1)
        self.cli("abort", check=0)
        self.assertEqual(self.ref("feat"), f)
        self.assertFalse(self.state_exists())

    def test_no_common_ancestor(self):
        self.init()
        m = self.commit("main", "m", sets={"m": "1"})
        f1 = self.commit("feat", "f1", sets={"f": "1"})
        f2 = self.commit("feat", "f2", sets={"g": "1"})
        self.cli("rebase", "--branch", "feat", "--onto", "main", check=0)
        head = self.ref("feat")
        # empty tree as base; both feat commits replayed onto m
        self.assertEqual(self.tree(head), {"m": "1", "f": "1", "g": "1"})
        chain_root = [c for c, o in self.commits().items()
                      if o["message"] == "f1" and o["parents"] == [m]][0]
        self.assertEqual(self.commits()[head]["parents"], [chain_root])

    def test_fail_hook_then_continue_no_duplicates(self):
        self.init()
        c1 = self.commit("main", "base", sets={"a": "1"})
        m = self.commit("main", "m", sets={"m": "1"})
        f1 = self.commit("feat", "f1", parents=[c1], sets={"f1": "1"})
        f2 = self.commit("feat", "f2", sets={"f2": "1"})
        proc = self.cli("rebase", "--branch", "feat", "--onto", "main",
                        "--fail-before-ref", "1", check=2)
        self.assertIn("simulated crash", proc.stdout)
        # crash after 1st replayed commit persisted, before branch write
        self.assertEqual(self.ref("feat"), f2)  # branch untouched
        self.assertTrue(self.state_exists())
        st = self.state()
        self.assertEqual(len(st["done"]), 1)
        self.assertEqual(len(st["queue"]), 1)
        count_after_crash = len(self.commits())  # 4 original + 1 replayed
        self.assertEqual(count_after_crash, 5)
        # continue resumes; must not duplicate the persisted commit
        self.cli("continue", check=0)
        self.assertEqual(len(self.commits()), 6)  # exactly one more
        self.assertFalse(self.state_exists())
        head = self.ref("feat")
        self.assertEqual(self.tree(head),
                         {"a": "1", "m": "1", "f1": "1", "f2": "1"})
        # replayed chain: f2' -> f1' -> m
        commits = self.commits()
        new_f1 = commits[commits[head]["parents"][0]]
        self.assertEqual(new_f1["message"], "f1")
        self.assertEqual(new_f1["parents"], [m])

    def test_fail_hook_then_abort_restores(self):
        self.init()
        c1 = self.commit("main", "base", sets={"a": "1"})
        self.commit("main", "m", sets={"m": "1"})
        f1 = self.commit("feat", "f1", parents=[c1], sets={"f1": "1"})
        f2 = self.commit("feat", "f2", sets={"f2": "1"})
        self.cli("rebase", "--branch", "feat", "--onto", "main",
                 "--fail-before-ref", "2", check=2)
        self.assertEqual(self.ref("feat"), f2)
        self.cli("abort", check=0)
        self.assertEqual(self.ref("feat"), f2)
        self.assertFalse(self.state_exists())
        # after abort a fresh rebase succeeds
        self.cli("rebase", "--branch", "feat", "--onto", "main", check=0)
        self.assertEqual(self.tree(self.ref("feat")),
                         {"a": "1", "m": "1", "f1": "1", "f2": "1"})

    def test_errors(self):
        self.init()
        # rebase in a non-repo
        proc = subprocess.run([sys.executable, VCS, "rebase", "--branch",
                               "a", "--onto", "b", "--repo",
                               os.path.join(self.tmp.name, "nope")],
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 2)
        self.commit("main", "c1", sets={"a": "1"})
        # unknown branch
        self.cli("rebase", "--branch", "main", "--onto", "ghost", check=2)
        # continue/abort/resolve with no rebase in progress
        self.cli("continue", check=2)
        self.cli("abort", check=2)
        self.cli("resolve", "--set", "x=1", check=2)


if __name__ == "__main__":
    unittest.main()
