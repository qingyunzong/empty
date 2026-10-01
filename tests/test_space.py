"""Unit tests for the exact set algebras (intervals, prefixes, cubes)."""

import unittest

from shadowc import compile_source
from shadowc.space import (
    INT_FULL,
    int_complement,
    int_intersect,
    int_member,
    int_normalize,
    int_subset,
    int_union,
    space_complement,
    space_intersect,
    space_is_empty,
    space_subset,
    str_complement,
    str_cylinder,
    str_exact,
    str_intersect,
    str_is_empty,
    str_member,
    str_normalize,
    str_subset,
    str_union,
)

ALPHABET = frozenset({"a", "b", "c", "\x00"})


class TestIntervals(unittest.TestCase):
    def test_normalize_merges_adjacent(self):
        self.assertEqual(int_normalize([(6, 10), (1, 5)]), ((1, 10),))
        self.assertEqual(int_normalize([(1, 3), (5, 7)]), ((1, 3), (5, 7)))

    def test_union_intersect(self):
        a = ((1, 5), (10, 15))
        b = ((3, 12),)
        self.assertEqual(int_union(a, b), ((1, 15),))
        self.assertEqual(int_intersect(a, b), ((3, 5), (10, 12)))

    def test_complement(self):
        self.assertEqual(int_complement(((1, 10),)), ((None, 0), (11, None)))
        self.assertEqual(int_complement(INT_FULL), ())
        self.assertEqual(int_complement(()), INT_FULL)
        self.assertEqual(
            int_complement(((None, 0), (10, None))), ((1, 9),)
        )

    def test_subset_and_member(self):
        self.assertTrue(int_subset(((2, 5),), ((1, 10),)))
        self.assertFalse(int_subset(((0, 5),), ((1, 10),)))
        self.assertTrue(int_member(7, ((None, None),)))
        self.assertFalse(int_member(7, ((1, 6),)))


class TestPrefixSets(unittest.TestCase):
    def test_cylinder_containment(self):
        self.assertTrue(str_subset(str_exact("abc"), str_cylinder("ab"), ALPHABET))
        self.assertTrue(str_subset(str_cylinder("ab"), str_cylinder("a"), ALPHABET))
        self.assertFalse(str_subset(str_cylinder("a"), str_cylinder("ab"), ALPHABET))

    def test_incompatible_intersection(self):
        inter = str_intersect(str_cylinder("ab"), str_cylinder("ac"))
        self.assertTrue(str_is_empty(inter))

    def test_normalize_absorbs(self):
        rep = str_normalize({"abc"}, ("ab", "a"))
        self.assertEqual(rep, (frozenset(), ("a",)))

    def test_complement_cylinder(self):
        comp = str_complement(str_cylinder("ab"), ALPHABET)
        self.assertTrue(str_member("", comp))
        self.assertTrue(str_member("a", comp))
        self.assertTrue(str_member("ac", comp))
        self.assertTrue(str_member("bzzz", comp))
        self.assertFalse(str_member("ab", comp))
        self.assertFalse(str_member("abc", comp))

    def test_complement_exact(self):
        comp = str_complement(str_exact("ab"), ALPHABET)
        self.assertFalse(str_member("ab", comp))
        self.assertTrue(str_member("abc", comp))
        self.assertTrue(str_member("a", comp))
        self.assertTrue(str_member("b", comp))

    def test_double_complement(self):
        rep = str_union(str_exact("xy"), str_cylinder("ab"))
        comp2 = str_complement(str_complement(rep, ALPHABET), ALPHABET)
        self.assertTrue(str_subset(rep, comp2, ALPHABET))
        self.assertTrue(str_subset(comp2, rep, ALPHABET))


PRELUDE = (
    "field port: int\n"
    "field proto: string\n"
    "field role: enum(admin, user)\n"
    "action allow\n"
)


def space_of(cond_src):
    compiled = compile_source(PRELUDE + f"rule r when {cond_src} then allow\n")
    return compiled.rules[0].space, compiled


class TestSpaces(unittest.TestCase):
    def assert_subset(self, a_src, b_src):
        a, compiled = space_of(a_src)
        b, _ = space_of(b_src)
        self.assertTrue(
            space_subset(a, b, compiled.schema, compiled.alphabet),
            f"expected {a_src!r} <= {b_src!r}",
        )

    def test_interval_inclusion(self):
        self.assert_subset("port in 1..10", "port in 1..20")
        self.assert_subset("port == 5", "port in 1..20")

    def test_prefix_inclusion(self):
        self.assert_subset('proto == "tcp"', 'proto == "t*"')
        self.assert_subset('proto == "tcp*"', 'proto == "t*"')

    def test_enum_inclusion(self):
        self.assert_subset("role == admin", "role in {admin, user}")

    def test_de_morgan(self):
        compiled = compile_source(
            PRELUDE + "rule r when not (port in 1..10 and proto == \"a*\") then allow\n"
        )
        de_morgan = compile_source(
            PRELUDE
            + "rule r when not port in 1..10 or not proto == \"a*\" then allow\n"
        )
        s1 = compiled.rules[0].space
        s2 = de_morgan.rules[0].space
        self.assertTrue(space_subset(s1, s2, compiled.schema, compiled.alphabet))
        self.assertTrue(space_subset(s2, s1, compiled.schema, compiled.alphabet))

    def test_not_interval_complement(self):
        self.assert_subset("port in 11..20", "not port in 1..10")

    def test_cross_field_cube(self):
        # (port==1 and proto=="a*") is a subset of (proto == "a*")
        self.assert_subset('port == 1 and proto == "a*"', 'proto == "a*"')

    def test_unsatisfiable(self):
        space, compiled = space_of("port in 1..10 and not port in 1..10")
        self.assertTrue(space_is_empty(space, compiled.schema))

    def test_complement_intersection_empty(self):
        space, compiled = space_of("port in 1..10")
        comp = space_complement(space, compiled.schema, compiled.alphabet)
        self.assertTrue(
            space_is_empty(space_intersect(space, comp, compiled.schema), compiled.schema)
        )


if __name__ == "__main__":
    unittest.main()
