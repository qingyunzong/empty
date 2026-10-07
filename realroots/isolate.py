"""Budget-aware, resumable isolation of real roots in rational intervals.

Conventions
-----------
* A root is either a *point* ``[r, r]`` (r rational, an exact root) or an
  *open interval* ``(lo, hi)`` with rational endpoints that are NOT roots
  and that contains exactly one root.
* After ``finalize`` the isolating intervals are pairwise strictly
  separated: ``prev.hi < next.lo``.
* Budget unit: one charged "operation" is either one initial Sturm root
  count per squarefree factor, or one queue item (a bisection together
  with its Sturm/evaluation work).  When the budget is exhausted the
  engine state (the frontier queue plus finished roots) can be serialized
  and resumed later without repeating or losing any root.
"""

from collections import deque
from fractions import Fraction

from . import poly as P
from .sturm import count_roots_open, sturm_sequence


class Engine:
    """Resumable root-isolation engine over the squarefree factors."""

    def __init__(self, factors, eps=None):
        # factors: [(monic squarefree nonconstant polynomial, multiplicity)]
        self.factors = list(factors)
        self.eps = Fraction(eps) if eps is not None else None
        self.sturms = [sturm_sequence(g) for g, _ in self.factors]
        self.bounds = [P.cauchy_bound(g) for g, _ in self.factors]
        self.done = []          # emitted root records
        self.queue = deque()    # frontier of pending work items
        self.init_upto = 0      # next factor to give an initial count
        self.ops = 0            # charged operations so far
        self.finished = False

    def step(self):
        """Perform one unit of work (one charged operation)."""
        if self.init_upto < len(self.factors):
            i = self.init_upto
            self.init_upto += 1
            self.ops += 1
            g = self.factors[i][0]
            b = self.bounds[i]
            n = count_roots_open(self.sturms[i], g, -b, b)
            if n > 0:
                self._push(i, -b, b, n)
            return
        if not self.queue:
            self.finished = True
            return
        item = self.queue.popleft()
        self.ops += 1
        i = item["factor"]
        g = self.factors[i][0]
        st = self.sturms[i]
        lo, hi = item["lo"], item["hi"]
        if item["type"] == "split":
            n = item["n"]
            mid = (lo + hi) / 2
            at_root = P.evaluate(g, mid) == 0
            nl = count_roots_open(st, g, lo, mid)
            if at_root:
                self._emit_point(i, mid)
            self._push(i, lo, mid, nl)
            self._push(i, mid, hi, n - nl - (1 if at_root else 0))
        else:  # refine: exactly one root in the open interval (lo, hi)
            if self.eps is None or hi - lo <= self.eps:
                self._emit_interval(i, lo, hi)
                return
            mid = (lo + hi) / 2
            if P.evaluate(g, mid) == 0:
                self._emit_point(i, mid)
                return
            nl = count_roots_open(self.sturms[i], g, lo, mid)
            if nl == 1:
                self.queue.append({"type": "refine", "factor": i, "lo": lo, "hi": mid})
            else:
                self.queue.append({"type": "refine", "factor": i, "lo": mid, "hi": hi})

    def _push(self, i, lo, hi, n):
        if n <= 0:
            return
        if n == 1:
            self.queue.append({"type": "refine", "factor": i, "lo": lo, "hi": hi})
        else:
            self.queue.append({"type": "split", "factor": i, "lo": lo, "hi": hi, "n": n})

    def _emit_point(self, i, value):
        self.done.append({"kind": "point", "lo": value, "hi": value,
                          "factor": i, "multiplicity": self.factors[i][1]})

    def _emit_interval(self, i, lo, hi):
        self.done.append({"kind": "interval", "lo": lo, "hi": hi,
                          "factor": i, "multiplicity": self.factors[i][1]})

    def pending(self):
        return len(self.queue) + (len(self.factors) - self.init_upto)


def run(engine, max_ops=None):
    """Run the engine until done or until ``max_ops`` operations are used."""
    start = engine.ops
    while not engine.finished:
        if max_ops is not None and engine.ops - start >= max_ops:
            return "exhausted"
        engine.step()
    return "done"


def refine_root_step(g, sturm_seq, root):
    """One bisection step on an isolating-interval root record."""
    lo, hi = root["lo"], root["hi"]
    mid = (lo + hi) / 2
    if P.evaluate(g, mid) == 0:
        return {"kind": "point", "lo": mid, "hi": mid,
                "factor": root["factor"], "multiplicity": root["multiplicity"]}
    nl = count_roots_open(sturm_seq, g, lo, mid)
    if nl == 1:
        return dict(root, hi=mid)
    return dict(root, lo=mid)


def refine_root(g, root, eps):
    """Refine an isolating interval until its width is at most eps."""
    eps = Fraction(eps)
    st = sturm_sequence(g)
    while root["kind"] == "interval" and root["hi"] - root["lo"] > eps:
        root = refine_root_step(g, st, root)
    return root


def _width(r):
    return r["hi"] - r["lo"]


def finalize(done, factors):
    """Sort roots and refine intervals until pairwise strictly separated.

    The result satisfies ``roots[k].hi < roots[k+1].lo`` (point roots are
    degenerate intervals ``[r, r]``), so isolating intervals never overlap
    and roots exactly at rational points are reported separately.
    """
    roots = [dict(r) for r in done]
    sturms = {i: sturm_sequence(g) for i, (g, _) in enumerate(factors)}
    for _ in range(100000):
        roots.sort(key=lambda r: (r["lo"], r["hi"]))
        conflict = None
        for k in range(len(roots) - 1):
            if roots[k]["hi"] >= roots[k + 1]["lo"]:
                conflict = k
                break
        if conflict is None:
            return roots
        a, b = roots[conflict], roots[conflict + 1]
        if a["kind"] == "interval" and (b["kind"] == "point" or _width(a) >= _width(b)):
            roots[conflict] = refine_root_step(
                factors[a["factor"]][0], sturms[a["factor"]], a)
        elif b["kind"] == "interval":
            roots[conflict + 1] = refine_root_step(
                factors[b["factor"]][0], sturms[b["factor"]], b)
        else:
            raise ValueError("duplicate root across factors (not coprime?)")
    raise RuntimeError("root separation did not converge")


def isolate(coeffs, eps=None, max_ops=None):
    """Isolate all real roots of the polynomial ``coeffs``.

    Returns ``(status, roots, engine)`` where status is ``"ok"`` or
    ``"exhausted"``.  ``roots`` is the finalized, sorted, separated list
    when status is ``"ok"`` and ``None`` otherwise.
    """
    coeffs = P.normalize(coeffs)
    _, facs = P.squarefree_factors(coeffs)
    facs = [(f, m) for f, m in facs if P.degree(f) >= 1]
    eng = Engine(facs, eps)
    status = run(eng, max_ops)
    roots = finalize(eng.done, eng.factors) if status == "done" else None
    return "ok" if status == "done" else status, roots, eng


def isolate_squarefree(g, eps=None):
    """Convenience: fully isolate the roots of one squarefree polynomial."""
    eng = Engine([(P.monic(g), 1)], eps)
    run(eng)
    return finalize(eng.done, eng.factors)
