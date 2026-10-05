"""Expression DAG with hash-consing, symbolic derivatives and an
evaluation environment whose cache is invalidated per dependency."""

from fractions import Fraction

from .intervals import (Interval, mkset, sadd, ssub, smul, sdiv, spow,
                        sunion, all_positive, all_negative)


class Node:
    __slots__ = ("op", "a", "b", "c", "val", "deps")

    def __init__(self, op, a=None, b=None, c=None, val=None,
                 deps=frozenset()):
        self.op = op
        self.a = a
        self.b = b
        self.c = c
        self.val = val
        self.deps = deps

    def __repr__(self):
        if self.op in ("const", "var"):
            return "%s(%r)" % (self.op, self.val)
        if self.op == "pow":
            return "pow(%r, %r)" % (self.a, self.val)
        if self.op == "if":
            return "if(%r, %r, %r)" % (self.a, self.b, self.c)
        return "%s(%r, %r)" % (self.op, self.a, self.b)


class Ctx:
    """Expression context: all nodes are hash-consed so common
    subexpressions are physically shared."""

    def __init__(self):
        self._cons = {}
        self._deriv = {}

    def _mk(self, key, deps, op, a=None, b=None, c=None, val=None):
        n = self._cons.get(key)
        if n is None:
            n = Node(op, a, b, c, val, deps)
            self._cons[key] = n
        return n

    def const(self, v):
        v = Fraction(v)
        return self._mk(("const", v), frozenset(), "const", val=v)

    def var(self, name):
        return self._mk(("var", name), frozenset((name,)), "var", val=name)

    def lift(self, x):
        if isinstance(x, Node):
            return x
        return self.const(x)

    def add(self, a, b):
        a, b = self.lift(a), self.lift(b)
        return self._mk(("add", a, b), a.deps | b.deps, "add", a=a, b=b)

    def sub(self, a, b):
        a, b = self.lift(a), self.lift(b)
        return self._mk(("sub", a, b), a.deps | b.deps, "sub", a=a, b=b)

    def mul(self, a, b):
        a, b = self.lift(a), self.lift(b)
        return self._mk(("mul", a, b), a.deps | b.deps, "mul", a=a, b=b)

    def div(self, a, b):
        a, b = self.lift(a), self.lift(b)
        return self._mk(("div", a, b), a.deps | b.deps, "div", a=a, b=b)

    def powi(self, a, n):
        a = self.lift(a)
        n = int(n)
        return self._mk(("pow", a, n), a.deps, "pow", a=a, val=n)

    def if_(self, cond, then, els):
        cond, then, els = self.lift(cond), self.lift(then), self.lift(els)
        deps = cond.deps | then.deps | els.deps
        return self._mk(("if", cond, then, els), deps, "if",
                        a=cond, b=then, c=els)


def derive(ctx, node, var):
    """Symbolic derivative with respect to variable `var` (shared DAG)."""
    key = (id(node), var)
    r = ctx._deriv.get(key)
    if r is not None:
        return r
    op = node.op
    if op == "const":
        r = ctx.const(0)
    elif op == "var":
        r = ctx.const(1 if node.val == var else 0)
    elif op == "add":
        r = ctx.add(derive(ctx, node.a, var), derive(ctx, node.b, var))
    elif op == "sub":
        r = ctx.sub(derive(ctx, node.a, var), derive(ctx, node.b, var))
    elif op == "mul":
        r = ctx.add(ctx.mul(derive(ctx, node.a, var), node.b),
                    ctx.mul(node.a, derive(ctx, node.b, var)))
    elif op == "div":
        num = ctx.sub(ctx.mul(derive(ctx, node.a, var), node.b),
                      ctx.mul(node.a, derive(ctx, node.b, var)))
        r = ctx.div(num, ctx.powi(node.b, 2))
    elif op == "pow":
        n = node.val
        if n == 0:
            r = ctx.const(0)
        else:
            r = ctx.mul(ctx.const(n),
                        ctx.mul(ctx.powi(node.a, n - 1),
                                derive(ctx, node.a, var)))
    elif op == "if":
        r = ctx.if_(node.a, derive(ctx, node.b, var),
                    derive(ctx, node.c, var))
    else:
        raise ValueError(op)
    ctx._deriv[key] = r
    return r


class Env:
    """Variable intervals plus an evaluation cache.

    Every variable carries a version counter.  A cached entry records the
    versions of the variables its node depends on; shrinking a variable or
    rolling back via save/restore bumps versions, so exactly the entries
    depending on the changed variables are invalidated.
    """

    def __init__(self, ctx):
        self.ctx = ctx
        self.vals = {}
        self.ver = {}
        self._ctr = 0
        self.cache = {}
        self.stats = {"recompute": 0}

    def set_var(self, name, value):
        self.vals[name] = value
        self._ctr += 1
        self.ver[name] = self._ctr

    def get_var(self, name):
        return self.vals[name]

    def save(self):
        return (dict(self.vals), dict(self.ver))

    def restore(self, token):
        vals, _ = token
        self.vals = dict(vals)
        for name in self.vals:
            self._ctr += 1
            self.ver[name] = self._ctr

    def eval(self, node):
        ent = self.cache.get(node)
        if ent is not None:
            vers, res = ent
            if all(self.ver.get(d, 0) == v for d, v in vers.items()):
                return res
        res = self._compute(node)
        self.stats["recompute"] += 1
        self.cache[node] = ({d: self.ver.get(d, 0) for d in node.deps}, res)
        return res

    def eval_at(self, node, var, value):
        token = self.save()
        self.set_var(var, value)
        try:
            return self.eval(node)
        finally:
            self.restore(token)

    def _compute(self, node):
        op = node.op
        if op == "const":
            return (mkset([Interval.point(node.val)]), False)
        if op == "var":
            return (self.vals[node.val], False)
        if op == "add":
            ra = self.eval(node.a)
            rb = self.eval(node.b)
            return (sadd(ra[0], rb[0]), ra[1] or rb[1])
        if op == "sub":
            ra = self.eval(node.a)
            rb = self.eval(node.b)
            return (ssub(ra[0], rb[0]), ra[1] or rb[1])
        if op == "mul":
            ra = self.eval(node.a)
            rb = self.eval(node.b)
            return (smul(ra[0], rb[0]), ra[1] or rb[1])
        if op == "div":
            ra = self.eval(node.a)
            rb = self.eval(node.b)
            v, h = sdiv(ra[0], rb[0])
            return (v, h or ra[1] or rb[1])
        if op == "pow":
            ra = self.eval(node.a)
            v, h = spow(ra[0], node.val)
            return (v, h or ra[1])
        if op == "if":
            rc = self.eval(node.a)
            if not rc[1] and all_positive(rc[0]):
                return self.eval(node.b)
            if not rc[1] and all_negative(rc[0]):
                return self.eval(node.c)
            rt = self.eval(node.b)
            re_ = self.eval(node.c)
            return (sunion(rt[0], re_[0]), rc[1] or rt[1] or re_[1])
        raise ValueError(op)
