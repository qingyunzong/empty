"""Acceptance A: for 300 randomly generated closed terms of depth <= 4,
the Hindley-Milner inference result must agree with an independent
oracle that enumerates ground-type assignments for lambda-bound
variables and runs a structural (unification-free) check.

For each generated term (well-typed by construction at a known ground
type T) we assert:
  1. hmtype inference succeeds and yields principal type P;
  2. T is an instance of P;
  3. every ground type found by the independent enumeration oracle is
     an instance of P (P is at least as general as anything the oracle
     accepts);
  4. the oracle itself finds T (sanity check of generator + oracle).
"""

import itertools
import random
import unittest

from hmtype import infer_expr, parse_expr
from hmtype import syntax as ast
from hmtype.types import TBool, TFun, TInt, TTuple, TVar, prune

# ------------------------------------------------------- ground type tuples
INT_T = ("int",)
BOOL_T = ("bool",)
BASE_TYPES = [INT_T, BOOL_T]
# Universe for the oracle: base types, arrows of base types, pairs of base.
UNIVERSE = (
    BASE_TYPES
    + [("fun", a, b) for a in BASE_TYPES for b in BASE_TYPES]
    + [("tuple", (a, b)) for a in BASE_TYPES for b in BASE_TYPES]
)

MAX_DEPTH = 4       # bound on AST height of generated terms
MAX_LAMBDAS = 4     # keeps oracle enumeration (|UNIVERSE| ** n) tractable


def gen_type(rng, depth):
    if depth <= 0 or rng.random() < 0.5:
        return rng.choice(BASE_TYPES)
    if rng.random() < 0.25:
        return ("tuple", (gen_type(rng, 0), gen_type(rng, 0)))
    return ("fun", gen_type(rng, depth - 1), gen_type(rng, depth - 1))


def min_depth(ty):
    """Minimum AST height of any closed term of this type."""
    if ty[0] in ("int", "bool"):
        return 0
    if ty[0] == "fun":
        return 1 + min_depth(ty[2])
    return 1 + max((min_depth(e) for e in ty[1]), default=0)


def needed_lambdas(ty):
    """Lambdas forced in any closed term of this type."""
    if ty[0] in ("int", "bool"):
        return 0
    if ty[0] == "fun":
        return 1 + needed_lambdas(ty[2])
    return sum(needed_lambdas(e) for e in ty[1])


class Stuck(Exception):
    """Raised when generation cannot proceed; the caller retries."""


class Generator:
    """Generation of well-typed closed terms by target type."""

    def __init__(self, rng):
        self.rng = rng
        self.counter = 0

    def fresh_name(self):
        self.counter += 1
        return f"v{self.counter}"

    def gen(self, ty, env, depth, budget):
        """Invariant: depth >= min_depth(ty). `budget` is a one-element
        list holding the remaining lambda allowance."""
        rng = self.rng
        span = (0, 0, 0, 0)
        options = []
        if ty == INT_T:
            options.append((3, lambda: ast.IntLit(span, rng.randint(0, 9))))
        if ty == BOOL_T:
            options.append((2, lambda: ast.BoolLit(span, rng.random() < 0.5)))
        matching = [n for n, t in env if t == ty]
        if matching:
            options.append((4, lambda: ast.Var(span, rng.choice(matching))))
        if isinstance(ty, tuple) and ty[0] == "tuple":
            # Tuple construction never needs lambdas for our type shapes.
            if depth >= 1 + max(min_depth(e) for e in ty[1]):
                def make_tuple():
                    return ast.Tuple(span, [self.gen(t, env, depth - 1, budget)
                                            for t in ty[1]])
                options.append((3, make_tuple))
        if (isinstance(ty, tuple) and ty[0] == "fun"
                and depth >= 1 and budget[0] >= 1 + needed_lambdas(ty[2])):
            def make_lam():
                budget[0] -= 1
                x = self.fresh_name()
                body = self.gen(ty[2], env + [(x, ty[1])], depth - 1, budget)
                return ast.Lam(span, x, body)
            options.append((4, make_lam))
        if depth > 0:
            if depth >= 1 + min_depth(ty):
                def make_if():
                    c = self.gen(BOOL_T, env, depth - 1, budget)
                    t = self.gen(ty, env, depth - 1, budget)
                    e = self.gen(ty, env, depth - 1, budget)
                    return ast.If(span, c, t, e)
                options.append((2, make_if))

                s_let = gen_type(rng, 1)
                if depth >= 1 + max(min_depth(s_let), min_depth(ty)):
                    def make_let():
                        rhs = self.gen(s_let, env, depth - 1, budget)
                        x = self.fresh_name()
                        body = self.gen(ty, env + [(x, s_let)], depth - 1,
                                        budget)
                        return ast.Let(span, x, rhs, body)
                    options.append((2, make_let))

                s_app = gen_type(rng, 1)
                if depth >= max(2 + min_depth(ty), 1 + min_depth(s_app)):
                    def make_app():
                        f = self.gen(("fun", s_app, ty), env, depth - 1,
                                     budget)
                        a = self.gen(s_app, env, depth - 1, budget)
                        return ast.App(span, f, a)
                    options.append((2, make_app))

                if depth >= 2 + min_depth(ty) \
                        and budget[0] >= 1 + needed_lambdas(ty):
                    def make_fix():
                        budget[0] -= 1
                        x = self.fresh_name()
                        body = self.gen(ty, env + [(x, ty)], depth - 2,
                                        budget)
                        return ast.Fix(span, ast.Lam(span, x, body))
                    options.append((1, make_fix))
            if ty == INT_T:
                def make_arith():
                    op = rng.choice(["+", "-", "*", "/"])
                    l = self.gen(INT_T, env, depth - 1, budget)
                    r = self.gen(INT_T, env, depth - 1, budget)
                    return ast.BinOp(span, op, l, r)
                options.append((2, make_arith))
            if ty == BOOL_T:
                def make_cmp():
                    op = rng.choice(["<", "<=", ">", ">="])
                    l = self.gen(INT_T, env, depth - 1, budget)
                    r = self.gen(INT_T, env, depth - 1, budget)
                    return ast.BinOp(span, op, l, r)
                options.append((2, make_cmp))

                def make_eq():
                    s = gen_type(rng, 0)
                    op = rng.choice(["==", "!="])
                    l = self.gen(s, env, depth - 1, budget)
                    r = self.gen(s, env, depth - 1, budget)
                    return ast.BinOp(span, op, l, r)
                options.append((1, make_eq))
        if not options:
            raise Stuck(f"no options for {ty} at depth {depth}")
        total = sum(w for w, _ in options)
        pick = rng.uniform(0, total)
        acc = 0.0
        for w, thunk in options:
            acc += w
            if pick <= acc:
                return thunk()
        raise AssertionError("unreachable")


def ast_depth(node):
    if isinstance(node, (ast.IntLit, ast.BoolLit, ast.Var)):
        return 1
    if isinstance(node, ast.Lam):
        return 1 + ast_depth(node.body)
    if isinstance(node, ast.App):
        return 1 + max(ast_depth(node.fn), ast_depth(node.arg))
    if isinstance(node, ast.Let):
        return 1 + max(ast_depth(node.rhs), ast_depth(node.body))
    if isinstance(node, ast.If):
        return 1 + max(ast_depth(node.cond), ast_depth(node.then),
                       ast_depth(node.els))
    if isinstance(node, ast.Fix):
        return 1 + ast_depth(node.expr)
    if isinstance(node, ast.BinOp):
        return 1 + max(ast_depth(node.left), ast_depth(node.right))
    if isinstance(node, ast.Tuple):
        return 1 + max(ast_depth(e) for e in node.elems)
    raise AssertionError(node)


# ------------------------------------------------------- source rendering

def to_src(node):
    if isinstance(node, ast.IntLit):
        return str(node.value)
    if isinstance(node, ast.BoolLit):
        return "true" if node.value else "false"
    if isinstance(node, ast.Var):
        return node.name
    if isinstance(node, ast.Lam):
        return f"(fun {node.param} -> {to_src(node.body)})"
    if isinstance(node, ast.App):
        return f"({to_src(node.fn)} {to_src(node.arg)})"
    if isinstance(node, ast.Let):
        return f"(let {node.name} = {to_src(node.rhs)} in {to_src(node.body)})"
    if isinstance(node, ast.If):
        return (f"(if {to_src(node.cond)} then {to_src(node.then)} "
                f"else {to_src(node.els)})")
    if isinstance(node, ast.Fix):
        return f"(fix {to_src(node.expr)})"
    if isinstance(node, ast.BinOp):
        return f"({to_src(node.left)} {node.op} {to_src(node.right)})"
    if isinstance(node, ast.Tuple):
        return "(" + ", ".join(to_src(e) for e in node.elems) + ")"
    raise AssertionError(f"unknown node {node!r}")


# ------------------------------------------- independent enumeration oracle

def collect_params(node, params):
    if isinstance(node, ast.Lam):
        params.append(node.param)
        collect_params(node.body, params)
    elif isinstance(node, ast.App):
        collect_params(node.fn, params)
        collect_params(node.arg, params)
    elif isinstance(node, ast.Let):
        collect_params(node.rhs, params)
        collect_params(node.body, params)
    elif isinstance(node, ast.If):
        collect_params(node.cond, params)
        collect_params(node.then, params)
        collect_params(node.els, params)
    elif isinstance(node, ast.Fix):
        collect_params(node.expr, params)
    elif isinstance(node, ast.BinOp):
        collect_params(node.left, params)
        collect_params(node.right, params)
    elif isinstance(node, ast.Tuple):
        for e in node.elems:
            collect_params(e, params)


def mono_check(node, env, assign):
    """Structural type check with lambda param types taken from `assign`.
    Returns the ground type tuple or None. No unification involved."""
    if isinstance(node, ast.IntLit):
        return INT_T
    if isinstance(node, ast.BoolLit):
        return BOOL_T
    if isinstance(node, ast.Var):
        return env.get(node.name)
    if isinstance(node, ast.Lam):
        param_ty = assign[node.param]
        env2 = dict(env)
        env2[node.param] = param_ty
        body_ty = mono_check(node.body, env2, assign)
        if body_ty is None:
            return None
        return ("fun", param_ty, body_ty)
    if isinstance(node, ast.App):
        fn_ty = mono_check(node.fn, env, assign)
        arg_ty = mono_check(node.arg, env, assign)
        if fn_ty is None or arg_ty is None:
            return None
        if fn_ty[0] == "fun" and fn_ty[1] == arg_ty:
            return fn_ty[2]
        return None
    if isinstance(node, ast.Let):
        rhs_ty = mono_check(node.rhs, env, assign)
        if rhs_ty is None:
            return None
        env2 = dict(env)
        env2[node.name] = rhs_ty
        return mono_check(node.body, env2, assign)
    if isinstance(node, ast.If):
        if mono_check(node.cond, env, assign) != BOOL_T:
            return None
        then_ty = mono_check(node.then, env, assign)
        els_ty = mono_check(node.els, env, assign)
        if then_ty is not None and then_ty == els_ty:
            return then_ty
        return None
    if isinstance(node, ast.Fix):
        ty = mono_check(node.expr, env, assign)
        if ty is not None and ty[0] == "fun" and ty[1] == ty[2]:
            return ty[1]
        return None
    if isinstance(node, ast.BinOp):
        left = mono_check(node.left, env, assign)
        right = mono_check(node.right, env, assign)
        if node.op in ("+", "-", "*", "/"):
            return INT_T if left == INT_T and right == INT_T else None
        if node.op in ("<", "<=", ">", ">="):
            return BOOL_T if left == INT_T and right == INT_T else None
        if node.op in ("==", "!="):
            return BOOL_T if left is not None and left == right else None
        raise AssertionError(node.op)
    if isinstance(node, ast.Tuple):
        elems = [mono_check(e, env, assign) for e in node.elems]
        if any(e is None for e in elems):
            return None
        return ("tuple", tuple(elems))
    raise AssertionError(f"unknown node {node!r}")


def oracle_types(node):
    """All ground types (over UNIVERSE) the term admits, found by
    exhaustively enumerating lambda-parameter type assignments."""
    params = []
    collect_params(node, params)
    results = set()
    for combo in itertools.product(UNIVERSE, repeat=len(params)):
        assign = dict(zip(params, combo))
        ty = mono_check(node, {}, assign)
        if ty is not None:
            results.add(ty)
    return results


# ------------------------------------------------------- instance checking

def to_pattern(ty):
    ty = prune(ty)
    if isinstance(ty, TInt):
        return INT_T
    if isinstance(ty, TBool):
        return BOOL_T
    if isinstance(ty, TVar):
        return ("var", ty.vid)
    if isinstance(ty, TFun):
        return ("fun", to_pattern(ty.arg), to_pattern(ty.ret))
    if isinstance(ty, TTuple):
        return ("tuple", tuple(to_pattern(e) for e in ty.elems))
    raise AssertionError(ty)


def is_instance(ground, pattern, subst=None):
    """True iff the ground type tuple is an instance of the pattern
    (a type tuple possibly containing ("var", n) leaves)."""
    if subst is None:
        subst = {}
    if pattern[0] == "var":
        if pattern in subst:
            return subst[pattern] == ground
        subst[pattern] = ground
        return True
    if pattern[0] != ground[0]:
        return False
    if pattern[0] in ("int", "bool"):
        return True
    if pattern[0] == "fun":
        return (is_instance(ground[1], pattern[1], subst)
                and is_instance(ground[2], pattern[2], subst))
    if pattern[0] == "tuple":
        return (len(ground[1]) == len(pattern[1])
                and all(is_instance(g, p, subst)
                        for g, p in zip(ground[1], pattern[1])))
    raise AssertionError(pattern)


class TestRandomTerms(unittest.TestCase):
    def test_300_random_closed_terms_depth_le_4(self):
        rng = random.Random(20261001)
        for i in range(300):
            while True:
                gen = Generator(rng)
                expected = gen_type(rng, 1)
                try:
                    node = gen.gen(expected, [], MAX_DEPTH - 1,
                                   [MAX_LAMBDAS])
                    break
                except Stuck:
                    continue
            self.assertLessEqual(ast_depth(node), MAX_DEPTH)
            src = to_src(node)
            with self.subTest(case=i, src=src):
                # Round-trip through the parser.
                parsed = parse_expr(src)
                # 1. hmtype inference succeeds.
                principal = to_pattern(infer_expr(parsed))
                # 2. The generated type is an instance of the principal type.
                self.assertTrue(
                    is_instance(expected, principal),
                    f"expected {expected} not an instance of {principal}")
                # 3./4. Independent enumeration oracle agrees.
                oracle = oracle_types(parsed)
                self.assertIn(expected, oracle)
                for ground in oracle:
                    self.assertTrue(
                        is_instance(ground, principal),
                        f"oracle type {ground} not an instance of {principal}")


if __name__ == "__main__":
    unittest.main()
