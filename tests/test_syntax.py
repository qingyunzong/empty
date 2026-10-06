import unittest

from regexamb import (
    parse_pattern, ast_to_json, ast_from_json, collect_nodes, fingerprint,
    LIT, EPS, ALT, CAT, STAR,
)


class TestPatternParser(unittest.TestCase):
    def test_stable_ids_are_deterministic(self):
        a = parse_pattern("(a|b)*c")
        b = parse_pattern("(a|b)*c")
        self.assertEqual(ast_to_json(a), ast_to_json(b))

    def test_kinds(self):
        root = parse_pattern("a|ε")
        self.assertEqual(root.kind, ALT)
        kinds = {n.kind for n in collect_nodes(root).values()}
        self.assertEqual(kinds, {ALT, LIT, EPS})

    def test_empty_group_is_eps(self):
        root = parse_pattern("a()b")
        kinds = [n.kind for n in collect_nodes(root).values()]
        self.assertIn(EPS, kinds)

    def test_star_and_cat(self):
        root = parse_pattern("(ab)*")
        self.assertEqual(root.kind, STAR)
        self.assertEqual(root.children[0].kind, CAT)

    def test_escape(self):
        root = parse_pattern(r"a\*b")
        lits = [n.char for n in collect_nodes(root).values() if n.kind == LIT]
        self.assertEqual(lits, ["a", "*", "b"])

    def test_syntax_error(self):
        with self.assertRaises(SyntaxError):
            parse_pattern("(a|b")
        with self.assertRaises(SyntaxError):
            parse_pattern("a)")


class TestAstJson(unittest.TestCase):
    def test_round_trip_preserves_ids(self):
        root = parse_pattern("(a|b)*c")
        clone = ast_from_json(ast_to_json(root))
        self.assertEqual(ast_to_json(root), ast_to_json(clone))
        self.assertEqual(fingerprint(root), fingerprint(clone))

    def test_explicit_ids_are_kept(self):
        data = {"id": 10, "kind": "alt", "children": [
            {"id": 11, "kind": "lit", "char": "a"},
            {"id": 12, "kind": "lit", "char": "a"},
        ]}
        root = ast_from_json(data)
        self.assertEqual(sorted(collect_nodes(root)), [10, 11, 12])

    def test_duplicate_ids_rejected(self):
        data = {"id": 1, "kind": "alt", "children": [
            {"id": 2, "kind": "lit", "char": "a"},
            {"id": 2, "kind": "lit", "char": "b"},
        ]}
        with self.assertRaises(ValueError):
            collect_nodes(ast_from_json(data))


if __name__ == "__main__":
    unittest.main()
