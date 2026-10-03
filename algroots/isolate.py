"""Real-root isolation for rational polynomials.

Representation rules for roots:

* A root that lands exactly on a rational bisection point is represented as
  a ``point`` root with the exact rational value.
* Every other root is represented as an *open* interval ``(a, b)`` with
  rational endpoints; ``f(a) != 0``, ``f(b) != 0`` and the interval
  contains exactly one root of its (square-free) factor.

After isolation completes, all intervals/points are pairwise disjoint and
sorted ascending.  Each root carries the multiplicity of its square-free
factor in the original polynomial.

The isolator is budget-aware: it counts signed Sturm remainders and
bisections.  When the budget is exhausted it stops cleanly, keeps its
frontier, and marks itself ``pending``; the state can be serialized to JSON
and resumed later without duplicating or losing roots.
"""
from __future__ import annotations

from fractions import Fraction

from .budget import Budget, BudgetExhausted
from .poly import Poly, parse_rational
from .sturm import sign_variations


class Root:
    """An isolated real root: exact rational point or open interval."""

    __slots__ = ("kind", "multiplicity", "value", "lower", "upper", "factor")

    def __init__(self, kind, multiplicity, value=None, lower=None, upper=None,
                 factor=None):
        self.kind = kind  # "point" or "interval"
        self.multiplicity = multiplicity
        self.value = value
        self.lower = lower
        self.upper = upper
        self.factor = factor  # index of the square-free factor (internal)

    @property
    def is_point(self):
        return self.kind == "point"

    def width(self):
        if self.is_point:
            return Fraction(0)
        return self.upper - self.lower

    def sort_key(self):
        pos = self.value if self.is_point else self.lower
        # a point equal to an interval's lower bound sorts before it
        return (pos, 0 if self.is_point else 1)

    def contains(self, x):
        x = parse_rational(x)
        if self.is_point:
            return x == self.value
        return self.lower < x < self.upper

    def to_json(self):
        if self.is_point:
            return {"type": "point", "value": str(self.value),
                    "multiplicity": self.multiplicity, "factor": self.factor}
        return {"type": "interval", "interval": "open",
                "lower": str(self.lower), "upper": str(self.upper),
                "multiplicity": self.multiplicity, "factor": self.factor}

    @staticmethod
    def from_json(data):
        if data["type"] == "point":
            return Root("point", data["multiplicity"],
                        value=parse_rational(data["value"]),
                        factor=data.get("factor"))
        return Root("interval", data["multiplicity"],
                    lower=parse_rational(data["lower"]),
                    upper=parse_rational(data["upper"]),
                    factor=data.get("factor"))

    def __repr__(self):
        if self.is_point:
            return "Root(%s, mult=%d)" % (self.value, self.multiplicity)
        return "Root((%s, %s), mult=%d)" % (self.lower, self.upper,
                                            self.multiplicity)


def cauchy_bound(f):
    """Strict rational Cauchy bound: every real root x satisfies |x| < B."""
    m = Fraction(0)
    for c in f.coeffs[:-1]:
        v = abs(c / f.lc)
        if v > m:
            m = v
    return 1 + m


def roots_overlap(r1, r2):
    """True if two root representations (r1 sorted before r2) overlap."""
    if r1.is_point and r2.is_point:
        return r1.value == r2.value
    if r1.is_point:
        return r2.lower < r1.value < r2.upper
    if r2.is_point:
        return r1.lower < r2.value < r1.upper
    return r2.lower < r1.upper


def refine_step(f, root, budget=None):
    """Bisect an interval root once (one ``bisections`` budget unit)."""
    if root.is_point:
        return root
    if budget is not None:
        budget.consume("bisections")
    m = (root.lower + root.upper) / 2
    vm = f.evaluate(m)
    if vm == 0:
        return Root("point", root.multiplicity, value=m, factor=root.factor)
    if (vm > 0) == (f.evaluate(root.lower) > 0):
        return Root("interval", root.multiplicity, lower=m, upper=root.upper,
                    factor=root.factor)
    return Root("interval", root.multiplicity, lower=root.lower, upper=m,
                factor=root.factor)


def refine_to(f, root, epsilon, budget=None):
    """Refine ``root`` until its width is <= ``epsilon``.

    Returns ``(root, done)``; ``done`` is False if the budget ran out first
    (the returned root is the valid frontier, narrower than the input).
    """
    epsilon = parse_rational(epsilon)
    if epsilon <= 0:
        raise ValueError("epsilon must be positive")
    try:
        while not root.is_point and root.width() > epsilon:
            root = refine_step(f, root, budget)
        return root, True
    except BudgetExhausted:
        return root, False


class IsolationSession:
    """Stateful, budget-aware, resumable root isolation."""

    def __init__(self, poly):
        poly = poly if isinstance(poly, Poly) else Poly(poly)
        if poly.is_zero:
            raise ValueError(
                "zero polynomial: every real number is a root; cannot isolate")
        self.poly = poly
        self.content, self.factors = poly.squarefree_factorization()
        self.factor_data = [None] * len(self.factors)
        self.frontier = [{"factor": i, "init": True}
                         for i in range(len(self.factors))]
        self.roots = []
        self.stats = {"remainders": 0, "bisections": 0}
        self.status = "pending"  # "pending" or "done"

    @property
    def done(self):
        return self.status == "done"

    # --------------------------------------------------------------
    def run(self, budget=None):
        """Process the frontier until done or the budget is exhausted."""
        budget = Budget(budget, self.stats)
        try:
            while self.frontier:
                item = self.frontier.pop()
                try:
                    self._process(item, budget)
                except BudgetExhausted:
                    self.frontier.append(item)
                    raise
            self._finalize(budget)
            self.status = "done"
        except BudgetExhausted:
            self.status = "pending"
        return self

    def _process(self, item, budget):
        idx = item["factor"]
        f, mult = self.factors[idx]
        if item.get("init"):
            # Build the Sturm sequence incrementally so that a budget
            # interruption resumes from the partial chain (stored on the
            # frontier item) instead of restarting -- this guarantees
            # progress even when one chain costs more than one budget slice.
            seq = item.get("seq")
            if seq is None:
                seq = [f] if f.is_constant else [f, f.derivative()]
                item["seq"] = seq
            while True:
                budget.consume("remainders")
                r = seq[-2] % seq[-1]
                if r.is_zero:
                    break
                seq.append(-r)
            bound = cauchy_bound(f)
            while f.evaluate(bound) == 0 or f.evaluate(-bound) == 0:
                bound += 1
            self.factor_data[idx] = {"sturm": seq, "bound": bound}
            va = sign_variations(seq, -bound)
            vb = sign_variations(seq, bound)
            count = va - vb
            if count > 0:
                self.frontier.append({"factor": idx, "a": -bound, "b": bound,
                                      "va": va, "vb": vb, "count": count,
                                      "ar": False, "br": False})
            return
        a, b = item["a"], item["b"]
        va, vb, count = item["va"], item["vb"], item["count"]
        ar, br = item["ar"], item["br"]
        if count == 1 and not ar and not br:
            self.roots.append(Root("interval", mult, lower=a, upper=b,
                                   factor=idx))
            return
        budget.consume("bisections")
        seq = self.factor_data[idx]["sturm"]
        m = (a + b) / 2
        vm_val = f.evaluate(m)
        vm = sign_variations(seq, m)
        m_is_root = vm_val == 0
        if vm_val == 0:
            # Midpoint is exactly a root: emit it as a point and continue
            # with the open sub-intervals (a, m) and (m, b).
            self.roots.append(Root("point", mult, value=m, factor=idx))
        # Roots in the open interval (a, m): V(a)-V(m) counts roots in
        # (a, m], so subtract m itself when it is a root.
        left_count = va - vm - (1 if m_is_root else 0)
        # Roots in the open interval (m, b): subtract b when it is a root.
        right_count = vm - vb - (1 if br else 0)
        if left_count > 0:
            self.frontier.append({"factor": idx, "a": a, "b": m,
                                  "va": va, "vb": vm, "count": left_count,
                                  "ar": ar, "br": m_is_root})
        if right_count > 0:
            self.frontier.append({"factor": idx, "a": m, "b": b,
                                  "va": vm, "vb": vb, "count": right_count,
                                  "ar": m_is_root, "br": br})

    def _finalize(self, budget):
        """Sort roots and refine across factors until pairwise disjoint."""
        self.roots.sort(key=lambda r: r.sort_key())
        i = 0
        while i < len(self.roots) - 1:
            r1, r2 = self.roots[i], self.roots[i + 1]
            if not roots_overlap(r1, r2):
                i += 1
                continue
            if r1.is_point:
                self.roots[i + 1] = refine_step(
                    self.factors[r2.factor][0], r2, budget)
            elif r2.is_point:
                self.roots[i] = refine_step(
                    self.factors[r1.factor][0], r1, budget)
            elif r1.width() >= r2.width():
                self.roots[i] = refine_step(
                    self.factors[r1.factor][0], r1, budget)
            else:
                self.roots[i + 1] = refine_step(
                    self.factors[r2.factor][0], r2, budget)
            # Refining can reorder the intervals (the roots themselves stay
            # ordered); re-sort and restart the sweep.
            self.roots.sort(key=lambda r: r.sort_key())
            i = 0

    # --------------------------------------------------------------
    def refine_root(self, index, epsilon, budget=None):
        """Refine the ``index``-th root (sorted order) to width <= epsilon."""
        if not self.done:
            raise ValueError("isolation not complete; cannot refine yet")
        root = self.roots[index]
        f = self.factors[root.factor][0]
        root, ok = refine_to(f, root, epsilon, Budget(budget, self.stats))
        self.roots[index] = root
        return root, ok

    # --------------------------------------------------------------
    def to_state(self):
        factors = []
        for i, (f, m) in enumerate(self.factors):
            data = self.factor_data[i]
            factors.append({
                "factor": f.to_json(),
                "multiplicity": m,
                "sturm": ([s.to_json() for s in data["sturm"]]
                          if data else None),
                "bound": (str(data["bound"]) if data else None),
            })
        frontier = []
        for item in self.frontier:
            if item.get("init"):
                entry = {"factor": item["factor"], "init": True}
                if item.get("seq") is not None:
                    entry["seq"] = [s.to_json() for s in item["seq"]]
                frontier.append(entry)
            else:
                frontier.append({
                    "factor": item["factor"],
                    "a": str(item["a"]), "b": str(item["b"]),
                    "va": item["va"], "vb": item["vb"],
                    "count": item["count"],
                    "ar": item["ar"], "br": item["br"],
                })
        return {
            "poly": self.poly.to_json(),
            "content": str(self.content),
            "factors": factors,
            "frontier": frontier,
            "roots": [r.to_json() for r in self.roots],
            "stats": dict(self.stats),
            "status": self.status,
        }

    @classmethod
    def from_state(cls, state):
        session = cls(Poly.from_json(state["poly"]))
        session.factor_data = []
        for entry in state["factors"]:
            if entry["sturm"] is None:
                session.factor_data.append(None)
            else:
                session.factor_data.append({
                    "sturm": [Poly.from_json(s) for s in entry["sturm"]],
                    "bound": parse_rational(entry["bound"]),
                })
        frontier = []
        for item in state["frontier"]:
            if item.get("init"):
                entry = {"factor": item["factor"], "init": True}
                if item.get("seq") is not None:
                    entry["seq"] = [Poly.from_json(s) for s in item["seq"]]
                frontier.append(entry)
            else:
                frontier.append({
                    "factor": item["factor"],
                    "a": parse_rational(item["a"]),
                    "b": parse_rational(item["b"]),
                    "va": item["va"], "vb": item["vb"],
                    "count": item["count"],
                    "ar": bool(item["ar"]), "br": bool(item["br"]),
                })
        session.frontier = frontier
        session.roots = [Root.from_json(r) for r in state["roots"]]
        session.stats = dict(state["stats"])
        session.status = state["status"]
        return session


def isolate(poly, budget=None):
    """Convenience: fully isolate all real roots of ``poly``."""
    return IsolationSession(poly).run(budget)
