import unittest

from mealy_dist.solver import DistinguishingTreeSolver
from mealy_dist.tree import TreeNode, check_certificate, verify_tree

from fixtures import gap_machine, three_state_machine


def solved_certificate(machine):
    status = DistinguishingTreeSolver(machine).solve()
    assert status.optimal
    return status.current_tree().to_dict()


class TestCertificateChecker(unittest.TestCase):
    def setUp(self):
        self.machine = three_state_machine()
        self.certificate = solved_certificate(self.machine)

    def test_valid_certificate_accepted(self):
        ok, errors = check_certificate(self.machine, self.certificate)
        self.assertTrue(ok, errors)

    def test_every_leaf_singles_out_one_state(self):
        tree = TreeNode.from_dict(self.certificate)
        reached = {}
        for state in self.machine.states:
            _, _, leaf_state = tree.trace(self.machine, state)
            self.assertEqual(leaf_state, state)
            reached.setdefault(leaf_state, []).append(state)
        for leaf in tree.leaves():
            self.assertEqual(len(reached[leaf.state]), 1)

    def test_tampered_leaf_label_rejected(self):
        cert = solved_certificate(self.machine)
        tree = TreeNode.from_dict(cert)
        leaf = tree.leaves()[0]
        other = next(s for s in self.machine.states if s != leaf.state)
        leaf.state = other
        ok, errors = check_certificate(self.machine, tree.to_dict())
        self.assertFalse(ok)
        self.assertTrue(errors)

    def test_missing_branch_rejected(self):
        cert = solved_certificate(self.machine)
        tree = TreeNode.from_dict(cert)
        self.assertEqual(tree.kind, "node")
        output = next(iter(tree.children))
        del tree.children[output]
        ok, errors = check_certificate(self.machine, tree.to_dict())
        self.assertFalse(ok)
        self.assertTrue(any("missing branch" in e for e in errors))

    def test_unresolved_leaf_rejected(self):
        # A leaf directly at the root leaves all candidates unresolved.
        tree = TreeNode.leaf("q0")
        ok, errors = verify_tree(self.machine, tree)
        self.assertFalse(ok)
        self.assertTrue(any("unresolved" in e for e in errors))

    def test_merging_input_rejected(self):
        # q0 and q1 both move to q1 on input a with output 0: the
        # candidates merge and no subtree could separate them.
        child = TreeNode.leaf("q1")
        tree = TreeNode.node(("q0", "q1"), "a", {"0": child})
        ok, errors = verify_tree(self.machine, tree, ("q0", "q1"))
        self.assertFalse(ok)
        self.assertTrue(any("merges" in e for e in errors))

    def test_malformed_certificate_rejected(self):
        ok, errors = check_certificate(self.machine, {"type": "weird"})
        self.assertFalse(ok)
        self.assertTrue(errors)

    def test_gap_machine_certificate(self):
        machine = gap_machine()
        ok, errors = check_certificate(machine, solved_certificate(machine))
        self.assertTrue(ok, errors)


if __name__ == "__main__":
    unittest.main()
