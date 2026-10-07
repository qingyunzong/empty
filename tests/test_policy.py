import unittest

from pathpolicy import (Policy, InclusionChecker, check_inclusion,
                        check_equivalent, find_difference, verify_certificate)


def pol(allow, deny=()):
    return Policy(allow, deny)


class InclusionTest(unittest.TestCase):
    def test_basic_inclusion_with_certificate(self):
        r = check_inclusion(pol(["a/**"]), pol(["**"]))
        self.assertEqual(r["result"], "included")
        self.assertEqual(r["certificate"]["type"], "inclusion-proof")
        self.assertTrue(verify_certificate(r["certificate"]))

    def test_not_included_witness_rechecked(self):
        r = check_inclusion(pol(["**"]), pol(["a/**"]))
        self.assertEqual(r["result"], "not_included")
        w = r["witness"]
        self.assertEqual(w["path"], w["normalized"])
        self.assertTrue(w["left_match"])
        self.assertFalse(w["right_match"])
        self.assertTrue(verify_certificate(r["certificate"]))

    def test_witness_is_shortest(self):
        r = check_inclusion(pol(["*"]), pol(["a"]))
        self.assertEqual(r["result"], "not_included")
        self.assertEqual(r["witness"]["path"], "/b")

    def test_difference_relative_to_legal_paths(self):
        r = check_inclusion(pol(["*"]), pol([]))
        self.assertEqual(r["result"], "not_included")
        w = r["witness"]["path"]
        self.assertTrue(w.startswith("/"))
        self.assertNotIn("//", w)
        self.assertNotIn(w, ("/.", "/.."))

    def test_empty_policies(self):
        self.assertEqual(check_inclusion(pol([]), pol([]))["result"], "included")
        self.assertEqual(check_inclusion(pol([]), pol(["**"]))["result"], "included")
        r = check_inclusion(pol(["**"]), pol([]))
        self.assertEqual(r["result"], "not_included")
        self.assertEqual(r["witness"]["path"], "/")

    def test_root_pattern(self):
        self.assertEqual(check_inclusion(pol([""]), pol(["**"]))["result"],
                         "included")
        r = check_inclusion(pol(["**"]), pol([""]))
        self.assertEqual(r["result"], "not_included")
        self.assertNotEqual(r["witness"]["path"], "/")

    def test_whitelist_blacklist_interaction(self):
        p1 = pol(["**"], ["secret", "secret/**"])
        p2 = pol(["**"], ["secret/**"])
        self.assertEqual(check_equivalent(p1, p2)["result"], "equivalent")
        p3 = pol(["**"], ["secret"])
        self.assertEqual(check_inclusion(p1, p3)["result"], "included")
        r = check_inclusion(p3, p1)
        self.assertEqual(r["result"], "not_included")
        self.assertEqual(r["witness"]["path"], "/secret/a")

    def test_equivalent_after_normalization(self):
        r = check_equivalent(pol(["a//b/**"]), pol(["a/./b/**"]))
        self.assertEqual(r["result"], "equivalent")
        for cert in r["certificates"]:
            self.assertTrue(verify_certificate(cert))

    def test_not_equivalent(self):
        r = check_equivalent(pol(["a/**/b"]), pol(["a/b"]))
        self.assertEqual(r["result"], "not_equivalent")
        w = r["witness"]["path"]
        self.assertEqual(len(w), len("/a/x/b"))
        self.assertTrue(verify_certificate(r["certificate"]))

    def test_multiple_same_length_counterexamples(self):
        r = find_difference(pol(["[ab]"]), pol([]), all_shortest=True)
        self.assertEqual(r["result"], "not_included")
        paths = sorted(w["path"] for w in r["all_shortest"])
        self.assertEqual(paths, ["/a", "/b"])

    def test_char_class_complement_difference(self):
        r = find_difference(pol(["[^a]"]), pol(["b"]))
        self.assertEqual(r["result"], "not_included")
        w = r["witness"]["path"]
        self.assertEqual(len(w), 2)
        self.assertNotIn(w[1], "ab/")
        r2 = check_inclusion(pol(["[^a]"]), pol(["[^a]"]))
        self.assertEqual(r2["result"], "included")

    def test_certificate_tampering_detected(self):
        r = check_inclusion(pol(["a/**"]), pol(["**"]))
        cert = r["certificate"]
        self.assertTrue(verify_certificate(cert))
        bad = dict(cert)
        bad["states"] = cert["states"][:-1]
        self.assertFalse(verify_certificate(bad))
        bad2 = dict(cert)
        bad2["transitions"] = cert["transitions"][:-1]
        self.assertFalse(verify_certificate(bad2))
        bad3 = dict(cert)
        bad3["right"] = {"allow": ["a/**"], "deny": []}
        self.assertFalse(verify_certificate(bad3))

    def test_witness_certificate_tampering_detected(self):
        r = check_inclusion(pol(["**"]), pol(["a/**"]))
        cert = r["certificate"]
        self.assertTrue(verify_certificate(cert))
        bad = dict(cert, witness="//evil")
        self.assertFalse(verify_certificate(bad))
        bad2 = dict(cert, witness="/a/b")
        self.assertFalse(verify_certificate(bad2))


class BudgetTest(unittest.TestCase):
    def test_budget_exhaustion_returns_unknown_and_frontier(self):
        checker = InclusionChecker(pol(["a/**"]), pol(["**"]))
        r = checker.run(budget=2)
        self.assertEqual(r["result"], "unknown")
        self.assertIn("checkpoint", r)
        cp = r["checkpoint"]
        self.assertEqual(cp["type"], "inclusion-checkpoint")
        self.assertTrue(cp["exploration"]["frontier"])

    def test_resume_from_checkpoint(self):
        checker = InclusionChecker(pol(["a/**"]), pol(["**"]))
        r1 = checker.run(budget=2)
        self.assertEqual(r1["result"], "unknown")
        resumed = InclusionChecker.from_checkpoint(r1["checkpoint"])
        r2 = resumed.run(budget=100000)
        self.assertEqual(r2["result"], "included")
        self.assertTrue(verify_certificate(r2["certificate"]))

    def test_resume_still_finds_witness(self):
        checker = InclusionChecker(pol(["**"]), pol(["a/**"]))
        r1 = checker.run(budget=1)
        self.assertEqual(r1["result"], "unknown")
        resumed = InclusionChecker.from_checkpoint(r1["checkpoint"])
        r2 = resumed.run(budget=100000)
        self.assertEqual(r2["result"], "not_included")
        self.assertEqual(r2["witness"]["path"], "/")


if __name__ == "__main__":
    unittest.main()
