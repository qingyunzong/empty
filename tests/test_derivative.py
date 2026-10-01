import unittest

from regex_deriv.alphabet import Alphabet
from regex_deriv.derivative import derive, partition
from regex_deriv.syntax import EMPTY, EPS, char, compl, concat, star, union

a = char(97, 97)
b = char(98, 98)


class TestDerivative(unittest.TestCase):
    def test_char(self):
        self.assertIs(derive(a, 97), EPS)
        self.assertIs(derive(a, 98), EMPTY)

    def test_empty_eps(self):
        self.assertIs(derive(EMPTY, 97), EMPTY)
        self.assertIs(derive(EPS, 97), EMPTY)

    def test_concat(self):
        r = concat(a, b)
        self.assertIs(derive(r, 97), b)
        self.assertIs(derive(r, 98), EMPTY)

    def test_concat_nullable_head(self):
        r = concat(star(a), b)
        self.assertIs(derive(r, 98), EPS)
        self.assertIs(derive(r, 97), r)  # a a* b | b  ==  a* b

    def test_union(self):
        self.assertIs(derive(union(a, b), 97), EPS)
        self.assertIs(derive(union(a, b), 99), EMPTY)

    def test_inter(self):
        from regex_deriv.syntax import inter
        r = inter(union(a, b), union(b, char(99, 99)))
        self.assertIs(derive(r, 97), EMPTY)
        self.assertIs(derive(r, 98), EPS)

    def test_compl(self):
        self.assertIs(derive(compl(a), 97), compl(EPS))
        self.assertIs(derive(compl(a), 98), compl(EMPTY))

    def test_star(self):
        s = star(a)
        self.assertIs(derive(s, 97), concat(EPS, s))
        self.assertIs(derive(s, 97), s)  # eps a* == a*

    def test_memoized_identity(self):
        r = star(union(a, b))
        self.assertIs(derive(r, 97), derive(r, 97))


class TestPartition(unittest.TestCase):
    def test_interval_endpoints(self):
        alpha = Alphabet.from_string("az")  # {a, z}
        parts = partition(alpha, char(97, 97))
        self.assertEqual(parts, [(97, 97), (122, 122)])

    def test_split_inside_alphabet(self):
        alpha = Alphabet([(97, 122)])
        parts = partition(alpha, char(99, 102))  # [c-f]
        self.assertEqual(parts, [(97, 98), (99, 102), (103, 122)])

    def test_multiple_nodes(self):
        alpha = Alphabet([(97, 122)])
        parts = partition(alpha, char(97, 100), char(99, 105))
        self.assertEqual(parts, [(97, 98), (99, 100), (101, 105), (106, 122)])

    def test_multi_range_alphabet(self):
        alpha = Alphabet([(97, 99), (103, 105)])  # a-c, g-i
        parts = partition(alpha, char(98, 104))
        self.assertEqual(parts, [(97, 97), (98, 99), (103, 104), (105, 105)])

    def test_uniformity(self):
        # derivative is constant on each atomic interval
        alpha = Alphabet([(97, 122)])
        node = union(char(99, 102), concat(char(106, 106), char(97, 122)))
        for lo, hi in partition(alpha, node):
            d = derive(node, lo)
            for cp in range(lo, hi + 1):
                self.assertIs(derive(node, cp), d)


if __name__ == "__main__":
    unittest.main()
