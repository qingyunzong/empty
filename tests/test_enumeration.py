"""Acceptance A: for every legal expression of <= 5 tokens, the prattx AST
must match an independent recursive-descent oracle implementing the same
precedence/associativity rules (the brute-force structural reference)."""

import unittest

from prattx import parse
from tests.enumerator import generate
from tests.oracle import normalize, parse_oracle


class TestEnumeration(unittest.TestCase):
    def test_all_expressions_up_to_length_5(self):
        expressions = generate(5)
        self.assertGreater(len(expressions), 1000)  # sanity: real coverage
        mismatches = []
        for source in expressions:
            got = normalize(parse(source))
            want = parse_oracle(source)
            if got != want:
                mismatches.append((source, want, got))
                if len(mismatches) >= 5:
                    break
        self.assertEqual(mismatches, [])


if __name__ == "__main__":
    unittest.main()
