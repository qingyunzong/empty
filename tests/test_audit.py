import tempfile
import unittest

from src import builder
from src.audit import Auditor
from src.workspace import Workspace

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


class AuditTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = make_workspace(self.tmp.name)

    def codes(self, report):
        return [issue.code for issue in report.sorted_issues()]

    def test_clean_build_has_no_issues(self):
        report = Auditor(self.ws).run()
        self.assertTrue(report.ok, report.render_text())
        self.assertEqual(report.version, 1)

    def test_audit_is_read_only(self):
        before = {
            str(p): p.read_bytes()
            for p in sorted(self.ws.data_dir.rglob("*"))
            if p.is_file()
        }
        Auditor(self.ws).run()
        after = {
            str(p): p.read_bytes()
            for p in sorted(self.ws.data_dir.rglob("*"))
            if p.is_file()
        }
        self.assertEqual(before, after)

    def test_orphan_doc_ref_deduped_across_postings(self):
        # d1 is referenced by the postings of 'apple' and 'banana'.
        edit(self.ws, "docstore", lambda p: p["docs"].pop("d1"))
        (self.ws.docs_dir / "d1.txt").unlink()
        # keep stats consistent so only the dangling reference remains
        edit(self.ws, "stats", lambda p: p.update(num_docs=2, total_tokens=6))
        report = Auditor(self.ws).run()
        orphans = [i for i in report.sorted_issues() if i.code == "ORPHAN_DOC_REF"]
        self.assertEqual(len(orphans), 1, report.render_text())
        self.assertEqual(orphans[0].entity, "d1")
        term_evidence = [e for e in orphans[0].evidence if e.startswith("term_id=")]
        self.assertGreaterEqual(len(term_evidence), 2)
        # count discrepancies explained by the deleted doc are not extra issues
        self.assertNotIn("CF_MISMATCH", self.codes(report))
        self.assertNotIn("POSTINGS_DRIFT", self.codes(report))

    def test_missing_doc_file(self):
        (self.ws.docs_dir / "d2.txt").unlink()
        report = Auditor(self.ws).run()
        self.assertIn("MISSING_DOC_FILE", self.codes(report))
        self.assertTrue(any("skipped" in note for note in report.notes))

    def test_orphan_doc_file(self):
        (self.ws.docs_dir / "d9.txt").write_text("apple\n", encoding="utf-8")
        report = Auditor(self.ws).run()
        self.assertEqual(self.codes(report), ["ORPHAN_DOC_FILE"],
                         report.render_text())

    def test_df_mismatch(self):
        edit(self.ws, "lexicon",
             lambda p: p["terms"]["apple"].__setitem__("df", 5))
        report = Auditor(self.ws).run()
        self.assertEqual(self.codes(report), ["DF_MISMATCH"])

    def test_cf_mismatch(self):
        edit(self.ws, "lexicon",
             lambda p: p["terms"]["apple"].__setitem__("cf", 9))
        report = Auditor(self.ws).run()
        self.assertEqual(self.codes(report), ["CF_MISMATCH"])

    def test_stats_mismatch(self):
        edit(self.ws, "stats", lambda p: p.__setitem__("total_tokens", 999))
        report = Auditor(self.ws).run()
        self.assertEqual(self.codes(report), ["STATS_MISMATCH"])
        issue = report.sorted_issues()[0]
        self.assertEqual(issue.entity, "total_tokens")

    def test_orphan_lexicon_entry(self):
        def add_ghost(p):
            p["terms"]["ghost"] = {"term_id": "T000100", "df": 1, "cf": 0}
        edit(self.ws, "lexicon", add_ghost)
        edit(self.ws, "stats",
             lambda p: p.__setitem__("num_terms", p["num_terms"] + 1))
        report = Auditor(self.ws).run()
        self.assertEqual(self.codes(report), ["ORPHAN_LEXICON_ENTRY"],
                         report.render_text())

    def test_missing_lexicon_entry(self):
        edit(self.ws, "index",
             lambda p: p["postings"].__setitem__("T000099", ["d1"]))
        report = Auditor(self.ws).run()
        self.assertEqual(self.codes(report), ["MISSING_LEXICON_ENTRY"],
                         report.render_text())

    def test_term_id_collision(self):
        def collide(p):
            p["terms"]["中"]["term_id"] = p["terms"]["文"]["term_id"]
        edit(self.ws, "lexicon", collide)
        report = Auditor(self.ws).run()
        collisions = [i for i in report.sorted_issues()
                      if i.code == "TERM_ID_COLLISION"]
        self.assertEqual(len(collisions), 1, report.render_text())
        self.assertIn("中", collisions[0].evidence[0])
        self.assertIn("文", collisions[0].evidence[0])
        # the vacated term_id's postings are now dangling: exactly one
        # MISSING_LEXICON_ENTRY, not one per posting
        missing = [i for i in report.sorted_issues()
                   if i.code == "MISSING_LEXICON_ENTRY"]
        self.assertEqual(len(missing), 1)

    def test_postings_drift(self):
        lexicon = self.ws.load("lexicon")
        apple_id = lexicon["terms"]["apple"]["term_id"]
        edit(self.ws, "index", lambda p: p["postings"][apple_id].append("d2"))
        report = Auditor(self.ws).run()
        self.assertIn("POSTINGS_DRIFT", self.codes(report))
        self.assertIn("DF_MISMATCH", self.codes(report))

    def test_duplicate_posting(self):
        lexicon = self.ws.load("lexicon")
        apple_id = lexicon["terms"]["apple"]["term_id"]
        edit(self.ws, "index", lambda p: p["postings"][apple_id].append("d1"))
        report = Auditor(self.ws).run()
        self.assertIn("DUPLICATE_POSTING", self.codes(report))

    def test_version_skew_is_a_single_issue(self):
        edit(self.ws, "stats", lambda p: p.__setitem__("version", 99))
        report = Auditor(self.ws).run()
        self.assertEqual(self.codes(report), ["VERSION_SKEW"])

    def test_doc_content_drift(self):
        path = self.ws.docs_dir / "d1.txt"
        path.write_text("apple apple apple kiwi\n", encoding="utf-8")
        report = Auditor(self.ws).run()
        self.assertIn("DOC_CONTENT_DRIFT", self.codes(report))
        # drift-explained posting/count diffs are evidence, not new issues
        self.assertNotIn("POSTINGS_DRIFT", self.codes(report))
        self.assertNotIn("CF_MISMATCH", self.codes(report))


if __name__ == "__main__":
    unittest.main()
