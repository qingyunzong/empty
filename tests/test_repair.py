import tempfile
import unittest

from src import builder
from src.audit import Auditor
from src.repair import BaselineMismatchError, apply_plan, build_plan
from src.workspace import COMPONENTS, Workspace

DOCS = {
    "d1": "apple banana apple\n",
    "d2": "banana cherry\n",
    "d3": "apple cherry 中文\n",
}


def make_workspace(root):
    ws = Workspace(root)
    ws.docs_dir.mkdir(parents=True)
    for doc_id, text in DOCS.items():
        (ws.docs_dir / f"{doc_id}.txt").write_text(text, encoding="utf-8")
    builder.build(ws)
    return ws


def edit(ws, name, fn):
    payload = ws.load(name)
    fn(payload)
    ws.save(name, payload)


def snapshot(ws):
    return {name: ws.component_path(name).read_bytes() for name in COMPONENTS}


class RepairTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = make_workspace(self.tmp.name)

    def corrupt(self):
        # d1: dropped from the manifest; file + postings remain
        edit(self.ws, "docstore", lambda p: p["docs"].pop("d1"))
        # d2: file deleted; manifest + postings remain
        (self.ws.docs_dir / "d2.txt").unlink()
        # tampered df and stats
        edit(self.ws, "lexicon",
             lambda p: p["terms"]["apple"].__setitem__("df", 7))
        edit(self.ws, "stats", lambda p: p.__setitem__("total_tokens", 999))
        # ghost lexicon entry and unknown term_id in the index
        def ghost(p):
            p["terms"]["ghost"] = {"term_id": "T000100", "df": 2, "cf": 9}
        edit(self.ws, "lexicon", ghost)
        edit(self.ws, "index",
             lambda p: p["postings"].__setitem__("T999999", ["d3"]))

    def test_plan_binds_baseline_version_and_fingerprint(self):
        report = Auditor(self.ws).run()
        plan = build_plan(self.ws, report)
        self.assertEqual(plan["baseline_version"], 1)
        self.assertEqual(plan["baseline_fingerprint"], self.ws.fingerprint())

    def test_apply_refused_when_content_moved(self):
        self.corrupt()
        plan = build_plan(self.ws, Auditor(self.ws).run())
        edit(self.ws, "stats", lambda p: p.__setitem__("total_tokens", 1000))
        before = snapshot(self.ws)
        with self.assertRaises(BaselineMismatchError):
            apply_plan(self.ws, plan)
        self.assertEqual(before, snapshot(self.ws))  # nothing written

    def test_apply_refused_when_version_moved(self):
        self.corrupt()
        plan = build_plan(self.ws, Auditor(self.ws).run())
        plan["baseline_version"] = 999  # fingerprint still matches
        with self.assertRaises(BaselineMismatchError):
            apply_plan(self.ws, plan)

    def test_full_repair_cycle(self):
        self.corrupt()
        report = Auditor(self.ws).run()
        self.assertFalse(report.ok)
        plan = build_plan(self.ws, report)
        new_version = apply_plan(self.ws, plan)
        self.assertEqual(new_version, 2)
        final = Auditor(self.ws).run()
        self.assertTrue(final.ok, final.render_text())
        # d2 forgotten, d1 re-registered, ghost + unknown term_id dropped
        self.assertNotIn("d2", self.ws.load("docstore")["docs"])
        self.assertIn("d1", self.ws.load("docstore")["docs"])
        self.assertNotIn("ghost", self.ws.load("lexicon")["terms"])
        self.assertNotIn("T999999", self.ws.load("index")["postings"])

    def test_clean_audit_yields_empty_plan(self):
        report = Auditor(self.ws).run()
        plan = build_plan(self.ws, report)
        self.assertEqual(plan["ops"], [])

    def test_version_bumps_on_each_build(self):
        self.assertEqual(builder.build(self.ws), 2)
        self.assertEqual(self.ws.common_version(), 2)


if __name__ == "__main__":
    unittest.main()
