import unittest

from regex_deriv.syntax import (
    ALL, EMPTY, EPS, char, compl, concat, from_json, inter, star, to_json,
    union,
)

a = char(97, 97)
b = char(98, 98)
c = char(99, 99)


class TestNormalization(unittest.TestCase):
    def test_union_commutative_and_shared(self):
        self.assertIs(union(a, b), union(b, a))

    def test_union_idempotent(self):
        self.assertIs(union(a, a), a)
        self.assertIs(union(a, b, a, b), union(a, b))

    def test_union_associative_flattened(self):
        self.assertIs(union(union(a, b), c), union(a, union(b, c)))
        self.assertIs(union(a, b, c).tag, "union")
        self.assertEqual(len(union(a, b, c).args), 3)

    def test_union_empty_identity(self):
        self.assertIs(union(a, EMPTY), a)
        self.assertIs(union(EMPTY, EMPTY), EMPTY)

    def test_union_all_absorbs(self):
        self.assertIs(union(a, ALL), ALL)

    def test_union_complement_pair(self):
        self.assertIs(union(a, compl(a)), ALL)

    def test_inter_commutative_and_shared(self):
        self.assertIs(inter(a, b), inter(b, a))

    def test_inter_idempotent_and_flat(self):
        self.assertIs(inter(a, a), a)
        self.assertIs(inter(inter(a, b), c), inter(a, inter(b, c)))

    def test_inter_annihilator_and_identity(self):
        self.assertIs(inter(a, EMPTY), EMPTY)
        self.assertIs(inter(a, ALL), a)

    def test_inter_complement_pair(self):
        self.assertIs(inter(a, compl(a)), EMPTY)

    def test_concat_rules(self):
        self.assertIs(concat(a, EPS), a)
        self.assertIs(concat(EPS, a), a)
        self.assertIs(concat(a, EMPTY), EMPTY)
        self.assertIs(concat(EMPTY, a), EMPTY)
        self.assertIs(concat(EPS), EPS)
        self.assertIs(concat(concat(a, b), c), concat(a, concat(b, c)))

    def test_star_rules(self):
        self.assertIs(star(EMPTY), EPS)
        self.assertIs(star(EPS), EPS)
        self.assertIs(star(star(a)), star(a))

    def test_compl_involution(self):
        self.assertIs(compl(compl(a)), a)
        self.assertIs(compl(EMPTY), ALL)
        self.assertIs(compl(ALL), EMPTY)

    def test_char_empty_range(self):
        self.assertIs(char(5, 3), EMPTY)

    def test_hash_consing_shares_nodes(self):
        x = union(concat(a, star(b)), compl(c))
        y = union(compl(c), concat(a, star(b)))
        self.assertIs(x, y)

    def test_json_roundtrip(self):
        for node in (EMPTY, EPS, ALL, a, union(a, b), concat(a, star(b)),
                     inter(a, compl(b)), star(union(a, compl(EMPTY)))):
            self.assertIs(from_json(to_json(node)), node)


if __name__ == "__main__":
    unittest.main()
