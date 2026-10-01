import random
import time
import unittest

from polygcd.engine import ModularGCDEngine
from polygcd.polynomial import mul, trim, exact_div, primitive_part
from polygcd.rational import integer_gcd_rational


def ppow(p, n):
    r = (1,)
    for _ in range(n):
        r = mul(r, p)
    return r


def rand_poly(rng, deg, bits):
    coeffs = []
    for _ in range(deg + 1):
        c = rng.getrandbits(bits)
        if rng.random() < 0.5:
            c = -c
        coeffs.append(c)
    if coeffs[-1] == 0:
        coeffs[-1] = 1
    return trim(coeffs)


class TestEngineBasics(unittest.TestCase):
    def test_repeated_factors(self):
        d = mul(ppow((1, 1), 3), ppow((-2, 1), 2))  # (x+1)^3 (x-2)^2
        f = mul(d, ppow((3, 1), 2))
        g = mul(d, (-5, 1))
        res = ModularGCDEngine(f, g).run()
        self.assertEqual(res["status"], "ok")
        self.assertEqual(tuple(res["primitive_part"]), d)
        self.assertEqual(res["content"], 1)

    def test_zero_polynomial(self):
        res = ModularGCDEngine((), (-4, 8, -4)).run()
        self.assertEqual(res["gcd"], [4, -8, 4])  # 4*(x-1)^2, positive lc
        res = ModularGCDEngine((), ()).run()
        self.assertEqual(res["gcd"], [])
        res = ModularGCDEngine((6, -9, 3), ()).run()
        self.assertEqual(res["gcd"], [6, -9, 3])

    def test_content_gcd_large(self):
        big = 2**60 * 3**25
        f = tuple(big * 6 * c for c in (1, 2, 1))    # 6*big*(x+1)^2
        g = tuple(big * 10 * c for c in (1, 3, 2))   # 10*big*(x+1)(x+2)
        res = ModularGCDEngine(f, g).run()
        self.assertEqual(res["content"], 2 * big)
        self.assertEqual(res["primitive_part"], [1, 1])
        self.assertEqual(res["gcd"], [2 * big, 2 * big])

    def test_bad_primes_leading_coefficient(self):
        # lc(f) = 210 = 2*3*5*7 vanishes modulo 2, 3, 5, 7
        d = (1, 1, 1)
        f = mul(d, (1, 0, 210))
        g = mul(d, (1, 1))
        res = ModularGCDEngine(f, g).run()
        self.assertEqual(res["primitive_part"], [1, 1, 1])
        self.assertTrue({2, 3, 5, 7}.issubset(set(res["bad_primes"])))
        self.assertFalse(set(res["moduli"]) & {2, 3, 5, 7})

    def test_unlucky_prime_not_mixed(self):
        # mod 7 the two cofactors coincide, inflating the modular gcd degree;
        # mod 2 the gcd degree is inflated as well and sets a wrong baseline
        f = (2, 7, 3)    # (x+2)(3x+1)
        g = (2, 35, 17)  # (x+2)(17x+1); 17x+1 == 3x+1 (mod 7)
        res = ModularGCDEngine(f, g).run()
        self.assertEqual(res["primitive_part"], [2, 1])
        self.assertIn(7, res["unlucky_primes"])
        self.assertNotIn(7, res["moduli"])
        self.assertIn(2, res["discarded_primes"])
        self.assertIn(3, res["bad_primes"])

    def test_unlucky_baseline_prime_discarded_on_restart(self):
        # mod 2 both inputs collapse to x^3+1, so the first accumulated
        # congruence is unlucky and must be discarded when degree drops
        d = (1, 1, 1)
        f = mul(d, (1, 1))
        g = mul(d, (1, 3))
        res = ModularGCDEngine(f, g).run()
        self.assertEqual(res["primitive_part"], [1, 1, 1])
        self.assertIn(2, res["discarded_primes"])
        self.assertNotIn(2, res["moduli"])

    def test_multiple_crt_moduli_needed(self):
        rng = random.Random(12345)
        d = rand_poly(rng, 4, 200)
        a = rand_poly(rng, 3, 200)
        b = rand_poly(rng, 3, 200)
        f, g = mul(d, a), mul(d, b)
        res = ModularGCDEngine(f, g).run()
        self.assertGreater(len(res["moduli"]), 1)
        pp = tuple(res["primitive_part"])
        self.assertIsNotNone(exact_div(trim(f), pp))
        self.assertIsNotNone(exact_div(trim(g), pp))
        self.assertIsNotNone(exact_div(pp, primitive_part(d)))

    def test_budget_exhaustion_and_stepwise_resume(self):
        d = (1, 1, 1)
        f = mul(d, (1, 0, 210))
        g = mul(d, (1, 1))
        one_shot = ModularGCDEngine(f, g).run()
        self.assertEqual(one_shot["status"], "ok")

        checkpoint = None
        seen = []
        final = None
        for _ in range(1000):
            eng = ModularGCDEngine(f, g, checkpoint=checkpoint)
            res = eng.run(budget=1)
            self.assertEqual(res["used_primes"][: len(seen)], seen)
            fresh = res["used_primes"][len(seen):]
            self.assertEqual(len(fresh), res["consumed_this_run"])
            self.assertFalse(set(fresh) & set(seen))  # no prime double counted
            seen = res["used_primes"]
            if res["status"] == "ok":
                final = res
                break
            self.assertEqual(res["status"], "budget_exhausted")
            self.assertIn("exact_division_verify", res["pending"])
            checkpoint = res["checkpoint"]
        else:
            self.fail("stepwise computation did not converge")
        self.assertEqual(final["gcd"], one_shot["gcd"])
        self.assertEqual(seen, one_shot["used_primes"])
        self.assertEqual(len(seen), len(set(seen)))

    def test_cross_check_rational_euclid(self):
        rng = random.Random(7)
        for _ in range(30):
            d = rand_poly(rng, rng.randint(0, 3), 8)
            a = rand_poly(rng, rng.randint(0, 3), 8)
            b = rand_poly(rng, rng.randint(0, 3), 8)
            f, g = mul(d, a), mul(d, b)
            res = ModularGCDEngine(f, g).run()
            expected = integer_gcd_rational(f, g)
            self.assertEqual(tuple(res["primitive_part"]), expected)


class TestDegreeBitwidthMatrix(unittest.TestCase):
    """Real runs across degrees and coefficient bit widths.

    These are actual measurements on the test machine only; no
    asymptotic complexity claim is made or implied by this test.
    """

    def test_matrix(self):
        rng = random.Random(2024)
        rows = []
        for deg in (2, 5, 10, 20):
            for bits in (8, 32, 64, 128, 256):
                d = rand_poly(rng, deg, bits)
                a = rand_poly(rng, deg, bits)
                b = rand_poly(rng, deg, bits)
                f, g = mul(d, a), mul(d, b)
                t0 = time.perf_counter()
                res = ModularGCDEngine(f, g).run()
                elapsed = time.perf_counter() - t0
                self.assertEqual(res["status"], "ok")
                pp = tuple(res["primitive_part"])
                self.assertIsNotNone(exact_div(trim(f), pp))
                self.assertIsNotNone(exact_div(trim(g), pp))
                self.assertIsNotNone(exact_div(pp, primitive_part(d)))
                rows.append((deg, bits, res["primes_consumed"],
                             len(res["moduli"]), elapsed))
        print()
        for deg, bits, nprimes, nmod, elapsed in rows:
            print("deg=%2d bits=%3d primes=%3d crt_moduli=%3d time=%.3fs"
                  % (deg, bits, nprimes, nmod, elapsed))


if __name__ == "__main__":
    unittest.main()
