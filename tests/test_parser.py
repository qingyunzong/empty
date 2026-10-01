"""Parser tests: valid policies, AST shape, and E_PARSE positions (item D)."""

import unittest

from shadowc import nodes
from shadowc.errors import PolicyError
from shadowc.parser import parse_policy


def parse_ok(source):
    return parse_policy(source)


class TestValidParsing(unittest.TestCase):
    def test_full_policy(self):
        policy = parse_ok(
            "# a comment\n"
            "field port: int\n"
            "field proto: string\n"
            "field role: enum(admin, user)\n"
            "action allow\n"
            "action deny\n"
            "rule r1 when port in 1..1024 and proto == \"tcp*\" then allow, deny\n"
            "rule r2 when role in {admin, user} or not port == 7 then deny\n"
        )
        self.assertEqual([f.name for f in policy.fields], ["port", "proto", "role"])
        self.assertEqual(policy.fields[2].ftype.domain, ("admin", "user"))
        self.assertEqual(policy.actions, ["allow", "deny"])
        self.assertEqual([r.name for r in policy.rules], ["r1", "r2"])
        self.assertEqual(policy.rules[0].actions, ["allow", "deny"])
        self.assertEqual(policy.rules[0].line, 7)
        self.assertEqual(policy.rules[1].line, 8)

    def test_precedence_and_parentheses(self):
        policy = parse_ok(
            "field port: int\n"
            "action allow\n"
            "rule r1 when port == 1 and port == 2 or port == 3 then allow\n"
            "rule r2 when not port == 1 and port == 2 then allow\n"
            "rule r3 when port == 1 and (port == 2 or port == 3) then allow\n"
        )
        r1, r2, r3 = [r.cond for r in policy.rules]
        self.assertIsInstance(r1, nodes.Or)
        self.assertIsInstance(r1.left, nodes.And)
        self.assertIsInstance(r2, nodes.And)
        self.assertIsInstance(r2.left, nodes.Not)
        self.assertIsInstance(r3, nodes.And)
        self.assertIsInstance(r3.right, nodes.Or)

    def test_atom_shapes(self):
        policy = parse_ok(
            "field port: int\n"
            "field proto: string\n"
            "field role: enum(admin, user)\n"
            "action allow\n"
            "rule r1 when port in 1..10 then allow\n"
            "rule r2 when port in {1, 2, 3} then allow\n"
            "rule r3 when proto == \"tcp*\" then allow\n"
            "rule r4 when proto == \"udp\" then allow\n"
            "rule r5 when role == admin then allow\n"
        )
        c = [r.cond for r in policy.rules]
        self.assertIsInstance(c[0], nodes.Interval)
        self.assertEqual((c[0].lo, c[0].hi), (1, 10))
        self.assertIsInstance(c[1], nodes.IntValues)
        self.assertEqual(c[1].values, frozenset({1, 2, 3}))
        self.assertIsInstance(c[2], nodes.StrPatterns)
        self.assertEqual(c[2].patterns, (("tcp", True),))
        self.assertEqual(c[3].patterns, (("udp", False),))
        self.assertIsInstance(c[4], nodes.EnumValues)
        self.assertEqual(c[4].values, frozenset({"admin"}))


class TestParseErrors(unittest.TestCase):
    def check_err(self, source, line, col, msg_part=""):
        with self.assertRaises(PolicyError) as ctx:
            parse_policy(source)
        err = ctx.exception
        self.assertEqual(err.code, "E_PARSE")
        self.assertEqual((err.line, err.col), (line, col), f"source={source!r}: {err}")
        if msg_part:
            self.assertIn(msg_part, err.message)
        return err

    def test_unknown_field(self):
        self.check_err(
            "field port: int\naction allow\nrule r1 when ports == 1 then allow",
            3, 14, "unknown field",
        )

    def test_unknown_action(self):
        self.check_err(
            "field port: int\naction allow\nrule r1 when port == 1 then drop",
            3, 29, "unknown action",
        )

    def test_unknown_enum_value(self):
        self.check_err(
            "field role: enum(admin, user)\naction allow\n"
            "rule r1 when role == root then allow",
            3, 22, "unknown value",
        )

    def test_empty_body_at_eof(self):
        self.check_err(
            "field port: int\naction allow\nrule r1 when port == 1 then",
            3, 28, "empty rule body",
        )

    def test_empty_body_before_next_rule(self):
        self.check_err(
            "field port: int\naction allow\n"
            "rule r1 when port == 1 then\n"
            "rule r2 when port == 2 then allow",
            4, 1, "empty rule body",
        )

    def test_unexpected_character(self):
        self.check_err("field port: int\n@", 2, 1, "unexpected character")

    def test_missing_value(self):
        self.check_err(
            "field port: int\naction allow\nrule r1 when port == then allow",
            3, 22, "expected a value",
        )

    def test_interval_on_string_field(self):
        self.check_err(
            "field proto: string\naction allow\nrule r1 when proto in 1..10 then allow",
            3, 14, "intervals require an int field",
        )

    def test_empty_interval(self):
        self.check_err(
            "field port: int\naction allow\nrule r1 when port in 10..1 then allow",
            3, 22, "empty interval",
        )

    def test_unterminated_string(self):
        self.check_err(
            'field proto: string\naction allow\nrule r1 when proto == "tcp then allow',
            3, 23, "unterminated string",
        )

    def test_misplaced_wildcard(self):
        self.check_err(
            'field proto: string\naction allow\nrule r1 when proto == "t*p" then allow',
            3, 23, "wildcard",
        )

    def test_missing_colon(self):
        self.check_err("field port int", 1, 12, "expected ':'")

    def test_keyword_as_identifier(self):
        self.check_err("field when: int", 1, 7, "expected field name")

    def test_duplicate_field(self):
        self.check_err("field port: int\nfield port: int", 2, 7, "duplicate field")

    def test_string_value_on_int_field(self):
        self.check_err(
            'field port: int\naction allow\nrule r1 when port == "x" then allow',
            3, 22, "expected an integer",
        )

    def test_wildcard_on_enum_field(self):
        self.check_err(
            'field role: enum(admin, user)\naction allow\n'
            'rule r1 when role == "adm*" then allow',
            3, 22, "enum",
        )


if __name__ == "__main__":
    unittest.main()
