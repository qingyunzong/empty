import json
import os
import random
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import upval
from upval.errors import ArityError, DivZero, DuplicateDef, FreeVar

ROOT = Path(__file__).resolve().parent.parent


def run_cli(path, *args):
    return subprocess.run(
        [sys.executable, "-m", "upval", str(path), *args],
        cwd=ROOT, capture_output=True, text=True,
    )


class CliCase(unittest.TestCase):
    def run_src(self, src, *args):
        fd, path = tempfile.mkstemp(suffix=".fn")
        try:
            with os.fdopen(fd, "w") as handle:
                handle.write(src)
            return run_cli(path, *args)
        finally:
            os.unlink(path)


# ---------------------------------------------------------------------
# Acceptance B: make_counter with two functions sharing one cell
# ---------------------------------------------------------------------

MAKE_COUNTER = """
let inc = 0;
let get = 0;
let make_counter = fn() {
    let count = 0;
    inc = fn() { count = count + 1; count };
    get = fn() { count };
    0
};
make_counter();
inc();
inc();
inc();
get();
"""


class TestMakeCounter(CliCase):
    def test_shared_cell_result(self):
        top = upval.compile_source(MAKE_COUNTER)
        self.assertEqual(upval.run_compiled(top), 3)
        self.assertEqual(upval.run_reference(top), 3)

    def test_shared_cell_in_debug_json(self):
        top = upval.compile_source(MAKE_COUNTER)
        debug = upval.debug_dict(top)
        counter = next(f for f in debug["functions"] if f["name"] == "make_counter")
        count_local = next(l for l in counter["locals"] if l["name"] == "count")
        self.assertTrue(count_local["boxed"])
        capturers = [
            f for f in debug["functions"]
            if any(u["name"] == "count" for u in f["upvalues"])
        ]
        self.assertEqual(len(capturers), 2)  # inc and get share one cell

    def test_cli_reproducible(self):
        first = self.run_src(MAKE_COUNTER, "--run")
        second = self.run_src(MAKE_COUNTER, "--run")
        self.assertEqual(first.returncode, 0)
        self.assertEqual(first.stdout, "3\n")
        self.assertEqual(first.stdout, second.stdout)


# ---------------------------------------------------------------------
# Acceptance C: read-only, non-escaping captures must not be boxed
# ---------------------------------------------------------------------

NON_ESCAPING = """
let f = fn() {
    let x = 7;
    let g = fn() { x + 1 };
    g()
};
f();
"""

ESCAPING = """
let f = fn() {
    let x = 7;
    let g = fn() { x + 1 };
    g
};
f()();
"""


class TestEscapeAnalysis(unittest.TestCase):
    def local(self, debug, fn_name, local_name):
        fn = next(f for f in debug["functions"] if f["name"] == fn_name)
        return next(l for l in fn["locals"] if l["name"] == local_name)

    def test_readonly_nonescaping_not_boxed(self):
        top = upval.compile_source(NON_ESCAPING)
        debug = upval.debug_dict(top)
        self.assertFalse(self.local(debug, "f", "x")["boxed"])
        # still evaluated correctly through the frame reference
        self.assertEqual(upval.run_compiled(top), 8)
        self.assertEqual(upval.run_reference(top), 8)

    def test_escaping_capture_is_boxed(self):
        top = upval.compile_source(ESCAPING)
        debug = upval.debug_dict(top)
        self.assertTrue(self.local(debug, "f", "x")["boxed"])
        self.assertEqual(upval.run_compiled(top), 8)
        self.assertEqual(upval.run_reference(top), 8)

    def test_transitive_escape_is_boxed(self):
        # the inner closure rides out through a non-escaping middle
        # function's return value, so x is reachable after f returns
        src = """
let f = fn() {
    let x = 1;
    let c = fn() { fn() { x } };
    let h = c();
    h
};
let g = f();
g();
"""
        top = upval.compile_source(src)
        debug = upval.debug_dict(top)
        self.assertTrue(self.local(debug, "f", "x")["boxed"])
        self.assertEqual(upval.run_compiled(top), 1)
        self.assertEqual(upval.run_reference(top), 1)

    def test_capture_dedup_first_occurrence_order(self):
        src = """
let f = fn() {
    let a = 1;
    let b = 2;
    let g = fn() { b + a + b + a };
    g()
};
f();
"""
        top = upval.compile_source(src)
        debug = upval.debug_dict(top)
        g = next(f for f in debug["functions"] if f["name"] == "g")
        self.assertEqual([u["name"] for u in g["upvalues"]], ["b", "a"])
        self.assertEqual(upval.run_compiled(top), 6)


# ---------------------------------------------------------------------
# Acceptance D: FreeVar and duplicate definitions
# ---------------------------------------------------------------------


class TestErrors(CliCase):
    def test_freevar_toplevel(self):
        with self.assertRaises(FreeVar) as ctx:
            upval.compile_source("let x = y + 1;")
        err = ctx.exception
        self.assertEqual(err.var, "y")
        self.assertEqual(err.level, 0)
        self.assertIsNotNone(err.span)

    def test_freevar_nested_level(self):
        src = "let f = fn() { let g = fn() { missing }; 0 };"
        with self.assertRaises(FreeVar) as ctx:
            upval.compile_source(src)
        self.assertEqual(ctx.exception.var, "missing")
        self.assertEqual(ctx.exception.level, 2)

    def test_duplicate_same_level(self):
        with self.assertRaises(DuplicateDef) as ctx:
            upval.compile_source("let x = 1; let x = 2;")
        self.assertEqual(ctx.exception.var, "x")

    def test_duplicate_across_levels(self):
        src = "let x = 1; let f = fn() { let x = 2; x };"
        with self.assertRaises(DuplicateDef) as ctx:
            upval.compile_source(src)
        self.assertEqual(ctx.exception.var, "x")
        self.assertEqual(ctx.exception.level, 1)

    def test_duplicate_param(self):
        with self.assertRaises(DuplicateDef):
            upval.compile_source("let f = fn(a, a) { a };")

    def test_recursive_name_visible(self):
        src = "let fact = fn(n) { if n <= 1 { 1 } else { n * fact(n - 1) } }; fact(10);"
        top = upval.compile_source(src)
        self.assertEqual(upval.run_compiled(top), 3628800)
        self.assertEqual(upval.run_reference(top), 3628800)

    def test_nested_recursion(self):
        src = """
let outer = fn() {
    let fib = fn(n) { if n <= 1 { n } else { fib(n - 1) + fib(n - 2) } };
    fib(10)
};
outer();
"""
        top = upval.compile_source(src)
        self.assertEqual(upval.run_compiled(top), 55)
        self.assertEqual(upval.run_reference(top), 55)

    def test_runtime_errors(self):
        with self.assertRaises(DivZero):
            upval.run_source("let x = 1 / 0; x;")
        with self.assertRaises(ArityError):
            upval.run_source("let f = fn(a) { a }; f();")

    def test_cli_exit_codes(self):
        ok = self.run_src("let x = 1 + 2; x;", "--run")
        self.assertEqual(ok.returncode, 0)
        self.assertEqual(ok.stdout, "3\n")

        compile_err = self.run_src("let x = y;", "--run")
        self.assertEqual(compile_err.returncode, 10)
        payload = json.loads(compile_err.stderr)
        self.assertEqual(payload["error"], "FreeVar")
        self.assertEqual(payload["var"], "y")
        self.assertEqual(payload["level"], 0)
        self.assertIsNotNone(payload["span"])

        runtime_err = self.run_src("let x = 1 % 0; x;", "--run")
        self.assertEqual(runtime_err.returncode, 9)
        payload = json.loads(runtime_err.stderr)
        self.assertEqual(payload["error"], "DivZero")

        arity_err = self.run_src("let f = fn(a) { a }; f(1, 2);", "--run")
        self.assertEqual(arity_err.returncode, 9)
        self.assertEqual(json.loads(arity_err.stderr)["error"], "ArityError")

    def test_cli_debug_json(self):
        proc = self.run_src(MAKE_COUNTER, "--debug")
        self.assertEqual(proc.returncode, 0)
        debug = json.loads(proc.stdout)
        self.assertIn("functions", debug)
        names = {f["name"] for f in debug["functions"]}
        self.assertIn("make_counter", names)


# ---------------------------------------------------------------------
# Acceptance A: 300 random closure programs (depth <= 3), differential
# test against the explicit-environment reference interpreter
# ---------------------------------------------------------------------


class Gen:
    """Random generator of terminating, well-typed closure programs."""

    def __init__(self, rng):
        self.rng = rng
        self.n = 0
        self.scopes = [[]]

    def fresh(self, prefix):
        self.n += 1
        return f"{prefix}{self.n}"

    def visible_ints(self):
        return [name for scope in self.scopes for name, kind in scope if kind == "int"]

    def visible_fns(self):
        return [(name, kind[1]) for scope in self.scopes
                for name, kind in scope if kind != "int"]

    def program(self):
        lines = self.stmts(0, self.rng.randint(3, 6))
        lines.append(self.int_expr(0, 3) + ";")
        return "\n".join(lines) + "\n"

    def stmts(self, depth, count):
        out = []
        for _ in range(count):
            r = self.rng.random()
            if r < 0.30:
                name = self.fresh("v")
                out.append(f"let {name} = {self.int_expr(depth, 3)};")
                self.scopes[-1].append((name, "int"))
            elif r < 0.55 and depth < 3:
                fname = self.fresh("f")
                arity = self.rng.randint(0, 2)
                params = [self.fresh("p") for _ in range(arity)]
                self.scopes.append([(p, "int") for p in params])
                body = self.stmts(depth + 1, self.rng.randint(1, 4))
                body.append(self.int_expr(depth + 1, 3) + ";")
                self.scopes.pop()
                self.scopes[-1].append((fname, ("fn", arity)))
                out.append(
                    f"let {fname} = fn({', '.join(params)}) {{\n"
                    + "\n".join(body) + "\n};"
                )
            elif r < 0.70:
                ints = self.visible_ints()
                if ints:
                    out.append(f"{self.rng.choice(ints)} = {self.int_expr(depth, 2)};")
                else:
                    name = self.fresh("v")
                    out.append(f"let {name} = {self.int_expr(depth, 2)};")
                    self.scopes[-1].append((name, "int"))
            elif r < 0.85:
                fns = self.visible_fns()
                if fns:
                    name, arity = self.rng.choice(fns)
                    args = ", ".join(self.int_expr(depth, 2) for _ in range(arity))
                    out.append(f"{name}({args});")
                else:
                    out.append(self.int_expr(depth, 2) + ";")
            else:
                out.append(self.int_expr(depth, 2) + ";")
        return out

    def int_expr(self, depth, fuel):
        r = self.rng.random()
        ints = self.visible_ints()
        if fuel <= 0 or r < 0.25:
            if ints and self.rng.random() < 0.7:
                return self.rng.choice(ints)
            return str(self.rng.randint(-20, 20))
        if r < 0.60:
            op = self.rng.choice(["+", "-", "*"])
            return f"({self.int_expr(depth, fuel - 1)} {op} {self.int_expr(depth, fuel - 1)})"
        if r < 0.70:
            op = self.rng.choice(["/", "%"])
            # divisor is always in 1..15, never zero
            denom = f"(({self.int_expr(depth, fuel - 1)}) % 7) + 8"
            return f"({self.int_expr(depth, fuel - 1)} {op} ({denom}))"
        if r < 0.80:
            fns = self.visible_fns()
            if fns:
                name, arity = self.rng.choice(fns)
                args = ", ".join(self.int_expr(depth, fuel - 1) for _ in range(arity))
                return f"{name}({args})"
            return str(self.rng.randint(-9, 9))
        if r < 0.90:
            cond = self.cond(depth, fuel - 1)
            then = self.int_expr(depth, fuel - 1)
            other = self.int_expr(depth, fuel - 1)
            return f"(if {cond} {{ {then} }} else {{ {other} }})"
        return f"(0 - {self.int_expr(depth, fuel - 1)})"

    def cond(self, depth, fuel):
        op = self.rng.choice(["<", "<=", "==", "!=", ">", ">="])
        return f"{self.int_expr(depth, fuel)} {op} {self.int_expr(depth, fuel)}"


class TestRandomClosures(unittest.TestCase):
    CASES = 300

    def test_random_programs_match_reference(self):
        for case in range(self.CASES):
            rng = random.Random(1000 + case)
            src = Gen(rng).program()
            with self.subTest(case=case):
                top = upval.compile_source(src)
                compiled = upval.run_compiled(top)
                reference = upval.run_reference(top)
                self.assertIsInstance(compiled, int)
                self.assertEqual(compiled, reference)


if __name__ == "__main__":
    unittest.main()
