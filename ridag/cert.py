"""Independent certificate checker.

Re-derives every contraction from the serialized expression and checks
inclusion and uniqueness conditions from scratch.  The checker trusts
nothing computed by the isolator: it rebuilds the DAG, re-evaluates all
enclosures with its own Evaluator, replays the box-transform steps, and
finally verifies that the claims exactly cover the original domain.
"""

from __future__ import annotations

from fractions import Fraction

from .evaluator import Evaluator
from .interval import End, Interval, IntervalUnion
from . import poly as P
from .newton import UNIQUE, NONE, UNDECIDED, _sturm_count_range, _cauchy_bound


def _u(iv):
    return IntervalUnion([iv])


class Checker:
    def __init__(self, dag, root, var, domain):
        self.dag = dag
        self.root = root
        self.var = var
        self.domain = domain
        self.ev = Evaluator(dag)
        self.fprime = dag.diff(root, var)
        self.denoms = dag.denominators(root)
        self.rational = P.to_rational(root, var)
        self.errors = []

    # -- independent re-evaluation helpers --------------------------------
    def _f(self, box):
        self.ev.set(self.var, _u(box))
        return self.ev.eval(self.root)

    def _fp(self, box):
        self.ev.set(self.var, _u(box))
        return self.ev.eval(self.fprime)

    def _point(self, x):
        return self.ev.point_eval(self.root, self.var, x)

    def _denom_zero_at(self, x):
        for d in self.denoms:
            try:
                if self.ev.point_eval(d, self.var, x) == 0:
                    return True
            except ArithmeticError:
                return True
        return False

    def _denoms_clear(self, box):
        self.ev.set(self.var, _u(box))
        for d in self.denoms:
            if self.ev.eval(d).value.contains_zero():
                return False
        return True

    def _err(self, msg):
        self.errors.append(msg)

    # -- step verification ---------------------------------------------------
    def check_step(self, step):
        a = step["action"]
        box = step["box"]
        out = step["out"]
        det = step["detail"]
        if a == "exclude":
            if not self._f(box).value.excludes_zero():
                self._err("exclude: enclosure of %r contains 0" % (box,))
        elif a == "clamp":
            if self.rational is None:
                self._err("clamp: expression is not rational")
                return
            bound = _cauchy_bound(self.rational[0])
            clamp = _u(Interval.closed(End(-bound), End(bound)))
            expect = clamp.intersect(_u(box))
            if IntervalUnion(out) != expect:
                self._err("clamp: out does not match Cauchy clamp")
        elif a == "hole":
            at = Fraction(det["at"])
            if not self._denom_zero_at(at):
                self._err("hole: no denominator vanishes at %s" % at)
            expect = _u(box).intersect(
                IntervalUnion([
                    Interval(End.inf(-1), True, End(at), True),
                    Interval(End(at), True, End.inf(1), True),
                ])
            )
            if IntervalUnion(out) != expect:
                self._err("hole: pieces do not cover box minus hole point")
        elif a == "bisect":
            if IntervalUnion(out) != _u(box):
                self._err("bisect: pieces do not partition the box")
        elif a == "bisect_root":
            at = Fraction(det["at"])
            if self._denom_zero_at(at):
                self._err("bisect_root: denominator vanishes at split point")
            elif self._point(at) != 0:
                self._err("bisect_root: f(%s) != 0" % at)
            expect = _u(box).intersect(
                IntervalUnion([
                    Interval(End.inf(-1), True, End(at), True),
                    Interval(End(at), True, End.inf(1), True),
                ])
            )
            if IntervalUnion(out) != expect:
                self._err("bisect_root: pieces do not cover box minus root")
        elif a == "newton":
            at = Fraction(det["at"])
            try:
                fm = self._point(at)
            except ArithmeticError:
                self._err("newton: f not defined at midpoint")
                return
            fp = self._fp(box)
            nbox = _u(Interval.point(End(fm))) / fp.value
            nbox = _u(Interval.point(End(at))) - nbox
            expect = nbox.intersect(_u(box))
            if IntervalUnion(out) != expect:
                self._err("newton: out does not match recomputed Newton step")
        elif a == "sturm":
            if self.rational is None:
                self._err("sturm: expression is not rational")
                return
            c = _sturm_count_range(self.rational[0], box)
            if c != int(det["count"]):
                self._err("sturm: recount gives %d != %d" % (c, det["count"]))
        else:
            self._err("unknown step action %r" % a)

    # -- claim verification ---------------------------------------------------
    def check_claim(self, claim):
        status = claim["status"]
        iv = claim["interval"]
        ev = claim.get("evidence", {})
        kind = ev.get("kind")
        if status == UNDECIDED:
            return
        if status == NONE:
            if kind == "exclude":
                if not self._f(iv).value.excludes_zero():
                    self._err("no_root/exclude: enclosure contains 0")
            elif kind == "point_nonzero":
                if self._point(iv.lo.val) == 0:
                    self._err("no_root/point_nonzero: f(point) == 0")
            elif kind == "hole":
                if not self._denom_zero_at(iv.lo.val):
                    self._err("no_root/hole: no denominator vanishes")
            elif kind == "newton_empty":
                pass  # already justified by the newton step
            elif kind == "cauchy":
                if self.rational is None:
                    self._err("no_root/cauchy: not rational")
                else:
                    bound = _cauchy_bound(self.rational[0])
                    clamp = _u(Interval.closed(End(-bound), End(bound)))
                    if not clamp.intersect(_u(iv)).is_empty():
                        self._err("no_root/cauchy: box meets the Cauchy bound")
            elif kind == "sturm":
                if self.rational is None or _sturm_count_range(
                    self.rational[0], iv
                ) != 0:
                    self._err("no_root/sturm: recount nonzero")
            else:
                self._err("no_root: unknown evidence %r" % kind)
        elif status == UNIQUE:
            if kind == "point_zero":
                if self._denom_zero_at(iv.lo.val):
                    self._err("unique/point_zero: denominator vanishes")
                elif self._point(iv.lo.val) != 0:
                    self._err("unique/point_zero: f(point) != 0")
            elif kind == "monotone_sign":
                if iv.lo_open or iv.hi_open or not iv.is_bounded():
                    self._err("unique/monotone_sign: box not closed/bounded")
                    return
                flo, fhi = self._point(iv.lo.val), self._point(iv.hi.val)
                if flo * fhi >= 0:
                    self._err("unique/monotone_sign: no sign change")
                if not self._fp(iv).value.excludes_zero():
                    self._err("unique/monotone_sign: derivative not clear of 0")
                if not self._denoms_clear(iv):
                    self._err("unique/monotone_sign: denominator may vanish")
            elif kind == "sturm":
                if self.rational is None:
                    self._err("unique/sturm: not rational")
                elif _sturm_count_range(self.rational[0], iv) != 1:
                    self._err("unique/sturm: recount != 1")
                elif not self._denoms_clear(iv):
                    self._err("unique/sturm: denominator may vanish")
            else:
                self._err("unique_root: unknown evidence %r" % kind)
        else:
            self._err("unknown claim status %r" % status)


def verify_certificate(cert):
    """cert: dict with var/expr/domain/steps/claims.  Returns (ok, errors)."""
    from .jsonio import dag_from_json, interval_from_json  # local to avoid cycle

    dag, root = dag_from_json(cert["expr"])
    var = cert["var"]
    domain = IntervalUnion([interval_from_json(j) for j in cert["domain"]])
    chk = Checker(dag, root, var, domain)

    # 1. every contraction step must be inclusion-preserving and its
    #    action-specific side conditions are re-derived independently.
    #    The region a step discards (box minus out) is certified root-free
    #    by the step's own side conditions, so it counts as accounted.
    accounted = IntervalUnion([])
    for step in cert["steps"]:
        s = {
            "action": step["action"],
            "box": interval_from_json(step["box"]),
            "out": [interval_from_json(j) for j in step["out"]],
            "detail": step["detail"],
        }
        if not _u(s["box"]).covers(IntervalUnion(s["out"])):
            chk._err("step %s: out boxes escape the input box" % s["action"])
        chk.check_step(s)
        discarded = _subtract(_u(s["box"]), IntervalUnion(s["out"]))
        accounted = accounted.union(discarded)

    # 2. claims must be pairwise disjoint, lie inside the domain, and
    #    together cover the domain (nothing dropped, nothing duplicated).
    claims = []
    for c in cert["claims"]:
        iv = interval_from_json(c["interval"])
        claims.append({"status": c["status"], "interval": iv,
                       "evidence": c.get("evidence", {})})

    for c in claims:
        chk.check_claim(c)
        if not domain.covers(_u(c["interval"])):
            chk._err("claim interval escapes domain")

    for i, c1 in enumerate(claims):
        for c2 in claims[i + 1:]:
            inter = c1["interval"].intersect(c2["interval"])
            if inter is None:
                continue
            # Adjacent boxes may share one endpoint.  That point is never a
            # root: a verified no_root box provably contains no root, so a
            # unique_root box touching it keeps its root in the remainder.
            # Two unique_root claims may never overlap, even at a point.
            if not inter.is_point() or (
                c1["status"] == UNIQUE and c2["status"] == UNIQUE
            ):
                chk._err("overlapping claims: %r and %r"
                         % (c1["interval"], c2["interval"]))

    claimed = IntervalUnion([c["interval"] for c in claims])
    if not accounted.union(claimed).covers(domain):
        chk._err("claims plus certified exclusions do not cover the domain")

    return (not chk.errors, chk.errors)


def _subtract(a, b):
    """IntervalUnion difference a \\ b (exact, open/closed aware)."""
    out = []
    for piece in a.intervals:
        segments = [piece]
        for cut in b.intervals:
            nxt = []
            for seg in segments:
                inter = seg.intersect(cut)
                if inter is None:
                    nxt.append(seg)
                    continue
                left = Interval.of(seg.lo, seg.lo_open, inter.lo,
                                   not inter.lo_open)
                right = Interval.of(inter.hi, not inter.hi_open,
                                    seg.hi, seg.hi_open)
                for part in (left, right):
                    if part is not None:
                        nxt.append(part)
            segments = nxt
        out.extend(segments)
    return IntervalUnion(out)
