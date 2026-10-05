"""Independent certificate checker.

This module deliberately re-implements interval arithmetic and expression
evaluation as a separate code path from ridag.intervals / ridag.expr.  For
every output it verifies:

  - the contraction chain: each step is contained in the previous one and
    the chain starts inside the domain;
  - "none":    0 is not in the independently re-evaluated range;
  - "unique":  the derivative excludes 0 on the scope interval, neither f
               nor f' has a domain hole there, and the existence witness
               (exact point root, or a Newton image contained in the scope)
               checks out;
  - "undecided": chain inclusion only (nothing else is claimed).
"""

from fractions import Fraction

from .intervals import Interval, MINF, PINF, elt, ele, mkset, scontains_zero
from .expr import derive

Z = Fraction(0)
_ONE = Fraction(1)


class BadCertificate(Exception):
    pass


# ---------------------------------------------------------------------
# Independent interval arithmetic (separate implementation).

def _eadd(a, b):
    if a is MINF or a is PINF:
        return a
    if b is MINF or b is PINF:
        return b
    return a + b


def _eneg(v):
    if v is MINF:
        return PINF
    if v is PINF:
        return MINF
    return -v


def _emul(a, b):
    if a is MINF or a is PINF:
        if b is MINF or b is PINF:
            return PINF if (a is PINF) == (b is PINF) else MINF
        assert b != 0
        return a if b > 0 else _eneg(a)
    if b is MINF or b is PINF:
        assert a != 0
        return b if a > 0 else _eneg(b)
    return a * b


def _epow(v, n):
    if v is MINF:
        return PINF if n % 2 == 0 else MINF
    if v is PINF:
        return PINF
    return v ** n


def _eabs(v):
    if v is MINF or v is PINF:
        return PINF
    return abs(v)


def _c_parts(iv):
    res = []
    if elt(iv.lo, Z):
        if elt(iv.hi, Z):
            res.append((-1, Interval(iv.lo, iv.hi, iv.lc, iv.hc)))
        else:
            res.append((-1, Interval(iv.lo, Z, iv.lc, False)))
    if iv.contains(Z):
        res.append((0, Interval.point(Z)))
    if elt(Z, iv.hi):
        if elt(Z, iv.lo):
            res.append((1, Interval(iv.lo, iv.hi, iv.lc, iv.hc)))
        else:
            res.append((1, Interval(Z, iv.hi, False, iv.hc)))
    return res


def _c_mul1(p, sp, q, sq):
    if sp == 0 or sq == 0:
        return Interval.point(Z)
    if sp == sq:
        if sp > 0:
            lo, hi = (p.lo, p.lc, q.lo, q.lc), (p.hi, p.hc, q.hi, q.hc)
        else:
            lo, hi = (p.hi, p.hc, q.hi, q.hc), (p.lo, p.lc, q.lo, q.lc)
    elif sp > 0:
        lo, hi = (p.hi, p.hc, q.lo, q.lc), (p.lo, p.lc, q.hi, q.hc)
    else:
        lo, hi = (p.lo, p.lc, q.hi, q.hc), (p.hi, p.hc, q.lo, q.lc)
    return Interval(_emul(lo[0], lo[2]), _emul(hi[0], hi[2]),
                    lo[1] and lo[3], hi[1] and hi[3])


def _c_sadd(a, b):
    return mkset([Interval(_eadd(i.lo, j.lo), _eadd(i.hi, j.hi),
                           i.lc and j.lc, i.hc and j.hc)
                  for i in a for j in b])


def _c_sneg(a):
    return mkset([Interval(_eneg(i.hi), _eneg(i.lo), i.hc, i.lc) for i in a])


def _c_ssub(a, b):
    return _c_sadd(a, _c_sneg(b))


def _c_smul(a, b):
    out = []
    for i in a:
        for j in b:
            for sp, p in _c_parts(i):
                for sq, q in _c_parts(j):
                    out.append(_c_mul1(p, sp, q, sq))
    return mkset(out)


def _c_srecip(a):
    out = []
    hole = False
    for i in a:
        for sp, p in _c_parts(i):
            if sp == 0:
                hole = True
            elif sp < 0:
                lo = MINF if p.hi == Z else _ONE / p.hi
                hi = Z if p.lo is MINF else _ONE / p.lo
                out.append(Interval(lo, hi, p.hc, p.lc))
            else:
                lo = Z if p.hi is PINF else _ONE / p.hi
                hi = PINF if p.lo == Z else _ONE / p.lo
                out.append(Interval(lo, hi, p.hc, p.lc))
    return mkset(out), hole


def _c_sdiv(a, b):
    r, hole = _c_srecip(b)
    return _c_smul(a, r), hole


def _c_spow(a, n):
    if n == 0:
        return mkset([Interval.point(_ONE)]), False
    if n < 0:
        pos, _ = _c_spow(a, -n)
        return _c_srecip(pos)
    out = []
    for i in a:
        for sp, p in _c_parts(i):
            if sp == 0:
                out.append(Interval.point(Z))
            elif n % 2 == 1:
                out.append(Interval(_epow(p.lo, n), _epow(p.hi, n),
                                    p.lc, p.hc))
            else:
                al, ah = _eabs(p.lo), _eabs(p.hi)
                if ele(al, ah):
                    small, big, sc, bc = p.lo, p.hi, p.lc, p.hc
                else:
                    small, big, sc, bc = p.hi, p.lo, p.hc, p.lc
                lo = _epow(_eabs(small), n)
                hi = _epow(_eabs(big), n)
                out.append(Interval(lo, hi, sc if lo != Z else False, bc))
    return mkset(out), False


def _c_all_pos(s):
    return len(s) > 0 and \
        all(elt(Z, i.lo) or (i.lo == Z and not i.lc) for i in s)


def _c_all_neg(s):
    return len(s) > 0 and \
        all(elt(i.hi, Z) or (i.hi == Z and not i.hc) for i in s)


def _c_eval(node, vals):
    op = node.op
    if op == "const":
        return mkset([Interval.point(node.val)]), False
    if op == "var":
        return vals[node.val], False
    if op == "add":
        a, ha = _c_eval(node.a, vals)
        b, hb = _c_eval(node.b, vals)
        return _c_sadd(a, b), ha or hb
    if op == "sub":
        a, ha = _c_eval(node.a, vals)
        b, hb = _c_eval(node.b, vals)
        return _c_ssub(a, b), ha or hb
    if op == "mul":
        a, ha = _c_eval(node.a, vals)
        b, hb = _c_eval(node.b, vals)
        return _c_smul(a, b), ha or hb
    if op == "div":
        a, ha = _c_eval(node.a, vals)
        b, hb = _c_eval(node.b, vals)
        v, h = _c_sdiv(a, b)
        return v, h or ha or hb
    if op == "pow":
        a, ha = _c_eval(node.a, vals)
        v, h = _c_spow(a, node.val)
        return v, h or ha
    if op == "if":
        c, hc = _c_eval(node.a, vals)
        if not hc and _c_all_pos(c):
            return _c_eval(node.b, vals)
        if not hc and _c_all_neg(c):
            return _c_eval(node.c, vals)
        t, ht = _c_eval(node.b, vals)
        e, he = _c_eval(node.c, vals)
        return mkset(list(t) + list(e)), hc or ht or he
    raise ValueError(op)


# ---------------------------------------------------------------------
# Inclusion checks.

def _iv_subset(inner, outer):
    if not ele(outer.lo, inner.lo) or not ele(inner.hi, outer.hi):
        return False
    if inner.lo == outer.lo and inner.lc and not outer.lc:
        return False
    if inner.hi == outer.hi and inner.hc and not outer.hc:
        return False
    return True


def _set_subset(a, b):
    return all(any(_iv_subset(i, j) for j in b) for i in a)


def _inter_empty(a, b):
    for i in a:
        for j in b:
            lo = i.lo if ele(j.lo, i.lo) else j.lo
            hi = i.hi if ele(i.hi, j.hi) else j.hi
            if elt(lo, hi):
                return False
            if lo == hi:
                if lo == i.lo and lo == j.lo:
                    lc = i.lc and j.lc
                elif lo == i.lo:
                    lc = i.lc
                else:
                    lc = j.lc
                if hi == i.hi and hi == j.hi:
                    hc = i.hc and j.hc
                elif hi == i.hi:
                    hc = i.hc
                else:
                    hc = j.hc
                if lc and hc:
                    return False
    return True


def _point_val(node, vals, var, v):
    res, hole = _c_eval(node, {**vals, var: mkset([Interval.point(v)])})
    if hole or len(res) != 1 or not res[0].is_point():
        return None
    return res[0].lo


def _check_scope(ctx, f, df, var, vals, scope):
    """Common monotonicity conditions: f and f' hole-free on scope and
    0 not in f'(scope).  Returns (df_range,)."""
    dv, dh = _c_eval(df, {**vals, var: mkset([scope])})
    _, fh = _c_eval(f, {**vals, var: mkset([scope])})
    if dh or fh:
        raise BadCertificate("domain hole inside monotonicity scope")
    if scontains_zero(dv):
        raise BadCertificate("derivative may vanish inside scope")
    return dv


# ---------------------------------------------------------------------
# Certificate verification.

def check_output(ctx, f, var, domain, out, vals=None):
    vals = dict(vals or {})
    chain = out.chain
    if not chain or chain[-1] != out.interval:
        raise BadCertificate("chain does not end at the output interval")
    if not _set_subset(mkset([chain[0]]), domain):
        raise BadCertificate("chain root is outside the domain")
    for a, b in zip(chain, chain[1:]):
        if not _iv_subset(b, a):
            raise BadCertificate("contraction inclusion violated")

    i = out.interval
    proof = out.proof
    kind = proof.get("kind")
    df = derive(ctx, f, var)

    if out.label == "none":
        if kind == "excludes_zero":
            v, _ = _c_eval(f, {**vals, var: mkset([i])})
            if scontains_zero(v):
                raise BadCertificate(
                    "'none' output but 0 in re-evaluated range")
        elif kind in ("no_sign_change", "endpoint_root_excluded",
                      "newton_empty"):
            scope = proof.get("scope")
            if scope is None or scope != i:
                raise BadCertificate("bad scope for 'none' proof")
            dv = _check_scope(ctx, f, df, var, vals, scope)
            if kind == "newton_empty":
                m = proof["m"]
                if not scope.contains(m):
                    raise BadCertificate("newton point outside scope")
                mv = _point_val(f, vals, var, m)
                if mv is None or mv == 0:
                    raise BadCertificate("bad newton base point")
                n, _ = _c_sdiv(mkset([Interval.point(mv)]), dv)
                n = _c_sadd(mkset([Interval.point(m)]), _c_sneg(n))
                if not _inter_empty(n, mkset([scope])):
                    raise BadCertificate("newton image meets scope")
            else:
                if scope.lo is MINF or scope.hi is PINF:
                    raise BadCertificate("endpoint proof needs finite ends")
                vlo = _point_val(f, vals, var, scope.lo)
                vhi = _point_val(f, vals, var, scope.hi)
                if vlo is None or vhi is None:
                    raise BadCertificate("endpoint not exactly evaluable")
                if kind == "no_sign_change":
                    if vlo == 0 or vhi == 0 or (vlo < 0) != (vhi < 0):
                        raise BadCertificate("endpoint signs differ")
                else:  # endpoint_root_excluded
                    ok_lo = vlo == 0 and not scope.lc
                    ok_hi = vhi == 0 and not scope.hc
                    if not (ok_lo or ok_hi):
                        raise BadCertificate("no excluded endpoint root")
                    if (vlo == 0) == (vhi == 0):
                        raise BadCertificate("endpoint root on wrong side")
        else:
            raise BadCertificate("unknown 'none' proof kind %r" % (kind,))
        return True

    if out.label == "unique":
        scope = proof.get("scope")
        if scope is None or not _iv_subset(i, scope):
            raise BadCertificate("output not inside uniqueness scope")
        dv = _check_scope(ctx, f, df, var, vals, scope)
        if kind == "point":
            m = proof["m"]
            if not scope.contains(m):
                raise BadCertificate("root point outside scope")
            if _point_val(f, vals, var, m) != 0:
                raise BadCertificate("claimed point root is not a root")
        elif kind == "newton":
            m = proof["m"]
            if not scope.contains(m):
                raise BadCertificate("newton point outside scope")
            mv = _point_val(f, vals, var, m)
            if mv is None or mv == 0:
                raise BadCertificate("bad newton base point")
            n, _ = _c_sdiv(mkset([Interval.point(mv)]), dv)
            n = _c_sadd(mkset([Interval.point(m)]), _c_sneg(n))
            if not _set_subset(n, mkset([scope])):
                raise BadCertificate("newton image not inside scope")
            if not _set_subset(n, mkset([i])):
                raise BadCertificate("newton image not covered by output")
        elif kind == "sign_change":
            if scope.lo is MINF or scope.hi is PINF:
                raise BadCertificate("sign change needs finite ends")
            if i != scope:
                raise BadCertificate("sign change output must equal scope")
            vlo = _point_val(f, vals, var, scope.lo)
            vhi = _point_val(f, vals, var, scope.hi)
            if vlo is None or vhi is None:
                raise BadCertificate("endpoint not exactly evaluable")
            if vlo == 0 or vhi == 0 or (vlo < 0) == (vhi < 0):
                raise BadCertificate("no sign change at endpoints")
        else:
            raise BadCertificate("unknown 'unique' proof kind %r" % (kind,))
        return True

    if out.label == "undecided":
        return True

    raise BadCertificate("unknown label %r" % (out.label,))


def verify(ctx, f, var, domain, outputs, vals=None):
    for o in outputs:
        check_output(ctx, f, var, domain, o, vals)
    return True
