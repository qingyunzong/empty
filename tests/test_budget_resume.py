import unittest

from regexamb import parse_pattern, analyze


class TestBudgetAndResume(unittest.TestCase):
    def test_budget_exhaustion_returns_unknown_with_checkpoint(self):
        root = parse_pattern("aaaa(a|a)")
        res = analyze(root, budget=1)
        self.assertEqual(res["status"], "unknown")
        self.assertEqual(res["reason"], "work budget exhausted")
        self.assertIn("checkpoint", res)
        self.assertIn("next_length", res["checkpoint"])

    def test_resume_matches_one_shot(self):
        root = parse_pattern("aaaa(a|a)")
        one_shot = analyze(root, budget=50_000_000)
        self.assertEqual(one_shot["status"], "ambiguous")

        state = None
        for _ in range(8):
            res = analyze(root, budget=3, resume_state=state)
            if res["status"] == "unknown":
                state = res["checkpoint"]
                continue
            break
        self.assertEqual(res["status"], "ambiguous")
        self.assertEqual(res["word"], one_shot["word"])
        self.assertEqual(res["parses"], one_shot["parses"])

    def test_resume_rejects_mismatched_expression(self):
        root = parse_pattern("aaaa(a|a)")
        other = parse_pattern("b(b|b)")
        res = analyze(root, budget=1)
        self.assertEqual(res["status"], "unknown")
        with self.assertRaises(ValueError):
            analyze(other, budget=10, resume_state=res["checkpoint"])

    def test_checkpoint_round_trip_via_json(self):
        import json
        from regexamb.enumerate import Enumerator
        root = parse_pattern("(a|ab)(b|ε)")
        enum = Enumerator(root, budget=10_000)
        enum.compute_level(0)
        enum.compute_level(1)
        state = json.loads(json.dumps(enum.checkpoint()))
        clone = Enumerator(root, budget=10_000, state=state)
        self.assertEqual(clone.n_done, 1)
        clone.compute_level(2)
        self.assertIn("ab", clone.levels[root.id][2])
        self.assertEqual(len(clone.levels[root.id][2]["ab"]), 2)


if __name__ == "__main__":
    unittest.main()
