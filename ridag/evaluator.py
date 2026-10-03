"""Interval evaluator over the DAG with dependency-tracked caching.

Every variable assignment carries a version stamp.  Cached results record
the (variable -> version) dependencies they were computed under; a cache
entry is reused only when all its dependency versions still match, so
shrinking or rolling back a variable interval invalidates exactly the
dependents of that variable.

Evaluation returns an ``EvalResult``: the interval-union value plus the
set of denominator node uids whose enclosure contains zero, i.e. the
subexpressions where the current box may hit a domain hole.
"""

from __future__ import annotations

from .dag import Node
from .interval import Interval, IntervalUnion, End


class EvalResult:
    __slots__ = ("value", "open_denoms")

    def __init__(self, value, open_denoms):
        self.value = value                # IntervalUnion
        self.open_denoms = open_denoms    # frozenset of denominator uids containing 0

    def __repr__(self):
        return "EvalResult(%r, holes=%s)" % (self.value, sorted(self.open_denoms))


class Evaluator:
    def __init__(self, dag):
        self.dag = dag
        self.env = {}        # var name -> IntervalUnion
        self._versions = {}  # var name -> int
        self._cache = {}     # node uid -> (EvalResult, deps dict)

    # -- environment management -----------------------------------------
    def set(self, name, interval_union):
        if isinstance(interval_union, Interval):
            interval_union = IntervalUnion([interval_union])
        self.env[name] = interval_union
        self._versions[name] = self._versions.get(name, 0) + 1

    def get(self, name):
        return self.env[name]

    def version(self, name):
        return self._versions.get(name, 0)

    def snapshot(self):
        """Opaque token; ``restore`` rolls env back (rollback invalidates)."""
        return (dict(self.env), dict(self._versions))

    def restore(self, token):
        env, versions = token
        for name in set(self.env) | set(env):
            if self.env.get(name) != env.get(name):
                self._versions[name] = self._versions.get(name, 0) + 1
        self.env = dict(env)

    # -- evaluation -------------------------------------------------------
    def eval(self, node):
        """Evaluate node under the current env; returns EvalResult."""
        cached = self._cache.get(node.uid)
        if cached is not None:
            result, deps = cached
            if all(self._versions.get(v, 0) == ver for v, ver in deps.items()):
                return result
        result, deps = self._compute(node)
        self._cache[node.uid] = (result, deps)
        return result

    def _compute(self, node):
        op = node.op
        if op == "const":
            v = node.args[0]
            return EvalResult(IntervalUnion([Interval.point(End(v))]), frozenset()), {}
        if op == "var":
            name = node.args[0]
            if name not in self.env:
                raise KeyError("unbound variable %r" % name)
            return (
                EvalResult(self.env[name], frozenset()),
                {name: self._versions.get(name, 0)},
            )

        args = [a for a in node.args if isinstance(a, Node)]
        results = [self.eval(a) for a in args]
        deps = {}
        holes = set()
        for r in results:
            holes |= r.open_denoms
        # merge child dependency versions
        for a in args:
            _, a_deps = self._cache[a.uid]
            for k, v in a_deps.items():
                deps[k] = v

        if op == "neg":
            val = -results[0].value
        elif op == "add":
            val = results[0].value + results[1].value
        elif op == "sub":
            val = results[0].value - results[1].value
        elif op == "mul":
            val = results[0].value * results[1].value
        elif op == "div":
            num, den = results
            if den.value.contains_zero():
                holes.add(node.args[1].uid)
            val = num.value / den.value
        elif op == "pow":
            base, k = node.args[0], node.args[1]
            if k < 0 and results[0].value.contains_zero():
                holes.add(base.uid)
            val = results[0].value.pow_int(k)
        elif op == "cond":
            test, then_r, else_r = results
            tv = test.value
            ge_zero = all(
                i.lo.sign() > 0 or (i.lo.is_zero() and not i.lo_open)
                for i in tv.intervals
            )
            lt_zero = all(i.strictly_negative() for i in tv.intervals)
            if ge_zero:
                val = then_r.value
                holes = set(then_r.open_denoms)
            elif lt_zero:
                val = else_r.value
                holes = set(else_r.open_denoms)
            else:
                val = then_r.value.union(else_r.value)
        else:  # pragma: no cover
            raise ValueError("unknown op " + op)
        return EvalResult(val, frozenset(holes)), deps

    def point_eval(self, node, name, x):
        """Exact rational evaluation at a rational point (no caching)."""
        saved = self.env.get(name)
        saved_ver = self._versions.get(name, 0)
        self.set(name, IntervalUnion([Interval.point(End(x))]))
        r = self.eval(node)
        if saved is None:
            del self.env[name]
        else:
            self.env[name] = saved
        # bump again so entries cached under the point env are invalidated
        self._versions[name] = self._versions.get(name, 0) + 1
        v = r.value.as_interval()
        if v is None or not v.is_point():
            raise ArithmeticError("expression not exactly defined at point")
        return v.lo.val
