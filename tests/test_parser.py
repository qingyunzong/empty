import unittest

from prattx import parse
from tests.oracle import normalize


def shape(source):
    return normalize(parse(source))


class TestAssociativityAndPrecedence(unittest.TestCase):
    def test_unary_binds_looser_than_power(self):
        # Acceptance B: -2**2 is unary minus applied to 2**2.
        self.assertEqual(
            shape("-2**2"),
            ("unary", "-", ("binary", "**", ("int", 2), ("int", 2))),
        )

    def test_power_is_right_associative(self):
        self.assertEqual(
            shape("2**3**4"),
            ("binary", "**", ("int", 2), ("binary", "**", ("int", 3), ("int", 4))),
        )

    def test_assignment_is_right_associative(self):
        # Acceptance C.
        self.assertEqual(
            shape("a=b=c"),
            ("binary", "=", ("ident", "a"), ("binary", "=", ("ident", "b"), ("ident", "c"))),
        )

    def test_ternary_is_right_associative(self):
        # Acceptance C.
        self.assertEqual(
            shape("a?b:c?d:e"),
            (
                "ternary",
                ("ident", "a"),
                ("ident", "b"),
                ("ternary", ("ident", "c"), ("ident", "d"), ("ident", "e")),
            ),
        )

    def test_assignment_is_lowest(self):
        self.assertEqual(
            shape("a=b+c"),
            ("binary", "=", ("ident", "a"), ("binary", "+", ("ident", "b"), ("ident", "c"))),
        )
        self.assertEqual(
            shape("a?b:c=d"),
            (
                "binary",
                "=",
                ("ternary", ("ident", "a"), ("ident", "b"), ("ident", "c")),
                ("ident", "d"),
            ),
        )

    def test_other_binary_ops_left_associative(self):
        for op in ["+", "-", "*", "/", "%", "==", "!=", "<", "<=", ">", ">=", "&&", "||"]:
            with self.subTest(op=op):
                self.assertEqual(
                    shape("a%sb%sc" % (op, op)),
                    (
                        "binary",
                        op,
                        ("binary", op, ("ident", "a"), ("ident", "b")),
                        ("ident", "c"),
                    ),
                )

    def test_precedence_ordering(self):
        self.assertEqual(
            shape("1+2*3"),
            ("binary", "+", ("int", 1), ("binary", "*", ("int", 2), ("int", 3))),
        )
        self.assertEqual(
            shape("a&&b||c"),
            ("binary", "||", ("binary", "&&", ("ident", "a"), ("ident", "b")), ("ident", "c")),
        )
        self.assertEqual(
            shape("a==b&&c"),
            ("binary", "&&", ("binary", "==", ("ident", "a"), ("ident", "b")), ("ident", "c")),
        )
        self.assertEqual(
            shape("a+b<c"),
            ("binary", "<", ("binary", "+", ("ident", "a"), ("ident", "b")), ("ident", "c")),
        )

    def test_postfix_binds_tightest(self):
        self.assertEqual(
            shape("f(1,2)[3]**2"),
            (
                "binary",
                "**",
                (
                    "index",
                    ("call", ("ident", "f"), (("int", 1), ("int", 2))),
                    ("int", 3),
                ),
                ("int", 2),
            ),
        )

    def test_call_and_index(self):
        self.assertEqual(
            shape("f(a,b)"),
            ("call", ("ident", "f"), (("ident", "a"), ("ident", "b"))),
        )
        self.assertEqual(shape("f()"), ("call", ("ident", "f"), ()))
        self.assertEqual(
            shape("a[i]"), ("index", ("ident", "a"), ("ident", "i"))
        )
        self.assertEqual(
            shape("a[1][2]"),
            ("index", ("index", ("ident", "a"), ("int", 1)), ("int", 2)),
        )

    def test_no_implicit_parentheses(self):
        # Grouping parens must not appear as AST nodes nor reorder operators.
        node = parse("(1+2)*3")
        self.assertEqual(
            normalize(node),
            ("binary", "*", ("binary", "+", ("int", 1), ("int", 2)), ("int", 3)),
        )
        self.assertEqual(shape("((a))"), ("ident", "a"))

        def walk(n):
            self.assertNotIn(n["type"], ("paren", "group"))
            for key in ("operand", "left", "right", "cond", "then", "else", "func", "target", "index"):
                if key in n:
                    walk(n[key])
            for arg in n.get("args", []):
                walk(arg)

        walk(node)

    def test_node_fields(self):
        # Every node carries op, lbp, rbp, span.
        def walk(n):
            for key in ("op", "lbp", "rbp", "span"):
                self.assertIn(key, n)
            self.assertEqual(len(n["span"]), 2)
            self.assertLessEqual(n["span"][0], n["span"][1])
            for key in ("operand", "left", "right", "cond", "then", "else", "func", "target", "index"):
                if key in n:
                    walk(n[key])
            for arg in n.get("args", []):
                walk(arg)

        walk(parse("-a**f(1,2)[i]?b:c=d"))

    def test_spans(self):
        node = parse("1 + 22")
        self.assertEqual(node["span"], [0, 6])
        self.assertEqual(node["left"]["span"], [0, 1])
        self.assertEqual(node["right"]["span"], [4, 6])
        self.assertEqual(parse("- 1")["span"], [0, 3])
        self.assertEqual(parse("f(1,2)")["span"], [0, 6])
        self.assertEqual(parse("a ? b : c")["span"], [0, 9])

    def test_undeclared_identifiers_are_not_errors(self):
        node = parse("totally_undeclared + other_name")
        self.assertEqual(node["type"], "binary")


if __name__ == "__main__":
    unittest.main()
