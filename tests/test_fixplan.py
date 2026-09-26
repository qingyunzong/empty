import tempfile
import unittest
from pathlib import Path

from search_audit.corrupt import corrupt
from search_audit.fixplan import build_plan, validate_plan
from search_audit.generator import generate
from search_audit.store import Dataset


class FixPlanTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "data"
        generate(self.root, num_docs=16, seed=5)

    def _snapshot(self):
        return {p.relative_to(self.root): p.read_bytes()
                for p in sorted(self.root.rglob("*")) if p.is_file()}

    def test_clean_dataset_needs_no_plan(self):
        plan, report = build_plan(self.root)
        self.assertTrue(report.ok)
        self.assertEqual(plan, [])
        self.assertTrue(validate_plan(self.root, plan).ok)

    def test_plan_repairs_corrupted_dataset_and_preserves_baseline(self):
        corrupt(self.root, seed=11)
        baseline = self._snapshot()

        plan, report = build_plan(self.root)
        self.assertGreater(len(report.issues), 0)
        self.assertGreater(len(plan), 0)

        result = validate_plan(self.root, plan)
        self.assertEqual(result.residual_issues, [])
        self.assertEqual(result.unexpected_changes, [])
        self.assertTrue(result.ok)
        # validation works on a scratch copy: the baseline stays untouched
        self.assertEqual(baseline, self._snapshot())

    def test_plan_handles_orphan_file_and_missing_file(self):
        (self.root / "docs" / "doc_9999.txt").write_text(
            "搜索 索引 term000", encoding="utf-8")
        ds = Dataset.load(self.root)
        victim = sorted(ds.docstore["docs"])[0]
        (self.root / ds.docstore["docs"][victim]["path"]).unlink()

        plan, report = build_plan(self.root)
        kinds = {i.kind for i in report.issues}
        self.assertIn("ORPHAN_DOC_FILE", kinds)
        self.assertIn("MISSING_DOC_FILE", kinds)
        self.assertTrue(validate_plan(self.root, plan).ok)


if __name__ == "__main__":
    unittest.main()
