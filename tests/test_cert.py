import unittest
from fractions import Fraction as F

from ridag.intervals import Interval, mkset
from ridag.expr import Ctx, Env
from ridag.isolate import isolate, Output, NONE, UNIQUE, UNDECIDED
from ridag import certcheck
from ridag.certcheck import BadCertificate


def S(*ivs):
    return mkset(list(ivs))


def iv(lo, hi, lc=True, hc=True):
    return Interval(F(lo), F(hi), lc, hc)


def cubic(c, x):
    # (2x - 3)(x + 1)(3x - 2)
    return c.mul(c.mul(c.sub(c.mul(c.const(2), x), c.const(3)),
                       c.add(x, c.const(1))),
                 c.sub(c.mul(c.const(3), x), c.const(2)))


def run(budget=5000):
    c = Ctx()
    x = c.var("x")
    env = Env(c)
    dom = S(iv(-3, 3))
    env.set_var("x", dom)
    f = cubic(c, x)
    outs = isolate(c, env, f, "x", dom, budget=budget)
    return c, f, dom, outs


class TestCertificates(unittest.TestCase):
    def test_valid_certificates_pass(self):
        c, f, dom, outs = run()
        self.assertTrue(certcheck.verify(c, f, "x", dom, outs))
        self.assertTrue(any(o.label == UNIQUE for o in outs))
        self.assertTrue(any(o.label == NONE for o in outs))

    def test_tampered_chain_rejected(self):
        c, f, dom, outs = run()
        o = next(o for o in outs if o.label == UNIQUE)
        bad = Output(o.interval, o.label,
                     [iv(-3, 3), iv(0, 4)],  # 2nd step not inside parent
                     dict(o.proof))
        with self.assertRaises(BadCertificate):
            certcheck.check_output(c, f, "x", dom, bad)

    def test_tampered_none_label_rejected(self):
        c, f, dom, outs = run()
        # claim "none" on an interval that does contain a root
        bad = Output(iv(F(1), F(2)), NONE, [iv(-3, 3), iv(F(1), F(2))],
                     {"kind": "excludes_zero"})
        with self.assertRaises(BadCertificate):
            certcheck.check_output(c, f, "x", dom, bad)

    def test_tampered_unique_proof_rejected(self):
        c, f, dom, outs = run()
        o = next(o for o in outs if o.label == UNIQUE)
        proof = dict(o.proof)
        proof["scope"] = iv(-3, 3)  # derivative vanishes in here
        bad = Output(o.interval, o.label, list(o.chain), proof)
        with self.assertRaises(BadCertificate):
            certcheck.check_output(c, f, "x", dom, bad)

    def test_tampered_point_root_rejected(self):
        c, f, dom, outs = run()
        # hand-crafted 'point' certificate with a wrong root location
        bad = Output(Interval.point(F(1, 4)), UNIQUE,
                     [iv(-3, 3), Interval.point(F(1, 4))],
                     {"kind": "point", "m": F(1, 4), "scope": iv(0, 1)})
        with self.assertRaises(BadCertificate):
            certcheck.check_output(c, f, "x", dom, bad)

    def test_chain_outside_domain_rejected(self):
        c, f, dom, outs = run()
        o = outs[0]
        bad = Output(o.interval, o.label, [iv(10, 20)] + list(o.chain),
                     dict(o.proof))
        with self.assertRaises(BadCertificate):
            certcheck.check_output(c, f, "x", dom, bad)

    def test_undecided_only_needs_chain(self):
        c, f, dom, outs = run(budget=1)
        self.assertTrue(all(o.label == UNDECIDED for o in outs))
        self.assertTrue(certcheck.verify(c, f, "x", dom, outs))


if __name__ == "__main__":
    unittest.main()
