"""Unit tests for the per-module type checker."""
import unittest

from mmcheck.checker import E_NAME, E_TYPE, check_module
from mmcheck.lang import INT, TFun, parse


def check(src, import_exports=None):
    return check_module(parse(src), import_exports or {})


class TestChecker(unittest.TestCase):
    def test_clean_module(self):
        diags, exports = check(
            "let x: Int = 1\n"
            "let y = x + 1\n"
            "fun add(a: Int, b: Int) -> Int = a + b\n"
            "let z: Int = add(x, y)\n"
        )
        self.assertEqual(diags, [])
        self.assertEqual(exports["x"], INT)
        self.assertEqual(exports["add"], TFun((INT, INT), INT))

    def test_undefined_name(self):
        diags, _ = check("let y = nope + 1\n")
        self.assertEqual(len(diags), 1)
        self.assertEqual(diags[0].code, E_NAME)
        self.assertIn("nope", diags[0].message)
        self.assertEqual(diags[0].line, 1)

    def test_annotation_mismatch(self):
        diags, _ = check(
            "fun f(a: Int) -> Int = a\n"
            "let x: Int = f\n"
        )
        self.assertTrue(any(d.code == E_TYPE for d in diags))

    def test_arity_mismatch(self):
        diags, _ = check(
            "fun f(a: Int) -> Int = a\n"
            "let x = f(1, 2)\n"
        )
        self.assertEqual(len(diags), 1)
        self.assertEqual(diags[0].code, E_TYPE)
        self.assertIn("argument", diags[0].message)

    def test_call_non_function(self):
        diags, _ = check("let x = 1\nlet y = x(2)\n")
        self.assertTrue(any(d.code == E_TYPE and "cannot call" in d.message for d in diags))

    def test_arithmetic_on_function(self):
        diags, _ = check(
            "fun f(a: Int) -> Int = a\n"
            "let y = f + 1\n"
        )
        self.assertTrue(any(d.code == E_TYPE and "operator" in d.message for d in diags))

    def test_return_type_mismatch(self):
        diags, _ = check(
            "fun g(a: Int) -> Int = a\n"
            "fun f(a: Int) -> Int = g\n"
        )
        self.assertTrue(any(d.code == E_TYPE and "should return" in d.message for d in diags))

    def test_duplicate_definition(self):
        diags, _ = check("let x = 1\nlet x = 2\n")
        self.assertTrue(any(d.code == E_NAME and "duplicate" in d.message for d in diags))

    def test_unknown_module_import(self):
        diags, _ = check("import ghost\n")
        self.assertEqual(diags[0].code, E_NAME)
        self.assertIn("ghost", diags[0].message)

    def test_imported_names_usable(self):
        exports = {"inc": TFun((INT,), INT), "ten": INT}
        diags, out = check("import base\nlet x: Int = inc(ten)\n", {"base": exports})
        self.assertEqual(diags, [])
        self.assertEqual(out["x"], INT)
        self.assertNotIn("inc", out)  # imports are not re-exported

    def test_forward_reference(self):
        diags, exports = check("let a = b + 1\nlet b = 2\n")
        self.assertEqual(diags, [])
        self.assertEqual(exports["a"], INT)


if __name__ == "__main__":
    unittest.main()
