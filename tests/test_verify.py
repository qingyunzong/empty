"""Tests for the certificate checker."""
import copy
import unittest

from mealy.tree import Solver, tree_to_json
from mealy.verify import check_certificate

from machines import ADAPTIVE_SET, adaptive_only_machine, simple_machine


def valid_tree(machine, initials):
    result = Solver(machine).solve(initials)
    assert result["status"] == "optimal"
    return tree_to_json(result["tree"])


class TestCertificateChecker(unittest.TestCase):
    def test_valid_certificate_accepted(self):
        machine = simple_machine()
        initials = ["s1", "s2", "s3"]
        tree = valid_tree(machine, initials)
        check = check_certificate(machine, tree, initials)
        self.assertTrue(check["valid"], check["errors"])
        self.assertEqual(check["errors"], [])
        self.assertEqual(check["stats"]["leaves"], 3)
        self.assertEqual(check["stats"]["depth"], 2)

    def test_valid_adaptive_certificate_accepted(self):
        machine = adaptive_only_machine()
        tree = valid_tree(machine, ADAPTIVE_SET)
        check = check_certificate(machine, tree, ADAPTIVE_SET)
        self.assertTrue(check["valid"], check["errors"])
        self.assertEqual(check["stats"]["leaves"], 4)

    def test_wrong_leaf_label_rejected(self):
        machine = simple_machine()
        initials = ["s1", "s2", "s3"]
        tree = valid_tree(machine, initials)
        bad = copy.deepcopy(tree)
        bad["children"]["1"] = {"type": "leaf", "state": "s1"}
        check = check_certificate(machine, bad, initials)
        self.assertFalse(check["valid"])
        self.assertTrue(any("leaf" in e for e in check["errors"]))

    def test_missing_branch_rejected(self):
        machine = adaptive_only_machine()
        tree = valid_tree(machine, ADAPTIVE_SET)
        bad = copy.deepcopy(tree)
        del bad["children"]["1"]
        check = check_certificate(machine, bad, ADAPTIVE_SET)
        self.assertFalse(check["valid"])
        self.assertTrue(any("missing branches" in e for e in check["errors"]))

    def test_extra_branch_rejected(self):
        machine = simple_machine()
        initials = ["s1", "s2", "s3"]
        tree = valid_tree(machine, initials)
        bad = copy.deepcopy(tree)
        bad["children"]["bogus-output"] = {"type": "leaf", "state": "s1"}
        check = check_certificate(machine, bad, initials)
        self.assertFalse(check["valid"])
        self.assertTrue(any("unexpected branches" in e for e in check["errors"]))

    def test_premature_leaf_rejected(self):
        machine = simple_machine()
        initials = ["s1", "s2", "s3"]
        tree = valid_tree(machine, initials)
        bad = copy.deepcopy(tree)
        bad["children"]["0"] = {"type": "leaf", "state": "s1"}
        check = check_certificate(machine, bad, initials)
        self.assertFalse(check["valid"])
        self.assertTrue(any("candidates" in e for e in check["errors"]))

    def test_unknown_input_rejected(self):
        machine = simple_machine()
        initials = ["s1", "s2", "s3"]
        tree = valid_tree(machine, initials)
        bad = copy.deepcopy(tree)
        bad["input"] = "not-an-input"
        check = check_certificate(machine, bad, initials)
        self.assertFalse(check["valid"])
        self.assertTrue(any("unknown input" in e for e in check["errors"]))

    def test_unknown_initial_state_rejected(self):
        machine = simple_machine()
        tree = valid_tree(machine, ["s1", "s2", "s3"])
        check = check_certificate(machine, tree, ["s1", "ghost"])
        self.assertFalse(check["valid"])


if __name__ == "__main__":
    unittest.main()
