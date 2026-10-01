import unittest

from mtc.checker import check_module, E_PARSE, E_NAME, E_TYPE
from mtc.lang import INT, BOOL, FN


def check(source, deps=None):
    return check_module("m", source, deps or {})


class TestChecker(unittest.TestCase):
    def test_clean_module(self):
        res = check("let x: Int = 1\nlet y = x + 1\nfn f(a: Int) -> Int = a + y\n")
        self.assertEqual(res.diagnostics, [])
        self.assertEqual(res.exports["x"], INT)
        self.assertEqual(res.exports["y"], INT)
        self.assertEqual(res.exports["f"], FN([INT], INT))

    def test_parse_error(self):
        res = check("let = 1\n")
        self.assertEqual(len(res.diagnostics), 1)
        self.assertEqual(res.diagnostics[0].code, E_PARSE)
        self.assertEqual(res.diagnostics[0].line, 1)
        self.assertEqual(res.exports, {})

    def test_undefined_name(self):
        res = check("let y = x + 1\n")
        codes = [d.code for d in res.diagnostics]
        self.assertEqual(codes, [E_NAME])

    def test_no_cascading_from_unknown(self):
        res = check("let y = x + 1\nlet z = y + 2\n")
        self.assertEqual([d.code for d in res.diagnostics], [E_NAME])

    def test_annotation_mismatch(self):
        res = check("let x: Int = true\n")
        self.assertEqual([d.code for d in res.diagnostics], [E_TYPE])

    def test_add_type_error(self):
        res = check("let x = 1 + true\n")
        self.assertEqual([d.code for d in res.diagnostics], [E_TYPE])

    def test_fn_return_mismatch(self):
        res = check("fn f(a: Int) -> Int = true\n")
        self.assertEqual([d.code for d in res.diagnostics], [E_TYPE])

    def test_call_arg_type(self):
        res = check("fn f(a: Int) -> Int = a\nlet y = f(true)\n")
        self.assertEqual([d.code for d in res.diagnostics], [E_TYPE])

    def test_call_arity(self):
        res = check("fn f(a: Int) -> Int = a\nlet y = f(1, 2)\n")
        self.assertEqual([d.code for d in res.diagnostics], [E_TYPE])

    def test_call_non_function(self):
        res = check("let x = 1\nlet y = x(2)\n")
        self.assertEqual([d.code for d in res.diagnostics], [E_TYPE])

    def test_unknown_module_import(self):
        res = check("import ghost\nlet x = 1\n")
        self.assertEqual([d.code for d in res.diagnostics], [E_NAME])

    def test_imported_names_visible(self):
        deps = {"a": {"v": INT, "f": FN([INT], BOOL)}}
        res = check("import a\nlet x = v + 1\nlet b = f(x)\n", deps)
        self.assertEqual(res.diagnostics, [])
        self.assertEqual(res.exports["b"], BOOL)

    def test_imported_type_enforced(self):
        deps = {"a": {"f": FN([BOOL], INT)}}
        res = check("import a\nlet x = f(1)\n", deps)
        self.assertEqual([d.code for d in res.diagnostics], [E_TYPE])

    def test_duplicate_definition(self):
        res = check("let x = 1\nlet x = 2\n")
        self.assertEqual([d.code for d in res.diagnostics], [E_NAME])

    def test_exports_deterministic_despite_errors(self):
        res = check("let x: Int = true\nfn f(a: Int) -> Bool = a\n")
        self.assertEqual(res.exports["x"], INT)
        self.assertEqual(res.exports["f"], FN([INT], BOOL))


if __name__ == "__main__":
    unittest.main()
