"""Acceptance A: for every valid expression of token length <= 5 produced by
the exhaustive generator, the Pratt AST must structurally match the
independent recursive-descent reference parser (the brute-force
parenthesized-precedence structure)."""

import unittest

from prattx import ParseError, parse

from generator import generate
from reference import RefParseError, parse_reference

_IGNORE = {"lbp", "rbp"}


def canonical(node):
    """Strip Pratt-specific lbp/rbp and freeze into comparable tuples."""
    if isinstance(node, dict):
        return tuple(
            sorted(
                (key, canonical(value))
                for key, value in node.items()
                if key not in _IGNORE
            )
        )
    if isinstance(node, list):
        return tuple(canonical(item) for item in node)
    return node


def check_shape(node, path="root"):
    """Every AST node must carry op, lbp, rbp and span."""
    for key in ("op", "lbp", "rbp", "span"):
        assert key in node, "node at %s missing %r" % (path, key)
    assert isinstance(node["lbp"], int)
    assert isinstance(node["rbp"], int)
    start, end = node["span"]
    assert 0 <= start <= end
    for key, value in node.items():
        if isinstance(value, dict):
            check_shape(value, "%s.%s" % (path, key))
        elif isinstance(value, list):
            for i, item in enumerate(value):
                if isinstance(item, dict):
                    check_shape(item, "%s.%s[%d]" % (path, key, i))


class EnumerationTest(unittest.TestCase):
    def test_all_valid_expressions_up_to_length_5(self):
        checked = 0
        for src in generate(5):
            try:
                expected = parse_reference(src)
            except RefParseError:
                continue  # not a valid expression per the reference grammar
            try:
                got = parse(src)
            except ParseError as exc:  # pragma: no cover - failure path
                self.fail("prattx rejected valid expression %r: %s" % (src, exc))
            self.assertEqual(
                canonical(expected),
                canonical(got),
                msg="AST mismatch for %r" % src,
            )
            check_shape(got)
            checked += 1
        self.assertGreater(checked, 500)  # sanity: corpus is non-trivial


if __name__ == "__main__":
    unittest.main()
