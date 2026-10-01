import copy
import json
import unittest

from fdsolver import Searcher, all_solutions, verify_unsat_certificate

SAT_SPEC = {
    "variables": {"a": [1, 2, 3], "b": [1, 2, 3], "c": [1, 2, 3]},
    "constraints": [{"type": "allDifferent", "vars": ["a", "b", "c"]}],
}

UNSAT_SPEC = {
    "variables": {"x": [1, 2], "y": [1, 2], "z": [1, 2]},
    "constraints": [
        {"type": "table", "vars": ["x", "y"], "tuples": [[1, 2], [2, 1]]},
        {"type": "table", "vars": ["x", "z"], "tuples": [[1, 2], [2, 1]]},
        {"type": "table", "vars": ["y", "z"], "tuples": [[1, 2], [2, 1]]},
    ],
}


class TestSearchBasics(unittest.TestCase):
    def test_sat_with_complete_witness(self):
        sch = Searcher(SAT_SPEC)
        self.assertEqual(sch.run(), "sat")
        w = sch.witness
        self.assertEqual(sorted(w), ["a", "b", "c"])
        self.assertEqual(sorted(w.values()), [1, 2, 3])

    def test_unsat_with_verifiable_certificate(self):
        sch = Searcher(UNSAT_SPEC)
        self.assertEqual(sch.run(), "unsat")
        self.assertTrue(verify_unsat_certificate(UNSAT_SPEC, sch.tree))

    def test_zero_budget_is_unknown(self):
        sch = Searcher(SAT_SPEC, budget=0)
        self.assertEqual(sch.run(), "unknown")
        self.assertIsNone(sch.witness)

    def test_exhausted_budget_only_unknown(self):
        sch = Searcher(UNSAT_SPEC, budget=1)
        self.assertEqual(sch.run(), "unknown")

    def test_resume_after_budget_extension(self):
        sch = Searcher(SAT_SPEC, budget=1)
        self.assertEqual(sch.run(), "unknown")
        sch.budget = 100
        sch.status = None  # caller decides to continue with a fresh budget
        self.assertEqual(sch.run(), "sat")

    def test_all_solutions_enumeration(self):
        sols = all_solutions({
            "variables": {"a": [1, 2], "b": [1, 2]},
            "constraints": [{"type": "allDifferent", "vars": ["a", "b"]}],
        })
        self.assertEqual(sorted(tuple(sorted(s.items())) for s in sols),
                         [(("a", 1), ("b", 2)), (("a", 2), ("b", 1))])


class TestPauseResume(unittest.TestCase):
    def check_step_serialize_equal(self, spec, budget=10000):
        continuous = Searcher(spec, budget=budget)
        continuous.run()

        stepped = Searcher(spec, budget=budget)
        save_restore_cycles = 0
        while stepped.status is None:
            stepped.step()
            # persist and restore after every single node
            blob = json.dumps(stepped.to_json(), sort_keys=True)
            stepped = Searcher.from_json(json.loads(blob))
            save_restore_cycles += 1
        self.assertGreater(save_restore_cycles, 1)
        self.assertEqual(stepped.status, continuous.status)
        self.assertEqual(stepped.nodes, continuous.nodes)
        self.assertEqual(stepped.witness, continuous.witness)
        self.assertEqual(stepped.tree, continuous.tree)

    def test_sat_search_one_node_at_a_time(self):
        self.check_step_serialize_equal(SAT_SPEC)

    def test_unsat_search_one_node_at_a_time(self):
        self.check_step_serialize_equal(UNSAT_SPEC)

    def test_larger_problem_one_node_at_a_time(self):
        spec = {
            "variables": {f"v{i}": [1, 2, 3, 4] for i in range(4)},
            "constraints": [
                {"type": "allDifferent",
                 "vars": ["v0", "v1", "v2", "v3"]},
                {"type": "table", "vars": ["v0", "v1"],
                 "tuples": [[1, 2], [2, 1], [3, 4]]},
            ],
        }
        self.check_step_serialize_equal(spec)


class TestCertificateTampering(unittest.TestCase):
    def setUp(self):
        sch = Searcher(UNSAT_SPEC)
        sch.run()
        self.assertEqual(sch.status, "unsat")
        self.tree = sch.tree

    def test_genuine_certificate_verifies(self):
        self.assertTrue(verify_unsat_certificate(UNSAT_SPEC, self.tree))

    def test_fabricated_root_conflict_fails(self):
        self.assertFalse(verify_unsat_certificate(UNSAT_SPEC, "conflict"))

    def test_missing_branch_fails(self):
        bad = copy.deepcopy(self.tree)
        bad["branches"] = bad["branches"][:1]
        self.assertFalse(verify_unsat_certificate(UNSAT_SPEC, bad))

    def test_altered_branch_value_fails(self):
        bad = copy.deepcopy(self.tree)
        bad["branches"][0]["value"] += 100
        self.assertFalse(verify_unsat_certificate(UNSAT_SPEC, bad))

    def test_fabricated_subtree_fails(self):
        bad = copy.deepcopy(self.tree)
        bad["branches"][0]["child"] = {"var": "y", "branches": []}
        self.assertFalse(verify_unsat_certificate(UNSAT_SPEC, bad))

    def test_swapped_variable_fails(self):
        bad = copy.deepcopy(self.tree)
        bad["var"] = "y"
        self.assertFalse(verify_unsat_certificate(UNSAT_SPEC, bad))

    def test_certificate_against_wrong_spec_fails(self):
        other = copy.deepcopy(UNSAT_SPEC)
        other["constraints"][0]["tuples"].append([1, 1])
        self.assertFalse(verify_unsat_certificate(other, self.tree))


if __name__ == "__main__":
    unittest.main()
