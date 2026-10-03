"""Expression DAG with hash-consing, simplification and symbolic derivatives.

Nodes are immutable and shared: structurally identical expressions are the
same object, so common subexpressions are evaluated once and cancellation
like ``x - x`` folds to the constant zero.
"""

from __future__ import annotations

from fractions import Fraction

OPS = ("const", "var", "add", "sub", "mul", "div", "pow", "neg", "cond")


class Node:
    __slots__ = ("op", "args", "uid")

    def __init__(self, op, args, uid):
        self.op = op
        self.args = args  # tuple of Node / payload
        self.uid = uid

    def __repr__(self):
        if self.op == "const":
            return "const(%s)" % (self.args[0],)
        if self.op == "var":
            return "var(%s)" % (self.args[0],)
        if self.op == "pow":
            return "pow(%r, %d)" % (self.args[0], self.args[1])
        return "%s(%s)" % (self.op, ", ".join(repr(a) for a in self.args))


class DAG:
    """Hash-consing builder.  All nodes of one expression share one DAG."""

    def __init__(self):
        self._cache = {}
        self.nodes = []  # topological order of creation
        self._set = set()

    # -- core -----------------------------------------------------------
    def _mk(self, op, args):
        key = (op, args)
        node = self._cache.get(key)
        if node is None:
            node = Node(op, args, len(self.nodes))
            self._cache[key] = node
            self.nodes.append(node)
            self._set.add(node)
        return node

    def const(self, value):
        if not isinstance(value, Fraction):
            value = Fraction(value)
        return self._mk("const", (value,))

    def var(self, name):
        return self._mk("var", (name,))

    def _coerce(self, x):
        if isinstance(x, Node):
            if x not in self._set:
                raise ValueError("node belongs to a different DAG")
            return x
        return self.const(x)

    # -- arithmetic builders (with simplification) ----------------------
    def add(self, a, b):
        a, b = self._coerce(a), self._coerce(b)
        if a.op == "const" and b.op == "const":
            return self.const(a.args[0] + b.args[0])
        if a.op == "const" and a.args[0] == 0:
            return b
        if b.op == "const" and b.args[0] == 0:
            return a
        return self._mk("add", (a, b))

    def neg(self, a):
        a = self._coerce(a)
        if a.op == "const":
            return self.const(-a.args[0])
        return self._mk("neg", (a,))

    def sub(self, a, b):
        a, b = self._coerce(a), self._coerce(b)
        if a is b:
            return self.const(0)
        if a.op == "const" and b.op == "const":
            return self.const(a.args[0] - b.args[0])
        if b.op == "const" and b.args[0] == 0:
            return a
        return self._mk("sub", (a, b))

    def mul(self, a, b):
        a, b = self._coerce(a), self._coerce(b)
        if a.op == "const" and b.op == "const":
            return self.const(a.args[0] * b.args[0])
        for x, y in ((a, b), (b, a)):
            if x.op == "const":
                if x.args[0] == 0:
                    return self.const(0)
                if x.args[0] == 1:
                    return y
        return self._mk("mul", (a, b))

    def div(self, a, b):
        a, b = self._coerce(a), self._coerce(b)
        if a.op == "const" and a.args[0] == 0:
            return self.const(0)
        if b.op == "const":
            if b.args[0] == 0:
                raise ZeroDivisionError("division by zero constant")
            if a.op == "const":
                return self.const(a.args[0] / b.args[0])
            return self.mul(a, self.const(1 / b.args[0]))
        return self._mk("div", (a, b))

    def pow(self, a, n):
        a = self._coerce(a)
        if not isinstance(n, int):
            raise TypeError("exponent must be an integer")
        if n == 0:
            return self.const(1)
        if n == 1:
            return a
        if a.op == "const":
            v = a.args[0]
            if v == 0 and n < 0:
                raise ZeroDivisionError("0 ** negative")
            return self.const(v ** n)
        return self._mk("pow", (a, n))

    def cond(self, test, then, otherwise):
        """Branch on the sign of ``test``: >= 0 picks ``then``."""
        test, then, otherwise = (
            self._coerce(test),
            self._coerce(then),
            self._coerce(otherwise),
        )
        if test.op == "const":
            return then if test.args[0] >= 0 else otherwise
        if then is otherwise:
            return then
        return self._mk("cond", (test, then, otherwise))

    # -- symbolic differentiation ---------------------------------------
    def diff(self, node, var_name):
        memo = {}

        def d(n):
            if n in memo:
                return memo[n]
            op = n.op
            if op == "const":
                r = self.const(0)
            elif op == "var":
                r = self.const(1 if n.args[0] == var_name else 0)
            elif op == "add":
                r = self.add(d(n.args[0]), d(n.args[1]))
            elif op == "sub":
                r = self.sub(d(n.args[0]), d(n.args[1]))
            elif op == "neg":
                r = self.neg(d(n.args[0]))
            elif op == "mul":
                u, v = n.args
                r = self.add(self.mul(d(u), v), self.mul(u, d(v)))
            elif op == "div":
                u, v = n.args
                r = self.div(
                    self.sub(self.mul(d(u), v), self.mul(u, d(v))),
                    self.pow(v, 2),
                )
            elif op == "pow":
                base, k = n.args
                r = self.mul(
                    self.const(k), self.mul(self.pow(base, k - 1), d(base))
                )
            elif op == "cond":
                t, a, b = n.args
                r = self.cond(t, d(a), d(b))
            else:  # pragma: no cover
                raise ValueError("unknown op " + op)
            memo[n] = r
            return r

        return d(node)

    # -- utilities --------------------------------------------------------
    def variables(self, node):
        out = set()
        seen = set()

        def walk(n):
            if n in seen:
                return
            seen.add(n)
            if n.op == "var":
                out.add(n.args[0])
            for a in n.args:
                if isinstance(a, Node):
                    walk(a)

        walk(node)
        return out

    def denominators(self, node):
        """All subexpressions appearing as a divisor (domain-hole sources)."""
        out = []
        seen = set()

        def walk(n):
            if n in seen:
                return
            seen.add(n)
            if n.op == "div":
                out.append(n.args[1])
            if n.op == "pow" and n.args[1] < 0:
                out.append(n.args[0])
            for a in n.args:
                if isinstance(a, Node):
                    walk(a)

        walk(node)
        return out
