import itertools
import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shrink import build_predicate, minimize, parse_case, CaseError

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def sort_key(ops):
    return (
        len(ops),
        tuple(op["name"] for op in ops),
        tuple(json.dumps(op["args"], sort_keys=True, separators=(",", ":")) for op in ops),
    )


def brute_force_min(ops, pred):
    """Min (length, names, args-JSON) failing subsequence, by enumeration."""
    best = None
    for r in range(0, len(ops) + 1):
        for idxs in itertools.combinations(range(len(ops)), r):
            cand = [ops[i] for i in idxs]
            if pred(cand):
                key = sort_key(cand)
                if best is None or key < best[0]:
                    best = (key, cand)
    if best is None:
        return None
    return [{"name": op["name"], "args": op["args"]} for op in best[1]]


def make_case(ops, fail_when):
    return parse_case({"ops": ops, "fail_when": fail_when})


class AcceptanceA(unittest.TestCase):
    """A: noisy deletable sequence must match brute-force enumeration."""

    def test_matches_brute_force(self):
        ops, pred = make_case(
            [{"name": n, "args": {"i": i}} for i, n in enumerate(
                ["delta", "keep", "alpha", "zulu", "bravo"])],
            {"type": "contains_subsequence", "names": ["keep"]},
        )
        result = minimize(ops, pred, budget=1000)
        expected = brute_force_min(ops, pred)
        self.assertEqual(result.status, "OK")
        self.assertEqual(result.minimality, "1_MINIMAL")
        self.assertEqual(result.ops, expected)
        self.assertEqual([op["name"] for op in result.ops], ["keep"])

    def test_matches_brute_force_with_args_tiebreak(self):
        # Two ops named "keep": the lexicographically smaller args must win.
        ops, pred = make_case(
            [
                {"name": "noise", "args": {}},
                {"name": "keep", "args": {"v": 2}},
                {"name": "keep", "args": {"v": 1}},
                {"name": "noise2", "args": {}},
            ],
            {"type": "contains_subsequence", "names": ["keep"]},
        )
        result = minimize(ops, pred, budget=1000)
        expected = brute_force_min(ops, pred)
        self.assertEqual(result.ops, expected)
        self.assertEqual(result.ops, [{"name": "keep", "args": {"v": 1}}])


class AcceptanceB(unittest.TestCase):
    """B: predicate fails only on a specific consecutive triple."""

    def setUp(self):
        self.ops, self.pred = make_case(
            [{"name": n} for n in ["n1", "n2", "a", "b", "c", "n3"]],
            {"type": "contains_subsequence", "names": ["a", "b", "c"]},
        )

    def test_structural_block_deletion_keeps_triple(self):
        result = minimize(self.ops, self.pred, budget=1000)
        self.assertEqual(result.status, "OK")
        self.assertEqual([op["name"] for op in result.ops], ["a", "b", "c"])
        # The failure must still be present in the minimized output.
        self.assertTrue(self.pred(result.ops))
        # And it must be genuinely 1-minimal.
        self.assertEqual(result.minimality, "1_MINIMAL")
        for i in range(len(result.ops)):
            reduced = result.ops[:i] + result.ops[i + 1:]
            self.assertFalse(self.pred(reduced))


class AcceptanceC(unittest.TestCase):
    """C: budget 1 must report BUDGET_EXCEEDED and not claim minimality."""

    def test_budget_one(self):
        ops, pred = make_case(
            [{"name": n} for n in ["n1", "n2", "a", "b", "c", "n3"]],
            {"type": "contains_subsequence", "names": ["a", "b", "c"]},
        )
        result = minimize(ops, pred, budget=1)
        self.assertEqual(result.status, "BUDGET_EXCEEDED")
        self.assertEqual(result.minimality, "UNKNOWN_MINIMALITY")
        self.assertEqual(result.checks, 1)
        # Current best is returned, not a claimed-minimal result.
        self.assertEqual(result.ops, [{"name": n, "args": {}} for n in
                                      ["n1", "n2", "a", "b", "c", "n3"]])


class AcceptanceD(unittest.TestCase):
    """D: arg replacement that makes the predicate raise must be rejected."""

    def test_exception_candidate_not_selected(self):
        ops, pred = make_case(
            [{"name": "t", "args": {"n": 10},
              "candidates": [{"n": 1}, {"a": 1}]}],
            {"type": "args_sum_at_least", "key": "n", "threshold": 5},
        )
        result = minimize(ops, pred, budget=1000)
        self.assertEqual(result.status, "OK")
        self.assertEqual(result.minimality, "1_MINIMAL")
        # {"n": 1} stops the failure; {"a": 1} raises KeyError -> not failing.
        # Neither may be kept.
        self.assertEqual(result.ops, [{"name": "t", "args": {"n": 10}}])

    def test_valid_replacement_is_applied(self):
        # Neither op fails alone, so deletion cannot win; the candidate
        # {"n": 8} keeps the failure and is smaller in args-JSON order.
        ops, pred = make_case(
            [{"name": "t", "args": {"n": 3}},
             {"name": "u", "args": {"n": 9}, "candidates": [{"n": 8}]},
             ],
            {"type": "args_sum_at_least", "key": "n", "threshold": 10},
        )
        result = minimize(ops, pred, budget=1000)
        self.assertEqual(result.status, "OK")
        self.assertEqual(result.minimality, "1_MINIMAL")
        self.assertEqual(result.ops, [{"name": "t", "args": {"n": 3}},
                                      {"name": "u", "args": {"n": 8}}])
        self.assertTrue(pred(result.ops))


class MinimalitySemantics(unittest.TestCase):
    def _one_op_case(self):
        return make_case([{"name": "keep"}],
                         {"type": "contains_subsequence", "names": ["keep"]})

    def test_unknown_minimality_when_verification_runs_out_of_budget(self):
        ops, pred = self._one_op_case()
        # checks: initial(1) + greedy single-deletion(1) = 2; verification
        # would need a 3rd check.
        result = minimize(ops, pred, budget=2)
        self.assertEqual(result.status, "OK")
        self.assertEqual(result.minimality, "UNKNOWN_MINIMALITY")
        self.assertEqual(result.ops, [{"name": "keep", "args": {}}])

    def test_one_minimal_with_sufficient_budget(self):
        ops, pred = self._one_op_case()
        result = minimize(ops, pred, budget=3)
        self.assertEqual(result.status, "OK")
        self.assertEqual(result.minimality, "1_MINIMAL")
        self.assertEqual(result.checks, 3)

    def test_zero_budget(self):
        ops, pred = self._one_op_case()
        result = minimize(ops, pred, budget=0)
        self.assertEqual(result.status, "BUDGET_EXCEEDED")
        self.assertEqual(result.minimality, "UNKNOWN_MINIMALITY")
        self.assertEqual(result.checks, 0)

    def test_initial_not_failing(self):
        ops, pred = make_case([{"name": "x"}], {"type": "never"})
        result = minimize(ops, pred, budget=100)
        self.assertEqual(result.status, "OK")
        self.assertEqual(result.ops, [{"name": "x", "args": {}}])


class CaseValidation(unittest.TestCase):
    def test_missing_fail_when(self):
        with self.assertRaises(CaseError):
            parse_case({"ops": []})

    def test_unknown_rule(self):
        with self.assertRaises(CaseError):
            parse_case({"ops": [], "fail_when": {"type": "nope"}})

    def test_bad_op(self):
        with self.assertRaises(CaseError):
            parse_case({"ops": [{"args": {}}], "fail_when": {"type": "always"}})

    def test_ops_not_a_list(self):
        with self.assertRaises(CaseError):
            parse_case({"ops": {}, "fail_when": {"type": "always"}})


class Cli(unittest.TestCase):
    def run_cli(self, *argv):
        return subprocess.run(
            [sys.executable, "-m", "shrink", *argv],
            cwd=REPO_ROOT, capture_output=True, text=True,
        )

    def write_case(self, case):
        fd, path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w") as fh:
            json.dump(case, fh)
        self.addCleanup(os.unlink, path)
        return path

    def test_minimize_end_to_end(self):
        case_path = self.write_case({
            "ops": [{"name": n} for n in ["n1", "a", "b", "c", "n2"]],
            "fail_when": {"type": "contains_subsequence", "names": ["a", "b", "c"]},
        })
        fd, out_path = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        self.addCleanup(os.unlink, out_path)
        proc = self.run_cli("minimize", case_path, "--budget", "200",
                            "--out", out_path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        with open(out_path) as fh:
            result = json.load(fh)
        self.assertEqual(result["status"], "OK")
        self.assertEqual(result["minimality"], "1_MINIMAL")
        self.assertEqual([op["name"] for op in result["ops"]], ["a", "b", "c"])
        self.assertIn("checks", result)
        self.assertIn("reason", result)

    def test_invalid_json_exits_2(self):
        fd, path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w") as fh:
            fh.write("{not json")
        self.addCleanup(os.unlink, path)
        proc = self.run_cli("minimize", path)
        self.assertEqual(proc.returncode, 2)

    def test_missing_file_exits_2(self):
        proc = self.run_cli("minimize", "/nonexistent/case.json")
        self.assertEqual(proc.returncode, 2)

    def test_invalid_case_exits_2(self):
        case_path = self.write_case({"ops": "not-a-list"})
        proc = self.run_cli("minimize", case_path)
        self.assertEqual(proc.returncode, 2)

    def test_budget_exceeded_via_cli(self):
        case_path = self.write_case({
            "ops": [{"name": n} for n in ["x", "y", "z"]],
            "fail_when": {"type": "always"},
        })
        proc = self.run_cli("minimize", case_path, "--budget", "1")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(result["status"], "BUDGET_EXCEEDED")
        self.assertEqual(result["minimality"], "UNKNOWN_MINIMALITY")


if __name__ == "__main__":
    unittest.main()
