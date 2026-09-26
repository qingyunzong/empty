import tempfile
import unittest
from pathlib import Path

from search_audit.auditor import audit
from search_audit.generator import generate
from search_audit.store import Dataset


class AuditorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "data"
        generate(self.root, num_docs=12, seed=3)

    def _snapshot(self):
        return {p.relative_to(self.root): p.read_bytes()
                for p in sorted(self.root.rglob("*")) if p.is_file()}

    def test_clean_dataset_has_no_issues(self):
        report = audit(self.root)
        self.assertTrue(report.ok, [i.subject for i in report.issues])

    def test_audit_is_readonly(self):
        before = self._snapshot()
        audit(self.root)
        self.assertEqual(before, self._snapshot())

    def test_orphan_doc_reference_counted_once(self):
        ds = Dataset.load(self.root)
        doc_id = sorted(ds.docstore["docs"])[0]
        n_refs = sum(1 for p in ds.index["postings"].values() if doc_id in p)
        self.assertGreater(n_refs, 1)  # referenced by many posting lists
        (self.root / ds.docstore["docs"].pop(doc_id)["path"]).unlink()
        ds.save()

        report = audit(self.root)
        orphans = [i for i in report.issues if i.kind == "ORPHAN_DOC_REFERENCE"]
        self.assertEqual(len(orphans), 1)  # one root problem, not n_refs
        self.assertEqual(orphans[0].doc, doc_id)
        # the same deleted doc must not reappear as stale postings
        self.assertFalse(any(i.kind == "STALE_POSTING" and i.doc == doc_id
                             for i in report.issues))

    def test_missing_lexicon_entry(self):
        ds = Dataset.load(self.root)
        term = sorted(ds.lexicon["terms"])[0]
        del ds.lexicon["terms"][term]
        ds.save()
        issues = [i for i in audit(self.root).issues
                  if i.kind == "MISSING_LEXICON_ENTRY"]
        self.assertEqual([i.term for i in issues], [term])

    def test_orphan_lexicon_entry(self):
        ds = Dataset.load(self.root)
        ds.lexicon["terms"]["ghost000"] = {"term_id": 9999, "df": 0}
        ds.save()
        issues = [i for i in audit(self.root).issues
                  if i.kind == "ORPHAN_LEXICON_ENTRY"]
        self.assertEqual([i.term for i in issues], ["ghost000"])

    def test_df_mismatch(self):
        ds = Dataset.load(self.root)
        term = sorted(ds.lexicon["terms"])[0]
        ds.lexicon["terms"][term]["df"] += 5
        ds.save()
        issues = [i for i in audit(self.root).issues if i.kind == "DF_MISMATCH"]
        self.assertEqual([i.term for i in issues], [term])

    def test_stale_posting(self):
        ds = Dataset.load(self.root)
        postings = ds.index["postings"]
        term = sorted(postings)[0]
        doc_id = next(d for d in sorted(ds.docstore["docs"])
                      if d not in postings[term])
        postings[term].append(doc_id)
        postings[term].sort()
        ds.save()
        issues = [i for i in audit(self.root).issues if i.kind == "STALE_POSTING"]
        self.assertEqual([(i.term, i.doc) for i in issues], [(term, doc_id)])

    def test_missing_posting(self):
        ds = Dataset.load(self.root)
        postings = ds.index["postings"]
        term = sorted(postings)[0]
        doc_id = postings[term][0]
        postings[term].remove(doc_id)
        ds.save()
        issues = [i for i in audit(self.root).issues
                  if i.kind == "MISSING_POSTING"]
        self.assertEqual([(i.term, i.doc) for i in issues], [(term, doc_id)])

    def test_missing_doc_file(self):
        ds = Dataset.load(self.root)
        doc_id = sorted(ds.docstore["docs"])[0]
        (self.root / ds.docstore["docs"][doc_id]["path"]).unlink()
        issues = [i for i in audit(self.root).issues
                  if i.kind == "MISSING_DOC_FILE"]
        self.assertEqual([i.doc for i in issues], [doc_id])

    def test_orphan_doc_file(self):
        (self.root / "docs" / "doc_9999.txt").write_text(
            "搜索 索引 term000", encoding="utf-8")
        issues = [i for i in audit(self.root).issues
                  if i.kind == "ORPHAN_DOC_FILE"]
        self.assertEqual([i.doc for i in issues], ["doc_9999"])

    def test_stats_mismatch(self):
        ds = Dataset.load(self.root)
        ds.stats["total_tokens"] += 42
        ds.save()
        issues = [i for i in audit(self.root).issues
                  if i.kind == "STATS_MISMATCH"]
        self.assertEqual([i.stat for i in issues], ["total_tokens"])

    def test_doc_length_mismatch(self):
        ds = Dataset.load(self.root)
        doc_id = sorted(ds.docstore["docs"])[0]
        ds.docstore["docs"][doc_id]["length"] += 1
        ds.save()
        issues = [i for i in audit(self.root).issues
                  if i.kind == "DOC_LENGTH_MISMATCH"]
        self.assertEqual([i.doc for i in issues], [doc_id])


if __name__ == "__main__":
    unittest.main()
