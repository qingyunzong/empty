"""Differential test: scoper.resolve vs an independent environment-stack
reference implementation on 300 randomly generated scope trees."""

import random
import unittest

from scoper import ScopeError, resolve

# --- Independent reference implementation (environment stack style) ---
# Written separately from scoper.core: defs are plain dicts, scopes are
# an explicit stack of frames, and resolution walks the stack by index.

REF_BUILTINS = frozenset({
    "print", "len", "range", "str", "int", "float", "bool", "list",
    "dict", "set", "tuple", "type", "input", "abs", "min", "max",
    "sum", "enumerate", "zip", "map", "filter", "sorted", "reversed",
})


class RefError(Exception):
    def __init__(self, name, kind, use_span, def_span):
        super().__init__(kind)
        self.info = {"name": name, "kind": kind,
                     "use_span": use_span, "def_span": def_span}


def ref_resolve(ast):
    if isinstance(ast, list):
        ast = {"type": "block", "stmts": ast}
    if not isinstance(ast, dict) or ast.get("type") != "block":
        raise ValueError("top-level AST node must be a block")

    defs = []       # each: dict(id, name, kind, span, init)
    uses = []
    assigns = []
    fn_captures = {}  # fn def id -> set of captured def ids
    env = []        # stack of frames: {"names": {...}, "fn_id": id|None}

    def new_def(frame, name, kind, span, init):
        if name in frame["names"]:
            raise RefError(name, "Duplicate", span,
                           defs[frame["names"][name]]["span"])
        idx = len(defs)
        defs.append({"id": idx, "name": name, "kind": kind,
                     "span": span, "init": init})
        frame["names"][name] = idx
        return idx

    def lookup(name):
        fns_crossed = []
        for i in range(len(env) - 1, -1, -1):
            frame = env[i]
            if name in frame["names"]:
                return frame["names"][name], fns_crossed
            if frame["fn_id"] is not None:
                fns_crossed.append(frame["fn_id"])
        return None, fns_crossed

    def bind(node, sink):
        name = node["name"]
        span = node.get("span")
        idx, fns_crossed = lookup(name)
        if idx is None:
            if name in REF_BUILTINS:
                sink.append({"name": name, "span": span, "builtin": True})
                return None
            raise RefError(name, "Undefined", span, None)
        d = defs[idx]
        if d["kind"] in ("let", "const") and not d["init"]:
            raise RefError(name, "TDZ", span, d["span"])
        for fn_id in fns_crossed:
            fn_captures[fn_id].add(idx)
        return d

    def walk_block(node):
        frame = {"names": {}, "fn_id": None}
        env.append(frame)
        try:
            stmts = node.get("stmts", [])
            for st in stmts:  # hoisting pass
                if st.get("type") in ("let", "const", "fn"):
                    new_def(frame, st["name"], st["type"], st.get("span"),
                            st["type"] == "fn")
            for st in stmts:  # execution pass
                t = st.get("type")
                if t in ("let", "const"):
                    defs[frame["names"][st["name"]]]["init"] = True
                elif t == "fn":
                    walk_fn(st, frame["names"][st["name"]])
                elif t == "use":
                    d = bind(st, uses)
                    if d is not None:
                        uses.append({"name": st["name"],
                                     "span": st.get("span"),
                                     "def_id": d["id"]})
                elif t == "assign":
                    d = bind(st, assigns)
                    if d is None:
                        raise RefError(st["name"], "Undefined",
                                       st.get("span"), None)
                    if d["kind"] == "const":
                        raise RefError(st["name"], "AssignConst",
                                       st.get("span"), d["span"])
                    assigns.append({"name": st["name"],
                                    "span": st.get("span"),
                                    "def_id": d["id"]})
                elif t == "block":
                    walk_block(st)
                else:
                    raise ValueError("unknown node type: %r" % (t,))
        finally:
            env.pop()

    def walk_fn(node, fn_id):
        fn_captures[fn_id] = set()
        frame = {"names": {}, "fn_id": fn_id}
        env.append(frame)
        try:
            for p in node.get("params", []):
                new_def(frame, p, "param", node.get("span"), True)
            body = node.get("body") or {"type": "block", "stmts": []}
            walk_block(body)
        finally:
            env.pop()

    walk_block(ast)
    return {
        "defs": [{"id": d["id"], "name": d["name"], "kind": d["kind"],
                  "span": d["span"]} for d in defs],
        "uses": uses,
        "assigns": assigns,
        "captures": {str(fid): sorted(ids)
                     for fid, ids in fn_captures.items()},
    }


# --- Random scope-tree generator ---

NAMES = ["a", "b", "c", "d", "print", "len", "zz"]


def gen_span(rng):
    if rng.random() < 0.3:
        return None
    start = rng.randint(0, 100)
    return [start, start + rng.randint(0, 3)]


def gen_stmt(rng, depth):
    r = rng.random()
    if depth < 3 and r < 0.18:
        return {"type": "block", "stmts": gen_stmts(rng, depth + 1)}
    if r < 0.42:
        return {"type": rng.choice(["let", "let", "const"]),
                "name": rng.choice(NAMES[:4]), "span": gen_span(rng)}
    if depth < 3 and r < 0.58:
        params = [rng.choice(NAMES[:4])
                  for _ in range(rng.randint(0, 2))]
        return {"type": "fn", "name": rng.choice(NAMES[:4]),
                "params": params,
                "body": {"type": "block", "stmts": gen_stmts(rng, depth + 1)},
                "span": gen_span(rng)}
    if r < 0.82:
        return {"type": "use", "name": rng.choice(NAMES),
                "span": gen_span(rng)}
    return {"type": "assign", "name": rng.choice(NAMES[:6]),
            "span": gen_span(rng)}


def gen_stmts(rng, depth):
    return [gen_stmt(rng, depth) for _ in range(rng.randint(1, 6))]


def gen_tree(rng):
    return {"type": "block", "stmts": gen_stmts(rng, 0)}


class TestDifferential(unittest.TestCase):
    def test_300_random_trees_match_reference(self):
        for seed in range(300):
            rng = random.Random(seed)
            tree = gen_tree(rng)
            with self.subTest(seed=seed):
                main_err = ref_err = None
                main_out = ref_out = None
                try:
                    main_out = resolve(tree)
                except ScopeError as e:
                    main_err = e.to_dict()
                try:
                    ref_out = ref_resolve(tree)
                except RefError as e:
                    ref_err = e.info
                self.assertEqual(main_err, ref_err,
                                 "error mismatch on seed %d" % seed)
                if main_err is None:
                    self.assertEqual(main_out, ref_out,
                                     "output mismatch on seed %d" % seed)


if __name__ == "__main__":
    unittest.main()
