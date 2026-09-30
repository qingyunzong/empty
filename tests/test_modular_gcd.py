import random
import unittest

from polygcd import euclid_gcd_qq, gcd_modular
from polygcd import poly


def rand_poly(rng, degree, bits):
    coeffs = [rng.getrandbits(bits) * rng.choice((-1, 1)) for _ in range(degree + 1)]
    coeffs[-1] = coeffs[-1] or 1
    return poly.trim(coeffs)


class TestModularGcd(unittest.TestCase):
    def test_basic_against_independent_euclid(self):
        rng = random.Random(20261001)
        for _ in range(30):
            d = rand_poly(rng, rng.randint(0, 3), 8)
            a = rand_poly(rng, rng.randint(0, 4), 8)
            b = rand_poly(rng, rng.randint(0, 4), 8)
            f, g = poly.mul(d, a), poly.mul(d, b)
            got = gcd_modular(f, g)
            want = euclid_gcd_qq(f, g)
            self.assertEqual(got.status, "ok")
            self.assertEqual(got.gcd, want)
            self.assertEqual(got.gcd, poly.normalize_primitive(got.gcd))

    def test_repeated_factors(self):
        d = [3, -1, 2]
        a = [1, 1]
        f = poly.mul(d, poly.mul(a, poly.mul(a, a)))   # d * a^3
        g = poly.mul(d, poly.mul(a, a))                # d * a^2
        got = gcd_modular(f, g)
        want = poly.normalize_primitive(poly.mul(d, poly.mul(a, a)))
        self.assertEqual(got.gcd, want)
        self.assertEqual(got.gcd, euclid_gcd_qq(f, g))

    def test_zero_polynomial(self):
        f = [6, -9, 3]
        self.assertEqual(gcd_modular(f, []).gcd, poly.normalize_primitive(f))
        self.assertEqual(gcd_modular([], f).gcd, poly.normalize_primitive(f))
        with self.assertRaises(ValueError):
            gcd_modular([], [])

    def test_leading_coefficient_vanishing_primes(self):
        # LC = 3*5*7 vanishes modulo 3, 5 and 7.
        f = [2, 105]
        g = [4, 210]
        primes = [3, 5, 7, 11, 13, 17, 19]
        got = gcd_modular(f, g, primes=primes)
        self.assertEqual(got.status, "ok")
        self.assertEqual(set(got.bad_primes["leading_coefficient"]), {3, 5, 7})
        self.assertFalse(set(got.primes_used) & {3, 5, 7})
        self.assertEqual(got.gcd, poly.normalize_primitive([2, 105]))

    def test_unlucky_prime_not_mixed_into_crt(self):
        # f = x, g = x + 7: mod 7 the gcd is x (degree 1), true gcd is 1.
        got = gcd_modular([0, 1], [7, 1], primes=[7, 11, 13])
        self.assertEqual(got.gcd, [1])
        self.assertEqual(got.bad_primes["unlucky"], [7])
        self.assertNotIn(7, got.primes_used)
        self.assertEqual(got.modulus, 11)  # only the good prime accumulated

    def test_restart_on_lower_degree(self):
        # mod 11 the cofactors collide: gcd has degree 2 instead of 1.
        f = poly.mul([1, 1], [2, 1])
        g = poly.mul([1, 1], [13, 1])
        got = gcd_modular(f, g, primes=[11, 13, 17])
        self.assertEqual(got.gcd, [1, 1])
        self.assertIn(11, got.bad_primes["unlucky"])
        self.assertNotIn(11, got.primes_used)

    def test_multiple_crt_moduli_needed(self):
        # GCD coefficients ~ 2**200: a single 61-bit modulus cannot
        # rationally reconstruct them; several CRT factors are required.
        huge = [2 ** 200 + 4561, -(2 ** 190 + 277), 2 ** 180 + 1]
        a = [5, -3, 2, 1]
        b = [7, 11]
        f, g = poly.mul(huge, a), poly.mul(huge, b)
        got = gcd_modular(f, g)
        self.assertEqual(got.gcd, poly.normalize_primitive(huge))
        self.assertGreater(len(got.primes_used), 1)
        self.assertGreater(got.modulus.bit_length(), 200)
        # exact-division witnesses are reported for independent checking
        self.assertEqual(poly.mul(got.gcd, [int(c) for c in
                                            got.checks["exact_division_f"]]),
                         poly.primitive_part(f))

    def test_content_gcd_reported_but_result_primitive(self):
        c1, c2 = 2 ** 80, 2 ** 60 * 3
        d = [1, 2, 3]
        f = poly.scale(poly.mul(d, [1, 1]), c1)
        g = poly.scale(poly.mul(d, [2, 1]), c2)
        got = gcd_modular(f, g)
        self.assertEqual(got.gcd, d)  # primitive, positive LC
        self.assertEqual(got.content_gcd, 2 ** 60)

    def test_budget_exhaustion_and_resume(self):
        huge = [10 ** 60 + 12345, -7, 11, 3, -13, 2]
        a = [1, 2, 3, 4, 5]
        b = [7, -3, 2]
        f, g = poly.mul(huge, a), poly.mul(huge, b)

        first = gcd_modular(f, g, budget=1)
        self.assertEqual(first.status, "budget_exhausted")
        self.assertEqual(first.pending,
                         ["crt_combine", "rational_reconstruction",
                          "exact_division_verification"])
        self.assertIsNotNone(first.state)
        self.assertEqual(len(first.primes_used), 1)

        # stepwise resume: one prime at a time until verified
        state = first.state
        seen = list(first.primes_used)
        for _ in range(20):
            step = gcd_modular(f, g, budget=1, state=state)
            if step.status == "ok":
                break
            self.assertEqual(step.status, "budget_exhausted")
            new = step.primes_used
            # no prime is ever re-used or double counted
            self.assertEqual(len(new), len(set(new)))
            self.assertTrue(set(seen) <= set(new))
            seen = new
            state = step.state
        self.assertEqual(step.status, "ok")
        self.assertEqual(step.gcd, poly.normalize_primitive(huge))
        self.assertEqual(len(step.primes_used), len(set(step.primes_used)))

        # resume in one shot agrees
        full = gcd_modular(f, g, budget=100, state=first.state)
        self.assertEqual(full.gcd, step.gcd)

    def test_resume_rejects_mismatched_inputs(self):
        f, g = [1, 1], [2, 1]
        first = gcd_modular(poly.mul([3, 1], f), poly.mul([3, 1], g), budget=0)
        self.assertEqual(first.status, "budget_exhausted")
        with self.assertRaises(ValueError):
            gcd_modular([9, 9], [4, 2], budget=5, state=first.state)

    def test_explicit_primes_not_recounted_on_resume(self):
        d = [10 ** 40 + 7, -3, 5]
        f = poly.mul(d, [1, 1])
        g = poly.mul(d, [2, 1])
        from polygcd.modp import prev_prime
        primes = []
        c = 2 ** 31
        for _ in range(12):
            c = prev_prime(c)
            primes.append(c)
        first = gcd_modular(f, g, budget=1, primes=primes)
        self.assertEqual(first.status, "budget_exhausted")
        second = gcd_modular(f, g, budget=50, state=first.state, primes=primes)
        self.assertEqual(second.status, "ok")
        self.assertEqual(len(second.primes_used), len(set(second.primes_used)))
        self.assertEqual(second.gcd, poly.normalize_primitive(d))


if __name__ == "__main__":
    unittest.main()
