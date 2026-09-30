#!/usr/bin/env python3
"""unittest suite for incdel: fault-injection recovery vs an in-memory model."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import incdel
from incdel import CrashError, Store, tokenize

CLI = [sys.executable, os.path.join(HERE, "incdel.py")]


class Model:
    """Reference in-memory model of committed state."""

    def __init__(self):
        self.docs = {}

    def add(self, doc_id, text):
        self.docs[doc_id] = text

    def delete(self, doc_id):
        self.docs.pop(doc_id, None)

    def search(self, query):
        terms = incdel.parse_query(query)
        return sorted(doc_id for doc_id, text in self.docs.items()
                      if all(t in tokenize(text) for t in terms))


class StoreTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = self.tmp.name

    def reopen(self, crash_at=None):
        return Store(self.dir, crash_at=crash_at)


class TestFaultInjection(StoreTestBase):
    """A: inject each of the three fault points, recover, compare with model."""

    def _seed(self, model):
        store = self.reopen()
        store.add("a", "the quick brown fox")
        store.add("b", "lazy dogs and quick cats")
        store.add("c", "hello world")
        self.assertTrue(store.commit())
        model.add("a", "the quick brown fox")
        model.add("b", "lazy dogs and quick cats")
        model.add("c", "hello world")
        store.delete("a")
        store.add("d", "world of quick ideas")
        self.assertTrue(store.commit())
        model.delete("a")
        model.add("d", "world of quick ideas")
        return store

    def _assert_matches_model(self, model):
        store = self.reopen()
        self.assertEqual(store.dump(), model.docs)
        for query in ("quick", "world AND quick", "hello", "fox"):
            self.assertEqual(store.search(query), model.search(query), query)

    def test_crash_pre_rename_rolls_back(self):
        model = Model()
        self._seed(model)
        store = self.reopen(crash_at="pre_rename")
        store.add("e", "uncommitted phantom")
        store.delete("b")
        with self.assertRaises(CrashError) as ctx:
            store.commit()
        self.assertEqual(str(ctx.exception), "pre_rename")
        # Model unchanged: the crashed commit must be rolled back entirely.
        self._assert_matches_model(model)
        # Rolled-back segment file must be gone after recovery.
        segs = [f for f in os.listdir(self.dir) if f.startswith("seg_")]
        self.assertEqual(sorted(segs), ["seg_000001.json", "seg_000002.json"])
        self.assertFalse(os.path.exists(os.path.join(self.dir, "manifest.tmp")))
        # The index still works afterwards.
        store = self.reopen()
        store.add("e", "committed this time")
        self.assertTrue(store.commit())
        model.add("e", "committed this time")
        self._assert_matches_model(model)

    def test_crash_post_rename_exposes_new_state(self):
        model = Model()
        self._seed(model)
        store = self.reopen(crash_at="post_rename")
        store.add("e", "fresh committed doc")
        store.delete("b")
        with self.assertRaises(CrashError) as ctx:
            store.commit()
        self.assertEqual(str(ctx.exception), "post_rename")
        # Rename already happened: new state is the last complete commit.
        model.add("e", "fresh committed doc")
        model.delete("b")
        self._assert_matches_model(model)
        # No leftover pending log double-applying ops on next commit.
        store = self.reopen()
        store.add("f", "another doc")
        self.assertTrue(store.commit())
        model.add("f", "another doc")
        self._assert_matches_model(model)

    def test_crash_merge_mid_no_half_state(self):
        model = Model()
        self._seed(model)
        store = self.reopen(crash_at="merge_mid")
        with self.assertRaises(CrashError) as ctx:
            store.merge()
        self.assertEqual(str(ctx.exception), "merge_mid")
        # Logical content identical to model; never half-new/half-old.
        self._assert_matches_model(model)
        # Recovery cleaned up the superseded old segments.
        store = self.reopen()
        self.assertEqual(store.segments, ["seg_000003.json"])
        segs = [f for f in os.listdir(self.dir) if f.startswith("seg_")]
        self.assertEqual(segs, ["seg_000003.json"])
        # Index fully usable after the interrupted merge.
        store.add("g", "post crash add")
        self.assertTrue(store.commit())
        model.add("g", "post crash add")
        self._assert_matches_model(model)

    def test_crash_pre_rename_during_merge_keeps_old_segments(self):
        model = Model()
        self._seed(model)
        store = self.reopen(crash_at="pre_rename")
        with self.assertRaises(CrashError):
            store.merge()
        self._assert_matches_model(model)
        store = self.reopen()
        self.assertEqual(store.segments, ["seg_000001.json", "seg_000002.json"])
        # Merge can be retried successfully.
        self.assertTrue(store.merge())
        self._assert_matches_model(model)


class TestSemantics(StoreTestBase):
    """B: delete of missing id, duplicate add, merge invariance."""

    def test_delete_nonexistent_id(self):
        store = self.reopen()
        store.delete("ghost")  # tombstone for an id that never existed
        self.assertTrue(store.commit())
        store.add("x", "real document")
        self.assertTrue(store.commit())
        self.assertEqual(self.reopen().dump(), {"x": "real document"})
        self.assertTrue(self.reopen().merge())
        self.assertEqual(self.reopen().dump(), {"x": "real document"})

    def test_duplicate_add_latest_wins(self):
        store = self.reopen()
        store.add("k", "version one")
        self.assertTrue(store.commit())
        store.add("k", "version two")
        store.add("k", "version three")
        self.assertTrue(store.commit())
        self.assertEqual(self.reopen().dump(), {"k": "version three"})
        self.assertEqual(self.reopen().search("three"), ["k"])
        self.assertEqual(self.reopen().search("one"), [])

    def test_merge_preserves_results(self):
        store = self.reopen()
        store.add("a", "alpha beta gamma")
        store.add("b", "beta delta")
        store.add("c", "gamma delta beta")
        self.assertTrue(store.commit())
        store.delete("b")
        store.add("a", "alpha only")
        self.assertTrue(store.commit())
        before_dump = self.reopen().dump()
        before = {q: self.reopen().search(q) for q in ("alpha", "beta", "delta", "gamma")}
        self.assertTrue(self.reopen().merge())
        after_dump = self.reopen().dump()
        after = {q: self.reopen().search(q) for q in before}
        self.assertEqual(before_dump, after_dump)
        self.assertEqual(before, after)
        self.assertEqual(after_dump, {"a": "alpha only", "c": "gamma delta beta"})
        # Tombstone physically removed: merged segment has no 'del' ops.
        with open(os.path.join(self.dir, "seg_000003.json")) as fh:
            ops = json.load(fh)["ops"]
        self.assertTrue(all(op[0] == "add" for op in ops))

    def test_readd_after_delete_and_recovery(self):
        store = self.reopen()
        store.add("z", "first life")
        self.assertTrue(store.commit())
        store.delete("z")
        self.assertTrue(store.commit())
        self.assertEqual(self.reopen().dump(), {})
        store.add("z", "second life")
        self.assertTrue(store.commit())
        self.assertEqual(self.reopen().dump(), {"z": "second life"})
        self.assertTrue(self.reopen().merge())
        self.assertEqual(self.reopen().dump(), {"z": "second life"})
        self.assertEqual(self.reopen().search("second"), ["z"])


class TestEmptyAndCorruption(StoreTestBase):
    """C: empty-db commit/merge; corrupt segment warn/skip; corrupt manifest."""

    def test_empty_commit_and_merge(self):
        store = self.reopen()
        self.assertFalse(store.commit())  # nothing to commit
        self.assertFalse(store.merge())   # nothing to merge
        self.assertEqual(self.reopen().dump(), {})
        self.assertEqual(self.reopen().search("anything"), [])

    def test_corrupt_segment_skipped_with_warning(self):
        store = self.reopen()
        store.add("good", "clean doc")
        self.assertTrue(store.commit())
        store.add("bad", "will be corrupted")
        self.assertTrue(store.commit())
        with open(os.path.join(self.dir, "seg_000002.json"), "w") as fh:
            fh.write("{not json!")
        recovered = self.reopen()
        self.assertEqual(recovered.dump(), {"good": "clean doc"})
        self.assertTrue(any("corrupt segment seg_000002.json" in w
                            for w in recovered.warnings))

    def test_corrupt_manifest_raises(self):
        store = self.reopen()
        store.add("a", "doc")
        self.assertTrue(store.commit())
        with open(os.path.join(self.dir, "manifest.json"), "w") as fh:
            fh.write("###broken###")
        with self.assertRaises(incdel.ManifestCorrupt):
            self.reopen()


class TestCLI(StoreTestBase):
    def run_cli(self, *args, env_extra=None):
        env = dict(os.environ)
        if env_extra:
            env.update(env_extra)
        return subprocess.run(CLI + ["--dir", self.dir] + list(args),
                              capture_output=True, text=True, env=env)

    def test_cli_happy_path(self):
        self.assertEqual(self.run_cli("add", "1", "red apple").returncode, 0)
        self.assertEqual(self.run_cli("add", "2", "green pear").returncode, 0)
        r = self.run_cli("commit")
        self.assertEqual(r.returncode, 0)
        self.assertIn("committed", r.stdout)
        r = self.run_cli("search", "apple")
        self.assertEqual(r.stdout.strip(), "1")
        self.assertEqual(self.run_cli("del", "1").returncode, 0)
        self.run_cli("commit")
        self.assertEqual(self.run_cli("search", "apple").stdout.strip(), "")
        self.assertEqual(self.run_cli("merge").returncode, 0)
        self.assertEqual(self.run_cli("search", "pear").stdout.strip(), "2")

    def test_cli_query_syntax_error_exit3(self):
        self.run_cli("add", "1", "some text")
        self.run_cli("commit")
        for bad in ("", "AND apple", "apple AND", "apple AND AND pear", "apple pear", "!!"):
            r = self.run_cli("search", *bad.split())
            self.assertEqual(r.returncode, 3, bad)
            self.assertIn("bad query", r.stderr)

    def test_cli_corrupt_manifest_exit4(self):
        self.run_cli("add", "1", "text")
        self.run_cli("commit")
        with open(os.path.join(self.dir, "manifest.json"), "w") as fh:
            fh.write("garbage{")
        r = self.run_cli("search", "text")
        self.assertEqual(r.returncode, 4)
        self.assertIn("corrupt manifest", r.stderr)

    def test_cli_crash_injection_and_recovery(self):
        self.run_cli("add", "1", "stable doc")
        self.run_cli("commit")
        self.run_cli("add", "2", "doomed doc")
        r = self.run_cli("commit", env_extra={"INCDEL_CRASH_AT": "pre_rename"})
        self.assertEqual(r.returncode, 75)
        self.assertIn("pre_rename", r.stderr)
        # Recovery: rolled back to the last complete commit.
        r = self.run_cli("dump")
        self.assertEqual(r.returncode, 0)
        self.assertIn("stable doc", r.stdout)
        self.assertNotIn("doomed doc", r.stdout)

    def test_cli_empty_db(self):
        r = self.run_cli("commit")
        self.assertEqual(r.returncode, 0)
        self.assertIn("nothing to commit", r.stdout)
        r = self.run_cli("merge")
        self.assertEqual(r.returncode, 0)
        self.assertIn("nothing to merge", r.stdout)


if __name__ == "__main__":
    unittest.main()
