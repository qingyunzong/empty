import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "tests"))

from upval import (  # noqa: E402
    COMPILE_ERROR_EXIT,
    RUNTIME_ERROR_EXIT,
    CompileError,
    DuplicateDefError,
    Evaluator,
    FreeVarError,
    ReferenceInterpreter,
    UpvalRuntimeError,
    parse,
    resolve,
)
from randgen import Gen  # noqa: E402


def compile_and_run(src):
    """Compile with the real pipeline and run the cell-based evaluator."""
    program = parse(src)
    analysis = resolve(program)
    out = []
    result = Evaluator(out=out.append).run(program)
    return result, out, analysis


def reference_run(src):
    program = parse(src)
    out = []
    result = ReferenceInterpreter(out=out.append).run(program)
    return result, out


def find_fn(analysis, fn_id=None, kind=None):
    for info in analysis.to_dict()["functions"]:
        if fn_id is not None and info["id"] == fn_id:
            return info
        if kind is not None and info["kind"] == kind:
            return info
    raise AssertionError("function info not found")


def local_var(fn_info, name):
    for var in fn_info["locals"]:
        if var["var"] == name:
            return var
    raise AssertionError(f"local {name!r} not found")


MAKE_COUNTER = """
let pair = fn(x, y) {
  return fn(w) { if w == 0 { return x; } return y; };
};
let make_counter = fn() {
  let count = 0;
  let inc = fn() { count = count + 1; return count; };
  let get = fn() { return count; };
  return pair(inc, get);
};
let p = make_counter();
let inc = p(0);
let get = p(1);
print(inc());
print(inc());
print(get());
print(inc());
print(get());
return get();
"""


class TestSharedCells(unittest.TestCase):
    """Acceptance B: make_counter with two functions sharing one cell."""

    def test_make_counter_sequence(self):
        result, out, _ = compile_and_run(MAKE_COUNTER)
        self.assertEqual(out, ["1", "2", "2", "3", "3"])
        self.assertEqual(result, 3)

    def test_make_counter_reproducible(self):
        first = compile_and_run(MAKE_COUNTER)[:2]
        second = compile_and_run(MAKE_COUNTER)[:2]
        self.assertEqual(first, second)

    def test_count_is_boxed_and_shared(self):
        _, _, analysis = compile_and_run(MAKE_COUNTER)
        make_counter = find_fn(analysis, fn_id=3)
        count = local_var(make_counter, "count")
        self.assertTrue(count["boxed"])
        self.assertTrue(count["captured"])
        # Both inner functions capture the very same variable.
        inc = find_fn(analysis, fn_id=4)
        get = find_fn(analysis, fn_id=5)
        self.assertEqual(inc["captures"][0]["var"], "count")
        self.assertEqual(get["captures"][0]["var"], "count")
        self.assertEqual(inc["captures"][0]["level"], 1)
        self.assertEqual(get["captures"][0]["level"], 1)

    def test_assignment_visible_across_closures(self):
        src = """
        let pair = fn(x, y) {
          return fn(w) { if w == 0 { return x; } return y; };
        };
        let mk = fn() {
          let v = 10;
          let set = fn(n) { v = n; return v; };
          let get = fn() { return v; };
          return pair(set, get);
        };
        let p = mk();
        let set = p(0);
        let get = p(1);
        set(42);
        return get();
        """
        result, _, _ = compile_and_run(src)
        self.assertEqual(result, 42)


class TestEscapeAnalysis(unittest.TestCase):
    """Acceptance C: read-only non-escaping captures stay on the stack."""

    def test_readonly_nonescaping_not_boxed(self):
        src = """
        let x = 5;
        let get = fn() { return x + 1; };
        return get();
        """
        result, _, analysis = compile_and_run(src)
        self.assertEqual(result, 6)
        top = find_fn(analysis, kind="top")
        self.assertFalse(local_var(top, "x")["boxed"])
        self.assertTrue(local_var(top, "x")["captured"])

    def test_escaping_capture_is_boxed(self):
        src = """
        let x = 5;
        let get = fn() { return x + 1; };
        return get;
        """
        _, _, analysis = compile_and_run(src)
        top = find_fn(analysis, kind="top")
        self.assertTrue(local_var(top, "x")["boxed"])

    def test_local_never_captured_not_boxed(self):
        src = """
        let f = fn(a) { let tmp = a * 2; return tmp + 1; };
        return f(21);
        """
        result, _, analysis = compile_and_run(src)
        self.assertEqual(result, 43)
        fn = find_fn(analysis, kind="fn")
        self.assertFalse(local_var(fn, "tmp")["boxed"])
        self.assertFalse(local_var(fn, "a")["boxed"])

    def test_capture_dedup_first_occurrence_order(self):
        src = """
        let a = 1;
        let b = 2;
        let f = fn() { return b + a + b + a; };
        return f();
        """
        result, _, analysis = compile_and_run(src)
        self.assertEqual(result, 6)
        fn = find_fn(analysis, kind="fn")
        self.assertEqual([c["var"] for c in fn["captures"]], ["b", "a"])

    def test_recursive_name_visible_in_own_body(self):
        src = """
        let fact = fn(n) {
          if n <= 1 { return 1; }
          return n * fact(n - 1);
        };
        return fact(5);
        """
        result, _, _ = compile_and_run(src)
        self.assertEqual(result, 120)


class TestCompileErrors(unittest.TestCase):
    """Acceptance D: free variables and cross-level duplicates fail."""

    def test_free_var_top_level(self):
        with self.assertRaises(FreeVarError) as ctx:
            compile_and_run("return y + 1;")
        err = ctx.exception
        self.assertEqual(err.var, "y")
        self.assertEqual(err.level, 0)
        self.assertIsNotNone(err.span)

    def test_free_var_nested(self):
        src = "let f = fn() { return z + 1; };\nreturn f();"
        with self.assertRaises(FreeVarError) as ctx:
            compile_and_run(src)
        err = ctx.exception
        self.assertEqual(err.var, "z")
        self.assertEqual(err.level, 1)
        self.assertEqual(err.span, (22, 23))

    def test_free_var_deep_nesting(self):
        src = "let f = fn() { let g = fn() { return missing; }; return g(); };\nreturn f();"
        with self.assertRaises(FreeVarError) as ctx:
            compile_and_run(src)
        self.assertEqual(ctx.exception.var, "missing")
        self.assertEqual(ctx.exception.level, 2)

    def test_assign_to_undefined_is_free_var(self):
        with self.assertRaises(FreeVarError):
            compile_and_run("q = 3;")

    def test_cross_level_duplicate_definition(self):
        src = "let x = 1;\nlet f = fn() { let x = 2; return x; };\nreturn f();"
        with self.assertRaises(DuplicateDefError) as ctx:
            compile_and_run(src)
        err = ctx.exception
        self.assertEqual(err.var, "x")
        self.assertEqual(err.level, 1)
        self.assertIsNotNone(err.span)

    def test_same_level_duplicate_definition(self):
        with self.assertRaises(DuplicateDefError):
            compile_and_run("let x = 1;\nlet x = 2;")

    def test_duplicate_parameter(self):
        with self.assertRaises(DuplicateDefError):
            compile_and_run("let f = fn(a, a) { return a; };\nreturn f(1, 2);")

    def test_param_shadowing_outer_is_duplicate(self):
        src = "let a = 1;\nlet f = fn(a) { return a; };\nreturn f(2);"
        with self.assertRaises(DuplicateDefError):
            compile_and_run(src)


class TestRuntimeErrors(unittest.TestCase):
    def check_runtime(self, src, reason):
        program = parse(src)
        resolve(program)
        with self.assertRaises(UpvalRuntimeError) as ctx:
            Evaluator(out=lambda line: None).run(program)
        self.assertEqual(ctx.exception.reason, reason)

    def test_division_by_zero(self):
        self.check_runtime("return 1 / 0;", "DivByZero")

    def test_modulo_by_zero(self):
        self.check_runtime("return 1 % 0;", "DivByZero")

    def test_call_non_function(self):
        self.check_runtime("let x = 1;\nreturn x(2);", "NotCallable")

    def test_arity_mismatch(self):
        self.check_runtime("let f = fn(a, b) { return a; };\nreturn f(1);", "ArityMismatch")

    def test_uninitialized_read(self):
        self.check_runtime("let x = x + 1;\nreturn x;", "UninitializedVar")


class TestRandomPrograms(unittest.TestCase):
    """Acceptance A: 300 random closure programs, depth <= 3, cross-checked
    against the explicit-environment reference interpreter."""

    def test_random_programs_match_reference(self):
        for seed in range(300):
            src = Gen(seed).gen_program()
            with self.subTest(seed=seed):
                program = parse(src)
                resolve(program)
                out_cell, out_ref = [], []
                result_cell = Evaluator(out=out_cell.append).run(program)
                result_ref = ReferenceInterpreter(out=out_ref.append).run(program)
                self.assertEqual(result_cell, result_ref)
                self.assertEqual(out_cell, out_ref)


class TestCli(unittest.TestCase):
    def run_cli(self, src, *extra_args):
        with tempfile.NamedTemporaryFile(
            "w", suffix=".fn", delete=False
        ) as handle:
            handle.write(src)
            path = handle.name
        try:
            return subprocess.run(
                [sys.executable, "-m", "upval", path, *extra_args],
                capture_output=True,
                text=True,
                cwd=REPO_ROOT,
            )
        finally:
            os.unlink(path)

    def test_cli_run_success(self):
        proc = self.run_cli(MAKE_COUNTER, "--run")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = proc.stdout.strip().splitlines()
        self.assertEqual(lines, ["1", "2", "2", "3", "3", "=> 3"])

    def test_cli_compile_only(self):
        proc = self.run_cli("return 1 + 2;")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, "")

    def test_cli_debug_json(self):
        src = "let x = 5;\nlet get = fn() { return x + 1; };\nreturn get();"
        proc = self.run_cli(src, "--debug-json")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        debug = json.loads(proc.stdout)
        top = debug["functions"][0]
        x = [v for v in top["locals"] if v["var"] == "x"][0]
        self.assertFalse(x["boxed"])

    def test_cli_free_var_exit_10(self):
        proc = self.run_cli("return nope;", "--run")
        self.assertEqual(proc.returncode, COMPILE_ERROR_EXIT)
        payload = json.loads(proc.stderr)
        self.assertEqual(payload["error"], "FreeVar")
        self.assertEqual(payload["var"], "nope")
        self.assertEqual(payload["level"], 0)
        self.assertIsInstance(payload["span"], list)

    def test_cli_duplicate_def_exit_10(self):
        src = "let x = 1;\nlet f = fn() { let x = 2; return x; };\nreturn f();"
        proc = self.run_cli(src, "--run")
        self.assertEqual(proc.returncode, COMPILE_ERROR_EXIT)
        payload = json.loads(proc.stderr)
        self.assertEqual(payload["error"], "DuplicateDef")
        self.assertEqual(payload["var"], "x")

    def test_cli_runtime_error_exit_9(self):
        proc = self.run_cli("return 1 / 0;", "--run")
        self.assertEqual(proc.returncode, RUNTIME_ERROR_EXIT)
        payload = json.loads(proc.stderr)
        self.assertEqual(payload["error"], "RuntimeError")
        self.assertEqual(payload["reason"], "DivByZero")


if __name__ == "__main__":
    unittest.main()
