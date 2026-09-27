"""Unittest suite for incdel: fault-injection recovery vs. an in-memory
model, tombstone/segment semantics, empty-db edge cases and error exits."""

import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import incdel
from incdel import (CrashFault, Index, ManifestCorrupt, arm_fault,
                    EXIT_OK, EXIT_QUERY_SYNTAX, EXIT_MANIFEST_CORRUPT,
                    EXIT_CRASH, MANIFEST_TMP_NAME)

INCDEL_PY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "incdel.py")


class Model:
    """Reference in-memory model: id -> latest visible text."""

    def __init__(self):
        self.docs = {}

    def add(self, doc_id, text):
        self.docs[doc_id] = text

    def delete(self, doc_id):
        self.docs.pop(doc_id, None)

    def search(self, query):
        terms = [t.lower() for t in query.split()]
        return sorted(i for i, text in self.docs.items()
                      if all(t in {tok.lower() for tok in text.split()}
                             for t in terms))


class IncdelTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name
        arm_fault(None)

    def tearDown(self):
        arm_fault(None)
        self._tmp.cleanup()

    def seg_files(self):
        return sorted(f for f in os.listdir(self.dir) if f.endswith(".seg"))

    # ---------- A. fault injection: recovery vs. in-memory model ----------

    def test_crash_before_rename_rolls_back(self):
        idx = Index(self.dir)
        idx.add("a", "hello world")
        idx.commit()
        model = Model()
        model.add("a", "hello world")

        idx.add("b", "second document")
        idx.delete("a")
        arm_fault("before_rename")
        with self.assertRaises(CrashFault) as ctx:
            idx.commit()
        self.assertEqual(ctx.exception.point, "before_rename")
        # model: uncommitted ops are lost, roll back to last complete commit

        recovered = Index(self.dir)
        self.assertEqual(recovered.visible_docs(), model.docs)
        self.assertEqual(recovered.search("hello"), ["a"])
        self.assertEqual(recovered.search("second"), [])
        # junk rolled back: no tmp files, no orphan segment
        entries = os.listdir(self.dir)
        self.assertFalse(any(f.endswith(".tmp") for f in entries))
        self.assertEqual(self.seg_files(), ["seg_000000.seg"])
        # rolled-back pending ops must not resurrect on later clean loads
        again = Index(self.dir)
        self.assertEqual(again.visible_docs(), model.docs)

    def test_crash_after_rename_new_state_visible(self):
        idx = Index(self.dir)
        idx.add("a", "hello world")
        idx.commit()
        model = Model()
        model.add("a", "hello world")

        idx.add("b", "second document")
        idx.delete("a")
        arm_fault("after_rename")
        with self.assertRaises(CrashFault) as ctx:
            idx.commit()
        self.assertEqual(ctx.exception.point, "after_rename")
        # rename already happened: the new commit IS the visible state
        model.add("b", "second document")
        model.delete("a")

        recovered = Index(self.dir)
        self.assertEqual(recovered.visible_docs(), model.docs)
        self.assertEqual(recovered.search("second"), ["b"])
        self.assertEqual(recovered.search("hello"), [])

    def test_crash_merge_mid_no_partial_state(self):
        idx = Index(self.dir)
        idx.add("a", "alpha text")
        idx.commit()
        idx.add("b", "beta text")
        idx.commit()
        idx.delete("a")
        idx.commit()
        model = Model()
        model.add("b", "beta text")

        arm_fault("merge_mid")
        with self.assertRaises(CrashFault) as ctx:
            idx.merge()
        self.assertEqual(ctx.exception.point, "merge_mid")

        recovered = Index(self.dir)
        # never half-old/half-new: exactly the model state
        self.assertEqual(recovered.visible_docs(), model.docs)
        self.assertEqual(recovered.search("beta"), ["b"])
        self.assertEqual(recovered.search("alpha"), [])
        # fully merged: exactly one segment, tombstones cleared, no orphans
        self.assertEqual(len(self.seg_files()), 1)
        self.assertEqual(recovered.tombstones, {})
        with open(os.path.join(self.dir, self.seg_files()[0]),
                  encoding="utf-8") as fh:
            blob = fh.read()
        self.assertNotIn('"a"', blob.replace('"alpha text"', ''))
        self.assertIn("beta text", blob)

    def test_crash_before_rename_during_merge_keeps_old_state(self):
        idx = Index(self.dir)
        idx.add("a", "alpha text")
        idx.commit()
        idx.add("b", "beta text")
        idx.commit()
        arm_fault("before_rename")
        with self.assertRaises(CrashFault):
            idx.merge()
        recovered = Index(self.dir)
        self.assertEqual(recovered.visible_docs(),
                         {"a": "alpha text", "b": "beta text"})
        self.assertEqual(len(self.seg_files()), 2)  # old segments intact

    # ---------- B. semantics ----------

    def test_delete_nonexistent_id_then_add(self):
        idx = Index(self.dir)
        idx.delete("ghost")           # deleting an unknown id is a no-op tombstone
        idx.commit()
        self.assertEqual(idx.search("anything"), [])
        idx.add("ghost", "now it exists")
        idx.commit()
        self.assertEqual(idx.search("now"), ["ghost"])
        recovered = Index(self.dir)
        self.assertEqual(recovered.search("now"), ["ghost"])

    def test_duplicate_add_latest_wins(self):
        idx = Index(self.dir)
        idx.add("x", "old text")
        idx.add("x", "new text")      # same id twice before commit
        idx.commit()
        self.assertEqual(idx.search("new"), ["x"])
        self.assertEqual(idx.search("old"), [])
        idx.add("x", "third text")    # and again across commits
        idx.commit()
        recovered = Index(self.dir)
        self.assertEqual(recovered.visible_docs(), {"x": "third text"})
        self.assertEqual(recovered.search("new"), [])

    def test_merge_preserves_results(self):
        idx = Index(self.dir)
        idx.add("1", "the quick brown fox")
        idx.add("2", "lazy dog sleeps")
        idx.commit()
        idx.delete("1")
        idx.add("3", "quick silver")
        idx.commit()
        queries = ["quick", "dog", "fox", "silver", "quick silver"]
        before = {q: idx.search(q) for q in queries}
        idx.merge()
        after = {q: idx.search(q) for q in queries}
        self.assertEqual(before, after)
        recovered = Index(self.dir)
        self.assertEqual(after, {q: recovered.search(q) for q in queries})
        # tombstoned id physically removed by merge
        with open(os.path.join(self.dir, self.seg_files()[0]),
                  encoding="utf-8") as fh:
            self.assertNotIn("brown fox", fh.read())

    def test_readd_after_delete_recovery_and_merge(self):
        idx = Index(self.dir)
        idx.add("k", "version one")
        idx.commit()
        idx.delete("k")
        idx.commit()
        self.assertEqual(idx.visible_docs(), {})
        idx.add("k", "version two")   # same id re-added after tombstone
        idx.commit()
        recovered = Index(self.dir)
        self.assertEqual(recovered.visible_docs(), {"k": "version two"})
        recovered.merge()
        again = Index(self.dir)
        self.assertEqual(again.visible_docs(), {"k": "version two"})
        self.assertEqual(again.search("version"), ["k"])
        self.assertEqual(again.search("one"), [])

    # ---------- C. empty database ----------

    def test_empty_commit_and_merge(self):
        idx = Index(self.dir)
        idx.commit()                  # commit with nothing staged
        idx.merge()                   # merge an empty index
        self.assertEqual(idx.search("anything"), [])
        self.assertEqual(idx.visible_docs(), {})
        recovered = Index(self.dir)
        self.assertEqual(recovered.visible_docs(), {})
        self.assertEqual(self.seg_files(), [])

    # ---------- D. errors ----------

    def test_corrupt_segment_skipped_with_warning(self):
        idx = Index(self.dir)
        idx.add("a", "first segment doc")
        idx.commit()
        idx.add("b", "second segment doc")
        idx.commit()
        victim = os.path.join(self.dir, "seg_000000.seg")
        with open(victim, "r+b") as fh:
            fh.seek(10)
            fh.write(b"#")            # corrupt payload -> checksum mismatch
        recovered = Index(self.dir)
        self.assertTrue(any("corrupt segment" in w for w in recovered.warnings))
        self.assertEqual(recovered.visible_docs(), {"b": "second segment doc"})

    def test_corrupt_manifest_exit4(self):
        idx = Index(self.dir)
        idx.add("a", "hello")
        idx.commit()
        with open(os.path.join(self.dir, "manifest.json"), "w") as fh:
            fh.write("{not valid json")
        with self.assertRaises(ManifestCorrupt):
            Index(self.dir)
        rc = incdel.main(["--dir", self.dir, "search", "hello"])
        self.assertEqual(rc, EXIT_MANIFEST_CORRUPT)

    def test_query_syntax_exit3(self):
        idx = Index(self.dir)
        idx.add("a", "hello world")
        idx.commit()
        self.assertEqual(incdel.main(["--dir", self.dir, "search", "!!!"]),
                         EXIT_QUERY_SYNTAX)
        self.assertEqual(incdel.main(["--dir", self.dir, "search", ""]),
                         EXIT_QUERY_SYNTAX)
        self.assertEqual(incdel.main(["--dir", self.dir, "search", "hello"]),
                         EXIT_OK)

    # ---------- E. CLI end-to-end with env-var fault injection ----------

    def run_cli(self, *args, env_extra=None):
        env = dict(os.environ)
        if env_extra:
            env.update(env_extra)
        return subprocess.run(
            [sys.executable, INCDEL_PY, "--dir", self.dir, *args],
            capture_output=True, text=True, env=env)

    def test_cli_fault_injection_and_recovery(self):
        self.assertEqual(self.run_cli("add", "a", "hello world").returncode, 0)
        self.assertEqual(self.run_cli("commit").returncode, 0)
        self.assertEqual(self.run_cli("add", "b", "second doc").returncode, 0)

        for point, expect_b in (("before_rename", False), ("after_rename", True)):
            crashed = self.run_cli("commit",
                                   env_extra={"INCDEL_FAIL_AT": point})
            self.assertEqual(crashed.returncode, EXIT_CRASH)
            self.assertIn(point, crashed.stderr)
            out = self.run_cli("dump").stdout.splitlines()
            ids = sorted(line.split("\t")[0] for line in out)
            self.assertEqual(ids, ["a", "b"] if expect_b else ["a"])
            if not expect_b:
                # rolled back: re-stage and commit for the next fault point
                self.assertEqual(self.run_cli("add", "b", "second doc").returncode, 0)

        # merge_mid via CLI
        self.assertEqual(self.run_cli("del", "a").returncode, 0)
        self.assertEqual(self.run_cli("commit").returncode, 0)
        crashed = self.run_cli("merge",
                               env_extra={"INCDEL_FAIL_AT": "merge_mid"})
        self.assertEqual(crashed.returncode, EXIT_CRASH)
        out = self.run_cli("dump").stdout
        self.assertNotIn("a\t", out)
        self.assertIn("b\tsecond doc", out)
        self.assertEqual(self.run_cli("search", "second").stdout.strip(), "b")


if __name__ == "__main__":
    unittest.main()
