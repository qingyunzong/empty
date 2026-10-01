import unittest

from mtc.lang import parse_module, INT, BOOL, Import, Let, Fn, Add, Call, Var


class TestParser(unittest.TestCase):
    def test_let_with_annotation(self):
        stmts, imports, err = parse_module("let x: Int = 1\n")
        self.assertIsNone(err)
        self.assertEqual(len(stmts), 1)
        self.assertIsInstance(stmts[0], Let)
        self.assertEqual(stmts[0].annotation, INT)

    def test_let_inferred_and_add(self):
        stmts, _, err = parse_module("let x = 1\nlet y = x + 1\n")
        self.assertIsNone(err)
        self.assertIsInstance(stmts[1].expr, Add)
        self.assertIsInstance(stmts[1].expr.left, Var)

    def test_fn(self):
        stmts, _, err = parse_module("fn f(a: Int) -> Int = a + 1\n")
        self.assertIsNone(err)
        fn = stmts[0]
        self.assertIsInstance(fn, Fn)
        self.assertEqual(fn.params, [("a", INT)])
        self.assertEqual(fn.ret, INT)

    def test_import_collected(self):
        stmts, imports, err = parse_module("import b\nlet x = 1\n")
        self.assertIsNone(err)
        self.assertEqual(imports, ["b"])
        self.assertIsInstance(stmts[0], Import)

    def test_parse_error_line(self):
        stmts, imports, err = parse_module("let x = 1\nlet = 2\n")
        self.assertIsNone(stmts)
        self.assertIsNotNone(err)
        self.assertEqual(err.line, 2)

    def test_parse_error_keeps_partial_imports(self):
        _stmts, imports, err = parse_module("import a\nlet = \n")
        self.assertIsNotNone(err)
        self.assertEqual(imports, ["a"])

    def test_call_and_bool(self):
        stmts, _, err = parse_module("let x = f(1, true)\n")
        self.assertIsNone(err)
        call = stmts[0].expr
        self.assertIsInstance(call, Call)
        self.assertEqual(len(call.args), 2)

    def test_bad_character(self):
        _stmts, _imports, err = parse_module("let x = 1 $\n")
        self.assertIsNotNone(err)
        self.assertEqual(err.line, 1)


if __name__ == "__main__":
    unittest.main()
