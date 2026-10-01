"""Tests for the csp_alldiff package.

Two independent references are used:

- gac_reference: brute-force enumeration of all assignments; a value is
  kept iff it appears in at least one all-different solution.  This is
  exactly generalized arc consistency (GAC) for alldiff, which is what
  the matching-based propagator implements (Regin's algorithm).
- ac3_reference: AC-3 on the decomposition of alldiff into pairwise
  not-equal constraints.  Note: AC-3 on this decomposition is in
  general WEAKER than GAC (e.g. domains {1,2},{1,2},{1,2,3}: AC-3
  prunes nothing, GAC shrinks the third domain to {3}).  It is kept as
  the naive pairwise reference and compared on the cases where the two
  consistencies coincide.
"""

from __future__ import annotations

import itertools
import json
import os
import random
import subprocess
import sys
import tempfile
import unittest
from collections import deque

from csp_alldiff import DomainError, propagate, validate_domains


def gac_reference(domains):
    """Brute-force GAC: keep values that appear in some all-different solution.

    Returns a sorted list of supported values per variable, or None when
    no all-different assignment exists.
    """
    supported = [set() for _ in domains]
    found = False
    for assignment in itertools.product(*domains):
        if len(set(assignment)) == len(assignment):
            found = True
            for i, value in enumerate(assignment):
                supported[i].add(value)
    if not found:
        return None
    return [sorted(values) for values in supported]


def ac3_reference(domains):
    """Naive reference: expand alldiff into pairwise != constraints, run AC-3.

    Returns a sorted list of pruned domains, or None if a domain wipes out.
    """
    pruned = [set(d) for d in domains]
    if any(not d for d in pruned):
        return None
    num_vars = len(pruned)
    queue = deque(
        (i, j) for i in range(num_vars) for j in range(num_vars) if i != j
    )
    while queue:
        i, j = queue.popleft()
        removed = {
            v for v in pruned[i] if not any(w != v for w in pruned[j])
        }
        if removed:
            pruned[i] -= removed
            if not pruned[i]:
                return None
            for k in range(num_vars):
                if k != i and k != j:
                    queue.append((k, i))
    return [sorted(d) for d in pruned]


def run_cli(input_data, raw_text=None):
    """Run the CLI on the given JSON data; return (returncode, stdout, stderr)."""
    with tempfile.NamedTemporaryFile(
        "w", suffix=".json", delete=False, encoding="utf-8"
    ) as handle:
        if raw_text is not None:
            handle.write(raw_text)
        else:
            json.dump(input_data, handle)
        path = handle.name
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "csp_alldiff", "propagate", "--input", path],
            capture_output=True,
            text=True,
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        )
        return proc.returncode, proc.stdout, proc.stderr
    finally:
        os.unlink(path)


class PropagatorAcceptanceTests(unittest.TestCase):
    def test_scenario_1_three_variables(self):
        domains = [[1, 2], [1, 2], [1, 2, 3]]
        status, result = propagate(domains)
        self.assertEqual(status, "complete")
        self.assertEqual(result, [[1, 2], [1, 2], [3]])
        self.assertEqual(result, gac_reference(domains))

    def test_scenario_2_unsat(self):
        status, result = propagate([[1], [1]])
        self.assertEqual(status, "unsat")
        self.assertIsNone(result)
        self.assertIsNone(gac_reference([[1], [1]]))
        self.assertIsNone(ac3_reference([[1], [1]]))

    def test_scenario_3_empty_variable_list(self):
        status, result = propagate([])
        self.assertEqual(status, "complete")
        self.assertEqual(result, [])

    def test_scenario_4_nested_hall_sets(self):
        domains = [[1, 2], [1, 2], [1, 2, 3, 4], [3, 4]]
        status, result = propagate(domains)
        self.assertEqual(status, "complete")
        self.assertEqual(result, [[1, 2], [1, 2], [3, 4], [3, 4]])
        self.assertEqual(result, gac_reference(domains))

    def test_no_pruning_when_all_values_supported(self):
        domains = [[1, 2, 3], [1, 2]]
        status, result = propagate(domains)
        self.assertEqual(status, "complete")
        self.assertEqual(result, [[1, 2, 3], [1, 2]])
        self.assertEqual(result, gac_reference(domains))

    def test_empty_domain_is_unsat(self):
        status, result = propagate([[], [1]])
        self.assertEqual(status, "unsat")
        self.assertIsNone(result)


class GacReferenceComparisonTests(unittest.TestCase):
    """Compare the matching-based propagator with brute-force GAC."""

    def check_against_gac_reference(self, domains):
        status, result = propagate([list(d) for d in domains])
        reference = gac_reference(domains)
        if reference is None:
            self.assertEqual(status, "unsat", domains)
            self.assertIsNone(result)
        else:
            self.assertEqual(status, "complete", domains)
            self.assertEqual(result, reference, domains)

    def test_handpicked_cases(self):
        cases = [
            [[1, 2], [1, 2], [1, 2, 3]],
            [[1], [1]],
            [[1, 2], [1, 2], [1, 2, 3, 4], [3, 4]],
            [[1, 2, 3], [1, 2], [2, 3]],
            [[1, 2, 3], [1, 2], [1, 2]],
            [[1, 2], [2, 3], [1, 3]],
            [[1], [2], [3]],
            [[1, 2, 3, 4], [1, 2], [2, 3], [3, 4]],
            [[1, 2], [1, 2], [1, 2]],
            [[5, 6], [5, 6, 7], [6, 7], [5, 7]],
            [[0, 1], [1, 2], [0, 2], [0, 1, 2, 3]],
            [[-1, 0], [0, 1], [-1, 1]],
            [[-2, 1, 4], [1, 2], [-2, 2], [1, 4], [-2, 0, 5], [6]],
        ]
        for domains in cases:
            with self.subTest(domains=domains):
                self.check_against_gac_reference(domains)

    def test_random_cases_against_gac_reference(self):
        rng = random.Random(20261001)
        for trial in range(500):
            num_vars = rng.randint(0, 6)
            domains = []
            for _ in range(num_vars):
                size = rng.randint(0, 4)
                domains.append(sorted(rng.sample(range(-2, 8), k=size)))
            with self.subTest(trial=trial, domains=domains):
                self.check_against_gac_reference(domains)


class Ac3ReferenceComparisonTests(unittest.TestCase):
    """Compare against AC-3 on the pairwise != decomposition.

    AC-3 on the decomposition coincides with GAC on these cases (pruning
    is driven entirely by singleton domains), so the dedicated
    propagator must agree with the naive reference here.
    """

    def test_cases_where_ac3_matches_gac(self):
        cases = [
            [[1], [1]],
            [[1], [1, 2], [2, 3]],
            [[1], [1, 2], [1, 2, 3], [3, 4]],
            [[2], [1, 2], [1, 3]],
            [[1, 2], [2], [1, 2, 3], [3], [3, 4]],
            [[5], [5, 6], [6, 7], [7, 8]],
        ]
        for domains in cases:
            with self.subTest(domains=domains):
                status, result = propagate([list(d) for d in domains])
                reference = ac3_reference(domains)
                if reference is None:
                    self.assertEqual(status, "unsat", domains)
                else:
                    self.assertEqual(status, "complete", domains)
                    self.assertEqual(result, reference, domains)

    def test_ac3_decomposition_is_weaker_in_general(self):
        # Documents the known gap: AC-3 on pairwise != prunes nothing for
        # {1,2},{1,2},{1,2,3}, while the Hall-set propagator (GAC) shrinks
        # the third domain to {3} because {x1,x2} is a Hall set over {1,2}.
        domains = [[1, 2], [1, 2], [1, 2, 3]]
        self.assertEqual(ac3_reference(domains), [[1, 2], [1, 2], [1, 2, 3]])
        status, result = propagate(domains)
        self.assertEqual(status, "complete")
        self.assertEqual(result, [[1, 2], [1, 2], [3]])


class ValidationTests(unittest.TestCase):
    def test_non_integer_value_rejected(self):
        with self.assertRaises(DomainError):
            validate_domains([[1, "a"]])

    def test_boolean_value_rejected(self):
        with self.assertRaises(DomainError):
            validate_domains([[True]])

    def test_float_value_rejected(self):
        with self.assertRaises(DomainError):
            validate_domains([[1.5]])

    def test_non_list_domain_rejected(self):
        with self.assertRaises(DomainError):
            validate_domains([5])

    def test_non_list_input_rejected(self):
        with self.assertRaises(DomainError):
            validate_domains(42)

    def test_duplicates_and_unsorted_normalized(self):
        self.assertEqual(validate_domains([[3, 1, 3, 2]]), [[1, 2, 3]])


class CliTests(unittest.TestCase):
    def test_cli_scenario_1(self):
        code, out, err = run_cli([[1, 2], [1, 2], [1, 2, 3]])
        self.assertEqual(code, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["status"], "complete")
        self.assertEqual(payload["domains"], [[1, 2], [1, 2], [3]])

    def test_cli_unsat(self):
        code, out, err = run_cli([[1], [1]])
        self.assertEqual(code, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["status"], "unsat")
        self.assertIsNone(payload["domains"])

    def test_cli_empty_variables(self):
        code, out, err = run_cli([])
        self.assertEqual(code, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["status"], "complete")
        self.assertEqual(payload["domains"], [])

    def test_cli_nested_hall(self):
        code, out, err = run_cli([[1, 2], [1, 2], [1, 2, 3, 4], [3, 4]])
        self.assertEqual(code, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["status"], "complete")
        self.assertEqual(payload["domains"], [[1, 2], [1, 2], [3, 4], [3, 4]])

    def test_cli_non_integer_domain_error(self):
        code, out, err = run_cli([[1, "x"]])
        self.assertNotEqual(code, 0)
        self.assertIn("error", err)

    def test_cli_boolean_domain_error(self):
        code, out, err = run_cli([[True, 1]])
        self.assertNotEqual(code, 0)

    def test_cli_negative_num_variables_error(self):
        code, out, err = run_cli({"num_variables": -1, "domains": []})
        self.assertNotEqual(code, 0)
        self.assertIn("error", err)

    def test_cli_missing_file_error(self):
        proc = subprocess.run(
            [sys.executable, "-m", "csp_alldiff", "propagate", "--input",
             "/nonexistent/path/domains.json"],
            capture_output=True,
            text=True,
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        )
        self.assertNotEqual(proc.returncode, 0)

    def test_cli_invalid_json_error(self):
        code, out, err = run_cli(None, raw_text="{not json")
        self.assertNotEqual(code, 0)

    def test_cli_dict_with_domains_key(self):
        code, out, err = run_cli({"num_variables": 2, "domains": [[1], [1, 2]]})
        self.assertEqual(code, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["status"], "complete")
        self.assertEqual(payload["domains"], [[1], [2]])


if __name__ == "__main__":
    unittest.main()
