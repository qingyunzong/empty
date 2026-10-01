import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scoper import ScopeError, resolve_program
from scoper.errors import (
    KIND_ASSIGN_CONST,
    KIND_DUPLICATE,
    KIND_TDZ,
)
from tests.reference import reference_resolve

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def span(tag):
    return {"line": tag, "col": 0}


def block(*stmts):
    return {"type": "block", "stmts": list(stmts)}


def let(name, init=None, tag=0):
    node = {"type": "let", "name": name, "span": span(tag)}
    if init is not None:
        node["init"] = init
    return node


def const(name, init=None, tag=0):
    node = let(name, init, tag)
    node["type"] = "const"
    return node


def fn(name, params, body, tag=0):
    return {
        "type": "fn",
        "name": name,
        "span": span(tag),
        "params": [{"name": p, "span": span(tag)} for p in params],
        "body": body,
    }


def use(name, tag=0):
    return {"type": "use", "name": name, "span": span(tag)}


def assign(name, value=None, tag=0):
    node = {"type": "assign", "name": name, "span": span(tag)}
    if value is not None:
        node["value"] = value
    return node


def lit(value):
    return {"type": "lit", "value": value}


class AcceptanceTests(unittest.TestCase):
    def test_b_inner_use_before_let_is_tdz(self):
        # {let x=1; {use x; let x=2}} -> inner use x hits the TDZ.
        tree = block(
            let("x", lit(1), tag=1),
            block(
                use("x", tag=2),
                let("x", lit(2), tag=3),
            ),
        )
        with self.assertRaises(ScopeError) as ctx:
            resolve_program(tree)
        err = ctx.exception
        self.assertEqual(err.kind, KIND_TDZ)
        self.assertEqual(err.name, "x")
        self.assertEqual(err.use_span, span(2))
        self.assertEqual(err.def_span, span(3))

    def test_c_mutual_fn_resolution_and_capture(self):
        # fn f(){use g} fn g(){use f}: both resolve; each captures the other.
        tree = block(
            fn("f", [], block(use("g", tag=1)), tag=2),
            fn("g", [], block(use("f", tag=3)), tag=4),
        )
        resolved = resolve_program(tree)
        fns = {f["name"]: f for f in resolved["functions"]}
        f_id = fns["f"]["def_id"]
        g_id = fns["g"]["def_id"]
        self.assertEqual(fns["f"]["captures"], [g_id])
        self.assertEqual(fns["g"]["captures"], [f_id])
        self.assertEqual(resolved["uses"][0]["def_id"], g_id)
        self.assertEqual(resolved["uses"][1]["def_id"], f_id)

    def test_fn_body_delayed_to_definition_point(self):
        # fn f(){use x} let x=1 -> x is still in TDZ at f's definition point.
        tree = block(
            fn("f", [], block(use("x", tag=1)), tag=2),
            let("x", lit(1), tag=3),
        )
        with self.assertRaises(ScopeError) as ctx:
            resolve_program(tree)
        self.assertEqual(ctx.exception.kind, KIND_TDZ)
        self.assertEqual(ctx.exception.name, "x")

    def test_fn_name_usable_before_its_statement(self):
        tree = block(
            use("f", tag=1),
            fn("f", [], block(), tag=2),
        )
        resolved = resolve_program(tree)
        self.assertEqual(resolved["uses"][0]["def_id"],
                         resolved["functions"][0]["def_id"])

    def test_d_assign_to_const_fails(self):
        tree = block(
            const("c", lit(1), tag=1),
            assign("c", lit(2), tag=2),
        )
        with self.assertRaises(ScopeError) as ctx:
            resolve_program(tree)
        err = ctx.exception
        self.assertEqual(err.kind, KIND_ASSIGN_CONST)
        self.assertEqual(err.name, "c")
        self.assertEqual(err.def_span, span(1))

    def test_d_duplicate_let_same_block_fails(self):
        tree = block(
            let("a", lit(1), tag=1),
            let("a", lit(2), tag=2),
        )
        with self.assertRaises(ScopeError) as ctx:
            resolve_program(tree)
        err = ctx.exception
        self.assertEqual(err.kind, KIND_DUPLICATE)
        self.assertEqual(err.name, "a")
        self.assertEqual(err.use_span, span(2))
        self.assertEqual(err.def_span, span(1))

    def test_shadowing_inner_block_ok(self):
        tree = block(
            let("x", lit(1), tag=1),
            block(
                let("x", lit(2), tag=2),
                use("x", tag=3),
            ),
        )
        resolved = resolve_program(tree)
        self.assertEqual(resolved["uses"][0]["def_id"], 1)

    def test_builtin_use(self):
        tree = block(use("print", tag=1))
        resolved = resolve_program(tree)
        self.assertEqual(resolved["uses"],
                         [{"name": "print", "span": span(1),
                           "builtin": True}])

    def test_nested_capture_propagates(self):
        # let x; fn outer(){ fn inner(){ use x } } -> both capture x.
        tree = block(
            let("x", lit(1), tag=1),
            fn("outer", [], block(
                fn("inner", [], block(use("x", tag=2)), tag=3),
            ), tag=4),
        )
        resolved = resolve_program(tree)
        fns = {f["name"]: f for f in resolved["functions"]}
        self.assertEqual(fns["inner"]["captures"], [0])
        self.assertEqual(fns["outer"]["captures"], [0])

    def test_params_bound_on_entry(self):
        tree = block(
            fn("f", ["p"], block(use("p", tag=1)), tag=2),
        )
        resolved = resolve_program(tree)
        param_id = resolved["defs"][1]["def_id"]
        self.assertEqual(resolved["defs"][1]["kind"], "param")
        self.assertEqual(resolved["uses"][0]["def_id"], param_id)
        self.assertEqual(resolved["functions"][0]["captures"], [])

    def test_body_let_shadows_param_after_declaration(self):
        tree = block(
            fn("f", ["p"], block(
                let("p", lit(1), tag=1),
                use("p", tag=2),
            ), tag=3),
        )
        resolved = resolve_program(tree)
        inner_id = resolved["defs"][2]["def_id"]
        self.assertEqual(resolved["uses"][0]["def_id"], inner_id)

    def test_use_before_shadowing_let_in_body_is_tdz(self):
        tree = block(
            fn("f", ["p"], block(
                use("p", tag=1),
                let("p", lit(1), tag=2),
            ), tag=3),
        )
        with self.assertRaises(ScopeError) as ctx:
            resolve_program(tree)
        self.assertEqual(ctx.exception.kind, KIND_TDZ)


class RandomComparisonTests(unittest.TestCase):
    NAMES = ["a", "b", "c", "x", "y"]

    def _gen_expr(self, rng):
        if rng.random() < 0.5:
            return lit(rng.randint(0, 9))
        return use(self._gen_name(rng), tag=rng.randint(0, 999))

    def _gen_name(self, rng):
        roll = rng.random()
        if roll < 0.08:
            return "print"
        if roll < 0.14:
            return "undef_name"
        return rng.choice(self.NAMES)

    def _gen_stmt(self, rng, depth):
        roll = rng.random()
        if depth < 3 and roll < 0.18:
            return self._gen_block(rng, depth + 1)
        if roll < 0.38:
            node = let(self._gen_name(rng), tag=rng.randint(0, 999))
            if rng.random() < 0.5:
                node["init"] = self._gen_expr(rng)
            return node
        if roll < 0.52:
            node = const(self._gen_name(rng), tag=rng.randint(0, 999))
            if rng.random() < 0.5:
                node["init"] = self._gen_expr(rng)
            return node
        if roll < 0.72:
            params = [self._gen_name(rng)
                      for _ in range(rng.randint(0, 2))]
            return fn(self._gen_name(rng), params,
                      self._gen_block(rng, depth + 1),
                      tag=rng.randint(0, 999))
        if roll < 0.88:
            return use(self._gen_name(rng), tag=rng.randint(0, 999))
        node = assign(self._gen_name(rng), tag=rng.randint(0, 999))
        if rng.random() < 0.5:
            node["value"] = self._gen_expr(rng)
        return node

    def _gen_block(self, rng, depth):
        return block(*[self._gen_stmt(rng, depth)
                       for _ in range(rng.randint(1, 5))])

    def test_random_trees_match_reference(self):
        cases = 300
        stats = {"ok": 0, "error": 0}
        for seed in range(cases):
            rng = random.Random(seed)
            tree = self._gen_block(rng, 0)
            try:
                expected = ("ok", reference_resolve(tree))
            except ScopeError as err:
                expected = ("error", err.to_dict())
            try:
                actual = ("ok", resolve_program(tree))
            except ScopeError as err:
                actual = ("error", err.to_dict())
            stats[expected[0]] += 1
            self.assertEqual(
                expected, actual,
                "mismatch on seed %d tree %s" % (seed, json.dumps(tree)))
        self.assertGreater(stats["error"], 0)
        self.assertGreater(stats["ok"], 0)


class CliTests(unittest.TestCase):
    def _run_cli(self, tree, tmpdir):
        src = os.path.join(tmpdir, "src.scp")
        out = os.path.join(tmpdir, "resolved.json")
        with open(src, "w", encoding="utf-8") as handle:
            json.dump(tree, handle)
        proc = subprocess.run(
            [sys.executable, "-m", "scoper", src, "--emit", out],
            cwd=REPO_ROOT, capture_output=True, text=True)
        return proc, out

    def test_cli_success_emits_resolved(self):
        tree = block(
            let("x", lit(1), tag=1),
            use("x", tag=2),
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            proc, out = self._run_cli(tree, tmpdir)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            with open(out, encoding="utf-8") as handle:
                resolved = json.load(handle)
            self.assertEqual(resolved["uses"][0]["def_id"], 0)

    def test_cli_scope_error_exit_5_no_output(self):
        tree = block(use("nope", tag=1))
        with tempfile.TemporaryDirectory() as tmpdir:
            proc, out = self._run_cli(tree, tmpdir)
            self.assertEqual(proc.returncode, 5)
            self.assertFalse(os.path.exists(out))
            payload = json.loads(proc.stderr)
            self.assertEqual(payload["error"]["kind"], "Undefined")
            self.assertEqual(payload["error"]["name"], "nope")

    def test_cli_assign_const_exit_5_no_output(self):
        tree = block(
            const("c", lit(1), tag=1),
            assign("c", lit(2), tag=2),
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            proc, out = self._run_cli(tree, tmpdir)
            self.assertEqual(proc.returncode, 5)
            self.assertFalse(os.path.exists(out))
            payload = json.loads(proc.stderr)
            self.assertEqual(payload["error"]["kind"], "AssignConst")


if __name__ == "__main__":
    unittest.main()
