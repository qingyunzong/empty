"""Actual runs across degrees and coefficient bit-widths.

These tests only assert correctness of the results and record observed
wall-clock timings for the record; they make NO claim about asymptotic
complexity, which has not been measured or verified.
"""

import random
import time
import unittest

from polygcd import euclid_gcd_qq, gcd_modular
from polygcd import poly


def rand_poly(rng, degree, bits):
    coeffs = []
    for _ in range(degree + 1):
        c = rng.getrandbits(bits)
        coeffs.append(c if rng.random() < 0.5 else -c)
    coeffs[-1] = coeffs[-1] or 1
    return poly.trim(coeffs)


CASES = [
    # (gcd degree, cofactor degree, coefficient bits)
    (2, 2, 32),
    (4, 4, 64),
    (6, 6, 128),
    (8, 8, 256),
    (10, 10, 512),
]


class TestScaling(unittest.TestCase):
    def test_degrees_and_bitwidths(self):
        rng = random.Random(112)
        timings = []
        for deg_d, deg_c, bits in CASES:
            d = rand_poly(rng, deg_d, bits)
            a = rand_poly(rng, deg_c, 16)
            b = rand_poly(rng, deg_c, 16)
            f, g = poly.mul(d, a), poly.mul(d, b)
            start = time.perf_counter()
            got = gcd_modular(f, g)
            elapsed = time.perf_counter() - start
            self.assertEqual(got.status, "ok")
            self.assertEqual(got.gcd, poly.normalize_primitive(d))
            # cross-check small/medium cases with the independent Euclid
            if bits <= 128:
                self.assertEqual(got.gcd, euclid_gcd_qq(f, g))
            timings.append((deg_d, deg_c, bits, len(got.primes_used),
                            round(elapsed, 4)))
        print("\n[scaling observations: deg_d, deg_cofactor, bits, "
              "primes_used, seconds]")
        for row in timings:
            print("   ", row)


if __name__ == "__main__":
    unittest.main()
