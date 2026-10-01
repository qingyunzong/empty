import unittest

from scoper import ScopeError, resolve


def use(name, span=None):
    return {"type": "use", "name": name, "span": span}


def assign(name, span=None):
    return {"type": "assign", "name": name, "span": span}


def let(name, span=None):
    return {"type": "let", "name": name, "span": span}


def const(name, span=None):
    return {"type": "const", "name": name, "span": span}


def fn(name, params=None, body=None, span=None):
    return {"type": "fn", "name": name, "params": params or [],
            "body": body or {"type": "block", "stmts": []}, "span": span}


def block(*stmts):
    return {"type": "block", "stmts": list(stmts)}


class TestAcceptance(unittest.TestCase):
    def test_b_inner_use_before_let_is_tdz(self):
        # {let x=1; {use x; let x=2}} -> inner use hits TDZ of inner x
        ast = block(
            let("x", [0, 1]),
            block(use("x", [2, 3]), let("x", [4, 5])),
        )
        with self.assertRaises(ScopeError) as cm:
            resolve(ast)
        err = cm.exception
        self.assertEqual(err.kind, "TDZ")
        self.assertEqual(err.name, "x")
        self.assertEqual(err.use_span, [2, 3])
        self.assertEqual(err.def_span, [4, 5])

    def test_c_mutual_fn_deferred_bodies_and_capture(self):
        # fn f(){use g} fn g(){use f} : both resolvable, each captures
        # the other from the enclosing (global) scope.
        ast = block(
            fn("f", body=block(use("g"))),
            fn("g", body=block(use("f"))),
        )
        out = resolve(ast)
        f_id = out["defs"][0]["id"]
        g_id = out["defs"][1]["id"]
        self.assertEqual(out["defs"][0]["name"], "f")
        self.assertEqual(out["defs"][1]["name"], "g")
        self.assertEqual(out["uses"],
                         [{"name": "g", "span": None, "def_id": g_id},
                          {"name": "f", "span": None, "def_id": f_id}])
        self.assertEqual(out["captures"],
                         {str(f_id): [g_id], str(g_id): [f_id]})

    def test_d_assign_const_fails(self):
        ast = block(const("x", [0, 1]), assign("x", [2, 3]))
        with self.assertRaises(ScopeError) as cm:
            resolve(ast)
        err = cm.exception
        self.assertEqual(err.kind, "AssignConst")
        self.assertEqual(err.name, "x")
        self.assertEqual(err.use_span, [2, 3])
        self.assertEqual(err.def_span, [0, 1])

    def test_d_duplicate_let_same_block_fails(self):
        ast = block(let("x", [0, 1]), let("x", [2, 3]))
        with self.assertRaises(ScopeError) as cm:
            resolve(ast)
        err = cm.exception
        self.assertEqual(err.kind, "Duplicate")
        self.assertEqual(err.name, "x")
        self.assertEqual(err.use_span, [2, 3])
        self.assertEqual(err.def_span, [0, 1])


class TestSemantics(unittest.TestCase):
    def test_undefined(self):
        with self.assertRaises(ScopeError) as cm:
            resolve(block(use("nope", [1, 2])))
        self.assertEqual(cm.exception.kind, "Undefined")
        self.assertIsNone(cm.exception.def_span)

    def test_builtin(self):
        out = resolve(block(use("print")))
        self.assertEqual(out["uses"],
                         [{"name": "print", "span": None, "builtin": True}])

    def test_fn_hoisted_before_its_statement(self):
        out = resolve(block(use("f"), fn("f")))
        self.assertEqual(out["uses"][0]["def_id"], 0)

    def test_fn_body_deferred_let_still_in_tdz(self):
        # fn f(){use x} let x  -> body processed at fn stmt, x in TDZ
        ast = block(fn("f", body=block(use("x"))), let("x"))
        with self.assertRaises(ScopeError) as cm:
            resolve(ast)
        self.assertEqual(cm.exception.kind, "TDZ")

    def test_fn_body_sees_earlier_let(self):
        ast = block(let("x"), fn("f", body=block(use("x"))))
        out = resolve(ast)
        self.assertEqual(out["uses"][0]["def_id"], 0)
        self.assertEqual(out["captures"], {"1": [0]})

    def test_shadowing_uses_nearest_binding(self):
        ast = block(
            let("x"),
            block(let("x"), use("x")),
            use("x"),
        )
        out = resolve(ast)
        self.assertEqual(out["uses"][0]["def_id"], 1)
        self.assertEqual(out["uses"][1]["def_id"], 0)

    def test_shadowing_across_blocks_ok(self):
        out = resolve(block(let("x"), block(let("x"))))
        self.assertEqual(len(out["defs"]), 2)

    def test_params_bound_at_entry_and_shadowable(self):
        ast = fn("f", params=["a", "b"],
                 body=block(use("a"), let("b"), use("b")))
        out = resolve(block(ast))
        kinds = [d["kind"] for d in out["defs"]]
        self.assertEqual(kinds, ["fn", "param", "param", "let"])
        self.assertEqual(out["uses"][0]["def_id"], 1)
        self.assertEqual(out["uses"][1]["def_id"], 3)
        # params and body lets are fn-local: no captures
        self.assertEqual(out["captures"], {"0": []})

    def test_duplicate_param_fails(self):
        with self.assertRaises(ScopeError) as cm:
            resolve(block(fn("f", params=["a", "a"])))
        self.assertEqual(cm.exception.kind, "Duplicate")

    def test_assign_let_ok(self):
        out = resolve(block(let("x"), assign("x")))
        self.assertEqual(out["assigns"],
                         [{"name": "x", "span": None, "def_id": 0}])

    def test_assign_tdz(self):
        with self.assertRaises(ScopeError) as cm:
            resolve(block(assign("x"), let("x")))
        self.assertEqual(cm.exception.kind, "TDZ")

    def test_assign_builtin_is_undefined(self):
        with self.assertRaises(ScopeError) as cm:
            resolve(block(assign("print")))
        self.assertEqual(cm.exception.kind, "Undefined")

    def test_nested_capture_transitive_and_sorted(self):
        # inner fn captures global a and outer fn's local b; capture
        # list sorted by def_id.
        inner = fn("g", body=block(use("b"), use("a")))
        outer = fn("f", body=block(let("b"), inner))
        ast = block(let("a"), outer)
        out = resolve(ast)
        a_id, f_id, b_id, g_id = (d["id"] for d in out["defs"])
        self.assertEqual(out["captures"][str(g_id)], sorted([a_id, b_id]))
        # f transitively captures a (used inside g's body)
        self.assertEqual(out["captures"][str(f_id)], [a_id])

    def test_top_level_list_accepted(self):
        out = resolve([{"type": "let", "name": "x"},
                       {"type": "use", "name": "x"}])
        self.assertEqual(out["uses"][0]["def_id"], 0)


if __name__ == "__main__":
    unittest.main()
