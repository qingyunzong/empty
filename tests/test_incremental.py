import unittest

from symdfa import (MAX_CHAR, Machine, build_reuse, changed_states_since,
                    check, invalidate_proof, verify_counterexample,
                    verify_proof)


def machine_a():
    return Machine.create(
        ["q0", "q1", "q2", "q3"], "q0", ["q1", "q2"],
        {"q0": [[0, 5, "q1"], [6, 10, "q2"]],
         "q1": [[0, MAX_CHAR, "q1"]],
         "q2": [[0, MAX_CHAR, "q2"]]})


def machine_b():
    return Machine.create(
        ["r0", "r1", "r2"], "r0", ["r1", "r2"],
        {"r0": [[0, 5, "r1"], [6, 10, "r2"]],
         "r1": [[0, MAX_CHAR, "r1"]],
         "r2": [[0, MAX_CHAR, "r2"]]})


class TestInvalidation(unittest.TestCase):
    def test_update_invalidates_dependent_entries_and_reuses_rest(self):
        a, b = machine_a(), machine_b()
        proof = check(a, b).proof
        self.assertEqual(verify_proof(a, b, proof), [])

        # Correction on a previously visited state; language unchanged.
        a2 = a.replace_transition("q0", 6, 10, 6, 10, "q1")
        errors = verify_proof(a2, b, proof)
        self.assertTrue(any("version" in e for e in errors))

        valid, stale = invalidate_proof(proof, a2, b)
        self.assertEqual([e["pair"] for e in stale], [["q0", "r0"]])
        self.assertTrue(valid)

        reuse = build_reuse(valid, a2, b)
        fresh = check(a2, b)
        recheck = check(a2, b, reuse=reuse)
        self.assertEqual(recheck.status, "equivalent")
        self.assertEqual(verify_proof(a2, b, recheck.proof), [])
        self.assertGreater(recheck.stats["reused_edges"], 0)
        self.assertLess(recheck.stats["new_edges"], fresh.stats["new_edges"])

    def test_update_on_visited_state_can_break_equivalence(self):
        a, b = machine_a(), machine_b()
        proof = check(a, b).proof
        a2 = a.replace_transition("q1", 0, MAX_CHAR, 0, MAX_CHAR, "q0")
        valid, stale = invalidate_proof(proof, a2, b)
        self.assertEqual([e["pair"] for e in stale], [["q1", "r1"]])
        res = check(a2, b, reuse=build_reuse(valid, a2, b))
        self.assertEqual(res.status, "different")
        self.assertEqual(res.counterexample["word"], [0, 0])
        self.assertEqual(verify_counterexample(a2, b, res.counterexample), [])

    def test_update_on_unvisited_state_keeps_whole_proof(self):
        a, b = machine_a(), machine_b()
        proof = check(a, b).proof
        a2 = a.add_transition("q3", 0, 10, "q0")  # q3 unreachable from q0
        valid, stale = invalidate_proof(proof, a2, b)
        self.assertEqual(stale, [])
        res = check(a2, b, reuse=build_reuse(valid, a2, b))
        self.assertEqual(res.status, "equivalent")
        self.assertEqual(res.stats["new_edges"], 0)
        self.assertEqual(verify_proof(a2, b, res.proof), [])

    def test_old_proof_not_transplantable(self):
        a, b = machine_a(), machine_b()
        proof = check(a, b).proof
        # A language-preserving update still bumps the version, and the old
        # proof must not verify against the new machine version.
        a2 = a.add_transition("q3", 0, 10, "q0")
        errors = verify_proof(a2, b, proof)
        self.assertTrue(any("version" in e for e in errors))
        # The unchanged machine's own proof still verifies.
        self.assertEqual(verify_proof(a, b, proof), [])

    def test_changed_states_since(self):
        a = machine_a()
        a2 = a.add_transition("q3", 0, 10, "q0")
        a3 = a2.replace_transition("q0", 0, 5, 0, 5, "q2")
        self.assertEqual(changed_states_since(a3, 0), {"q3", "q0"})
        self.assertEqual(changed_states_since(a3, 1), {"q0"})
        self.assertEqual(changed_states_since(a3, 2), set())
        with self.assertRaises(ValueError):
            changed_states_since(a3, 3)


if __name__ == "__main__":
    unittest.main()
