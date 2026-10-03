"""Acceptance B and C: precedence boundaries and associativity."""

import unittest

from prattx import parse


def ops_tree(node):
    """Reduce an AST to a nested tuple of operator names."""
    if node["op"] in ("int", "ident"):
        return node.get("value", node.get("name"))
    if node["op"].startswith("unary"):
        return (node["op"], ops_tree(node["operand"]))
    if node["op"] == "?:":
        return ("?:", ops_tree(node["cond"]), ops_tree(node["then"]),
                ops_tree(node["else"]))
    if node["op"] == "call":
        return ("call", ops_tree(node["func"]),
                tuple(ops_tree(a) for a in node["args"]))
    if node["op"] == "[]":
        return ("[]", ops_tree(node["obj"]), ops_tree(node["index"]))
    return (node["op"], ops_tree(node["left"]), ops_tree(node["right"]))


class PrecedenceTest(unittest.TestCase):
    def test_unary_binds_looser_than_power(self):
        # B: -2**2 is unary minus applied to 2**2, not (-2)**2
        tree = ops_tree(parse("-2**2"))
        self.assertEqual(tree, ("unary-", ("**", 2, 2)))

    def test_power_exponent_may_be_unary(self):
        self.assertEqual(ops_tree(parse("2**-3")), ("**", 2, ("unary-", 3)))

    def test_power_right_associative(self):
        self.assertEqual(
            ops_tree(parse("2**3**4")), ("**", 2, ("**", 3, 4))
        )

    def test_assignment_right_associative(self):
        # C: a=b=c parses as a=(b=c)
        self.assertEqual(
            ops_tree(parse("a=b=c")), ("=", "a", ("=", "b", "c"))
        )

    def test_assignment_is_lowest(self):
        self.assertEqual(
            ops_tree(parse("a=b+c")),
            ("=", "a", ("+", "b", "c")),
        )
        self.assertEqual(
            ops_tree(parse("a||b=c")),
            ("=", ("||", "a", "b"), "c"),
        )

    def test_ternary_right_associative(self):
        # C: a?b:c?d:e parses as a?b:(c?d:e)
        self.assertEqual(
            ops_tree(parse("a?b:c?d:e")),
            ("?:", "a", "b", ("?:", "c", "d", "e")),
        )

    def test_left_associative_binaries(self):
        self.assertEqual(ops_tree(parse("a-b-c")), ("-", ("-", "a", "b"), "c"))
        self.assertEqual(
            ops_tree(parse("a<b<c")), ("<", ("<", "a", "b"), "c")
        )
        self.assertEqual(
            ops_tree(parse("a&&b&&c")), ("&&", ("&&", "a", "b"), "c")
        )

    def test_precedence_chain(self):
        self.assertEqual(
            ops_tree(parse("a+b*c==d&&e||f")),
            ("||", ("&&", ("==", ("+", "a", ("*", "b", "c")), "d"), "e"), "f"),
        )

    def test_postfix_binds_tightest(self):
        self.assertEqual(
            ops_tree(parse("-a[0]**f(1,2)")),
            ("unary-",
             ("**", ("[]", "a", 0), ("call", "f", (1, 2)))),
        )

    def test_explicit_parens_leave_no_node(self):
        # no implicit-parenthesis rewriting: (a+b)*c has no group nodes
        self.assertEqual(
            ops_tree(parse("(a+b)*c")), ("*", ("+", "a", "b"), "c")
        )

    def test_undeclared_identifier_is_not_an_error(self):
        tree = ops_tree(parse("never_declared + also_undeclared"))
        self.assertEqual(tree, ("+", "never_declared", "also_undeclared"))

    def test_node_fields_and_spans(self):
        ast = parse("a+1")
        self.assertEqual(ast["span"], [0, 3])
        self.assertEqual((ast["lbp"], ast["rbp"]), (50, 50))
        self.assertEqual(ast["left"]["span"], [0, 1])
        self.assertEqual(ast["right"]["span"], [2, 3])
        power = parse("2**3")
        self.assertEqual((power["lbp"], power["rbp"]), (70, 69))


if __name__ == "__main__":
    unittest.main()
