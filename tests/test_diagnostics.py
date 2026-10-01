"""Diagnostics tests: shadowing (A), overlap warnings (B), unreachable vs
shadowed (C), and independence of evaluation from diagnostics."""

import unittest

from shadowc import compile_source


class TestShadow(unittest.TestCase):
    def test_interval_shadow(self):
        compiled = compile_source(
            "field port: int\n"
            "action allow\n"
            "action deny\n"
            "rule first when port in 1..100 then allow\n"
            "rule second when port in 10..50 then deny\n"
        )
        diags = [d for d in compiled.diagnostics if d.code == "E_SHADOW"]
        self.assertEqual(len(diags), 1)
        self.assertEqual(diags[0].rule, "second")
        self.assertEqual(diags[0].related, "first")
        self.assertEqual(diags[0].severity, "error")
        self.assertEqual((diags[0].line, diags[0].col), (5, 1))

    def test_prefix_wildcard_shadow(self):
        compiled = compile_source(
            "field proto: string\n"
            "action allow\n"
            "action deny\n"
            'rule broad when proto == "tcp*" then allow\n'
            'rule narrow when proto == "tcp" then deny\n'
        )
        diags = [d for d in compiled.diagnostics if d.code == "E_SHADOW"]
        self.assertEqual(len(diags), 1)
        self.assertEqual((diags[0].rule, diags[0].related), ("narrow", "broad"))

    def test_identical_rule_is_shadowed(self):
        compiled = compile_source(
            "field port: int\n"
            "action allow\n"
            "rule a when port == 1 then allow\n"
            "rule b when port == 1 then allow\n"
        )
        self.assertEqual([d.code for d in compiled.diagnostics], ["E_SHADOW"])

    def test_earlier_rule_never_shadowed(self):
        compiled = compile_source(
            "field port: int\n"
            "action allow\n"
            "rule narrow when port in 1..10 then allow\n"
            "rule broad when port in 1..100 then allow\n"
        )
        # broad contains narrow, but narrow came first: no shadow, and
        # containment means no overlap warning either.
        self.assertEqual(compiled.diagnostics, [])


class TestOverlapWarningOnly(unittest.TestCase):
    def test_partial_overlap_warns_but_does_not_fail(self):
        compiled = compile_source(
            "field port: int\n"
            "action allow\n"
            "action deny\n"
            "rule r1 when port in 1..100 then allow\n"
            "rule r2 when port in 50..200 then deny\n"
        )
        self.assertEqual(len(compiled.diagnostics), 1)
        diag = compiled.diagnostics[0]
        self.assertEqual(diag.code, "W_OVERLAP")
        self.assertEqual(diag.severity, "warning")
        self.assertEqual((diag.rule, diag.related), ("r2", "r1"))
        self.assertFalse(
            any(d.severity == "error" for d in compiled.diagnostics),
            "partial overlap must not produce error diagnostics",
        )

    def test_disjoint_rules_are_quiet(self):
        compiled = compile_source(
            "field port: int\n"
            "action allow\n"
            "rule r1 when port in 1..100 then allow\n"
            "rule r2 when port in 101..200 then allow\n"
        )
        self.assertEqual(compiled.diagnostics, [])


class TestUnreachableVsShadow(unittest.TestCase):
    def test_union_coverage_is_unreachable_not_shadowed(self):
        compiled = compile_source(
            "field port: int\n"
            "action allow\n"
            "action deny\n"
            "rule a when port in 1..50 then allow\n"
            "rule b when port in 51..100 then allow\n"
            "rule c when port in 1..100 then deny\n"
        )
        c_diags = [d for d in compiled.diagnostics if d.rule == "c"]
        self.assertEqual([d.code for d in c_diags], ["E_UNREACHABLE"])
        self.assertNotIn("E_SHADOW", [d.code for d in compiled.diagnostics])

    def test_unsatisfiable_condition_is_unreachable(self):
        compiled = compile_source(
            "field port: int\n"
            "action allow\n"
            "rule d when port in 1..10 and not port in 1..10 then allow\n"
        )
        self.assertEqual([d.code for d in compiled.diagnostics], ["E_UNREACHABLE"])
        self.assertIn("unsatisfiable", compiled.diagnostics[0].message)

    def test_partially_covered_rule_is_reachable(self):
        compiled = compile_source(
            "field port: int\n"
            "action allow\n"
            "rule a when port in 1..50 then allow\n"
            "rule b when port in 40..100 then allow\n"
        )
        # b is only partially covered by a: warning, not unreachable.
        self.assertEqual([d.code for d in compiled.diagnostics], ["W_OVERLAP"])


class TestEvaluationIndependentOfDiagnostics(unittest.TestCase):
    POLICY = (
        "field port: int\n"
        "action allow\n"
        "action deny\n"
        "action log\n"
        "rule first when port in 1..100 then allow\n"
        "rule second when port in 10..50 then deny\n"
        "rule third when port in 50..200 then log\n"
    )

    def test_first_match_wins_despite_diagnostics(self):
        compiled = compile_source(self.POLICY)
        self.assertTrue(compiled.diagnostics)  # shadow + overlap present
        self.assertEqual(len(compiled.rules), 3)  # table keeps every rule
        self.assertEqual(compiled.evaluate({"port": 10}), ["allow"])
        self.assertEqual(compiled.evaluate({"port": 150}), ["log"])
        self.assertIsNone(compiled.evaluate({"port": 500}))

    def test_report_does_not_change_evaluation(self):
        compiled = compile_source(self.POLICY)
        before = {p: compiled.evaluate({"port": p}) for p in (10, 60, 150, 500)}
        compiled.report()  # computing the report must not mutate anything
        after = {p: compiled.evaluate({"port": p}) for p in (10, 60, 150, 500)}
        self.assertEqual(before, after)

    def test_missing_input_field_raises(self):
        compiled = compile_source(self.POLICY)
        with self.assertRaises(ValueError):
            compiled.evaluate({})


if __name__ == "__main__":
    unittest.main()
