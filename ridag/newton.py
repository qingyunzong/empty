"""Interval-Newton / monotone-contraction root isolation over the DAG.

Produces claims tagged ``unique_root`` / ``no_root`` / ``undecided`` and a
machine-checkable certificate.  Every step only shrinks or splits boxes;
when the budget runs out the remaining boxes are emitted as ``undecided``
claims, never silently dropped.  Zeros of denominators are treated as
domain holes: the hole point is removed from the search space and justified
in the certificate.
"""

from __future__ import annotations

from fractions import Fraction

from .evaluator import Evaluator
from .interval import End, Interval, IntervalUnion
from . import poly as P

UNIQUE = "unique_root"
NONE = "no_root"
UNDECIDED = "undecided"


class Claim:
    def __init__(self, status, interval, evidence=None):
        self.status = status
        self.interval = interval
        self.evidence = evidence or {}

    def __repr__(self):
        return "Claim(%s, %r)" % (self.status, self.interval)


class Certificate:
    def __init__(self, dag, root, var, domain):
        self.dag = dag
        self.root = root
        self.var = var
        self.domain = domain          # IntervalUnion
        self.steps = []
        self.claims = []

    def step(self, action, box, out=(), **detail):
        self.steps.append(
            {"action": action, "box": box, "out": list(out), "detail": detail}
        )

    def claim(self, status, interval, **evidence):
        self.claims.append(Claim(status, interval, evidence))


def _sturm_count_range(p, iv):
    """Distinct roots of p in the (possibly open) interval iv."""
    lo = None if iv.lo.is_inf else iv.lo.val
    hi = None if iv.hi.is_inf else iv.hi.val
    c = P.sturm_count(p, lo, hi)  # counts (lo, hi]
    if lo is not None and not iv.lo_open and P.peval(p, lo) == 0:
        c += 1
    if hi is not None and iv.hi_open and P.peval(p, hi) == 0:
        c -= 1
    return c


def _cauchy_bound(p):
    p = P.trim(list(p))
    if len(p) <= 1:
        return Fraction(0)
    an = abs(p[-1])
    return 1 + max(abs(c) / an for c in p[:-1])


def _too_big(v, bits=4096):
    """Guard against runaway exact-rational growth in Newton iterates."""
    if isinstance(v, End):
        if v.is_inf:
            return False
        v = v.val
    return (v.numerator.bit_length() > bits
            or v.denominator.bit_length() > bits)


class Isolator:
    def __init__(self, dag, node, var, domain, budget=10000,
                 eps=Fraction(1, 10 ** 24)):
        self.dag = dag
        self.node = node
        self.var = var
        self.budget = budget
        self.eps = eps
        self.ev = Evaluator(dag)
        self.fprime = dag.diff(node, var)
        self.cert = Certificate(dag, node, var, domain)
        self.rational = P.to_rational(node, var)
        self.denoms = dag.denominators(node)
        if isinstance(domain, Interval):
            domain = IntervalUnion([domain])
        self.domain = domain

    # -- helpers ----------------------------------------------------------
    def _set_box(self, box):
        self.ev.set(self.var, IntervalUnion([box]))

    def _f(self, box):
        self._set_box(box)
        return self.ev.eval(self.node)

    def _fp(self, box):
        self._set_box(box)
        return self.ev.eval(self.fprime)

    def _point(self, x):
        return self.ev.point_eval(self.node, self.var, x)

    def _denom_zero_at(self, x):
        for d in self.denoms:
            try:
                if self.ev.point_eval(d, self.var, x) == 0:
                    return True
            except ArithmeticError:
                return True
        return False

    def _denoms_clear(self, box):
        self._set_box(box)
        for d in self.denoms:
            r = self.ev.eval(d)
            if r.value.contains_zero():
                return False
        return True

    # -- main loop --------------------------------------------------------
    def isolate(self):
        work = list(self.domain.intervals)
        # identically-zero rational expression: every defined point is a
        # root, so no isolation is possible -- report honestly.
        if self.rational is not None:
            num = self.rational[0]
            if len(num) == 1 and num[0] == 0:
                for i in work:
                    self.cert.claim(UNDECIDED, i, reason="identically zero")
                return self.cert
        # Clamp unbounded domains with the Cauchy bound when possible.
        if any(not i.is_bounded() for i in work):
            if self.rational is not None:
                bound = _cauchy_bound(self.rational[0])
                clamp = IntervalUnion([Interval.closed(End(-bound), End(bound))])
                new_work = []
                for i in work:
                    inter = clamp.intersect(IntervalUnion([i]))
                    if inter.is_empty():
                        self.cert.step("clamp", i, [], bound=str(bound))
                        self.cert.claim(NONE, i, kind="cauchy",
                                        bound=str(bound))
                        continue
                    for j in inter.intervals:
                        new_work.append(j)
                        self.cert.step("clamp", i, [j], bound=str(bound))
                work = new_work
            else:
                rest = []
                for i in work:
                    if i.is_bounded():
                        rest.append(i)
                    else:
                        self.cert.claim(UNDECIDED, i, reason="unbounded domain")
                work = rest

        while work:
            box = work.pop()
            if self.budget <= 0:
                self.cert.claim(UNDECIDED, box, reason="budget exhausted")
                continue
            self.budget -= 1
            self._process(box, work)
        return self.cert

    # -- per-box processing -------------------------------------------------
    def _process(self, box, work):
        cert = self.cert

        # 1. exact point box
        if box.is_point():
            x = box.lo.val
            if self._denom_zero_at(x):
                cert.claim(NONE, box, kind="hole",
                           reason="denominator vanishes at point")
                return
            if self._point(x) == 0:
                cert.claim(UNIQUE, box, kind="point_zero")
            else:
                cert.claim(NONE, box, kind="point_nonzero")
            return

        # 2. denominator holes: bisect toward the hole if enclosure hits 0
        r = self._f(box)
        if r.open_denoms:
            if self._handle_holes(box, work):
                return
            # no actual denominator zero inside: the union-valued enclosure
            # is still sound, so fall through and keep working on this box.

        # 3. range exclusion
        if r.value.excludes_zero():
            cert.step("exclude", box, [])
            cert.claim(NONE, box, kind="exclude")
            return

        # 4. monotone Newton contraction
        fp = self._fp(box)
        if fp.value.excludes_zero() and not fp.open_denoms:
            if self._newton(box, work):
                return

        # 5. small box: decide exactly via Sturm when possible
        if box.width() is not None and box.width() <= self.eps:
            if self._decide_small(box):
                return
            cert.claim(UNDECIDED, box, reason="width below eps")
            return

        # 6. bisect
        self._bisect(box, work)

    def _bisect(self, box, work):
        m = box.midpoint()
        if not self._denom_zero_at(m):
            try:
                fm = self._point(m)
            except ArithmeticError:
                fm = None
            if fm == 0:
                pt = Interval.point(End(m))
                left = Interval.of(box.lo, box.lo_open, End(m), True)
                right = Interval.of(End(m), True, box.hi, box.hi_open)
                out = [i for i in (left, right) if i is not None]
                self.cert.step("bisect_root", box, out, at=str(m))
                self.cert.claim(UNIQUE, pt, kind="point_zero")
                work.extend(out)
                return
        left = Interval.of(box.lo, box.lo_open, End(m), False)
        right = Interval.of(End(m), False, box.hi, box.hi_open)
        out = [i for i in (left, right) if i is not None]
        self.cert.step("bisect", box, out, at=str(m))
        work.extend(out)

    def _handle_holes(self, box, work):
        """Resolve denominator zeros inside ``box``.

        Returns True when the box was consumed (split around holes, claimed,
        or deferred).  Returns False when no denominator actually vanishes
        inside the box, so normal processing may continue with the sound
        union-valued enclosure.
        """
        if self.rational is not None:
            den = self.rational[1]
            cnt = _sturm_count_range(den, box)
            if cnt == 0:
                return False
            rats = [r for r in P.rational_roots(den)
                    if box.contains_end(End(r))]
            if rats:
                self._split_at_holes(box, rats, work)
                return True
            # irrational pole(s) inside: confine them below eps
            if box.width() is not None and box.width() <= self.eps:
                self.cert.claim(UNDECIDED, box, reason="domain hole")
                return True
            self._bisect(box, work)
            return True
        # generic (non-rational) fallback: bisect toward the hole
        m = box.midpoint()
        if self._denom_zero_at(m):
            left = Interval.of(box.lo, box.lo_open, End(m), True)
            right = Interval.of(End(m), True, box.hi, box.hi_open)
            out = [i for i in (left, right) if i is not None]
            self.cert.step("hole", box, out, at=str(m))
            self.cert.claim(NONE, Interval.point(End(m)), kind="hole",
                            reason="denominator vanishes at split point")
            work.extend(out)
        else:
            if box.width() is not None and box.width() <= self.eps:
                self.cert.claim(UNDECIDED, box, reason="unresolved denominator")
            else:
                self._bisect(box, work)
        return True

    def _split_at_holes(self, box, rats, work):
        """Split ``box`` around exact rational poles listed in ``rats``."""
        pieces = [box]
        for r in sorted(rats):
            nxt = []
            for piece in pieces:
                if not piece.contains_end(End(r)):
                    nxt.append(piece)
                    continue
                left = Interval.of(piece.lo, piece.lo_open, End(r), True)
                right = Interval.of(End(r), True, piece.hi, piece.hi_open)
                out = [i for i in (left, right) if i is not None]
                self.cert.step("hole", piece, out, at=str(r))
                self.cert.claim(NONE, Interval.point(End(r)), kind="hole",
                                reason="denominator vanishes at split point")
                nxt.extend(out)
            pieces = nxt
        work.extend(pieces)

    def _newton(self, box, work):
        """One monotone Newton contraction.  Returns True if box resolved."""
        m = box.midpoint()
        if _too_big(m):
            return False
        try:
            fm = self._point(m)
        except ArithmeticError:
            return False
        if _too_big(fm):
            return False
        if fm == 0:
            # exact root at midpoint; monotone => unique in box
            self.cert.claim(UNIQUE, Interval.point(End(m)),
                            kind="point_zero")
            left = Interval.of(box.lo, box.lo_open, End(m), True)
            right = Interval.of(End(m), True, box.hi, box.hi_open)
            out = [i for i in (left, right) if i is not None]
            self.cert.step("bisect_root", box, out, at=str(m))
            work.extend(out)
            return True
        fp = self._fp(box)
        fm_u = IntervalUnion([Interval.point(End(fm))])
        n = fm_u / fp.value
        nbox = IntervalUnion([Interval.point(End(m))]) - n
        new = nbox.intersect(IntervalUnion([box]))
        if any(_too_big(i.lo) or _too_big(i.hi) for i in new.intervals
               if i.is_bounded()):
            return False
        self.cert.step("newton", box, list(new.intervals), at=str(m))
        if new.is_empty():
            self.cert.claim(NONE, box, kind="newton_empty")
            return True
        if new.covers(IntervalUnion([box])):
            # no contraction achieved; let the caller bisect instead
            return False
        # sign-change existence test on the contracted box
        for j in new.intervals:
            if self._try_finish_monotone(j):
                continue
            work.append(j)
        return True

    def _try_finish_monotone(self, box):
        """If f changes sign across a small monotone box, claim unique root."""
        if box.width() is None or box.width() > self.eps:
            return False
        if box.lo_open or box.hi_open:
            return False
        try:
            flo = self._point(box.lo.val)
            fhi = self._point(box.hi.val)
        except ArithmeticError:
            return False
        if flo == 0:
            self.cert.claim(UNIQUE, Interval.point(box.lo),
                            kind="point_zero")
            return True
        if fhi == 0:
            self.cert.claim(UNIQUE, Interval.point(box.hi),
                            kind="point_zero")
            return True
        if flo * fhi < 0 and self._denoms_clear(box):
            self.cert.claim(UNIQUE, box, kind="monotone_sign")
            return True
        return False

    def _decide_small(self, box):
        if self.rational is None:
            return False
        num, den = self.rational
        c = _sturm_count_range(num, box)
        if c == 0:
            self.cert.step("sturm", box, [], count=0)
            self.cert.claim(NONE, box, kind="sturm", count=0)
            return True
        if c == 1 and self._denoms_clear(box):
            self.cert.step("sturm", box, [box], count=1)
            self.cert.claim(UNIQUE, box, kind="sturm", count=1)
            return True
        return False
