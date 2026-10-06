#include "statlib/rational.hpp"

#include "check.hpp"

using statlib::BigInt;
using statlib::Rational;

static void run() {
    // Normalization: lowest terms, positive denominator.
    CHECK_EQ(Rational(BigInt(2), BigInt(4)), Rational(BigInt(1), BigInt(2)));
    CHECK_EQ(Rational(BigInt(-3), BigInt(-9)), Rational(BigInt(1), BigInt(3)));
    CHECK_EQ(Rational(BigInt(5), BigInt(-10)), Rational(BigInt(-1), BigInt(2)));
    CHECK_EQ(Rational(BigInt(0), BigInt(7)), Rational(BigInt(0)));
    CHECK_EQ(Rational(BigInt(6), BigInt(3)), Rational(BigInt(2)));
    CHECK_EQ(Rational(BigInt(6), BigInt(3)).to_string(), "2");
    CHECK_EQ(Rational(BigInt(-1), BigInt(2)).to_string(), "-1/2");

    // Arithmetic.
    CHECK_EQ(Rational(BigInt(1), BigInt(3)) + Rational(BigInt(1), BigInt(6)),
             Rational(BigInt(1), BigInt(2)));
    CHECK_EQ(Rational(BigInt(1), BigInt(3)) - Rational(BigInt(1), BigInt(2)),
             Rational(BigInt(-1), BigInt(6)));
    CHECK_EQ(Rational(BigInt(2), BigInt(3)) * Rational(BigInt(9), BigInt(4)),
             Rational(BigInt(3), BigInt(2)));
    CHECK_EQ(Rational(BigInt(1), BigInt(2)) / Rational(BigInt(3), BigInt(4)),
             Rational(BigInt(2), BigInt(3)));
    CHECK_EQ(-Rational(BigInt(3), BigInt(7)), Rational(BigInt(-3), BigInt(7)));

    // Comparisons.
    CHECK(Rational(BigInt(1), BigInt(3)) < Rational(BigInt(1), BigInt(2)));
    CHECK(Rational(BigInt(-2), BigInt(3)) < Rational(BigInt(-1), BigInt(2)));

    // Exact arithmetic with huge operands (no floating point anywhere).
    BigInt big = BigInt::pow2(100);
    Rational half(big, big * BigInt(2));
    CHECK_EQ(half, Rational(BigInt(1), BigInt(2)));
    CHECK_EQ(half + half, Rational(BigInt(1)));

    // E[x^2] - E[x]^2 for [1,2,4] is exactly 14/9.
    Rational ex2(BigInt(1 + 4 + 16), BigInt(3));
    Rational ex(BigInt(1 + 2 + 4), BigInt(3));
    CHECK_EQ(ex2 - ex * ex, Rational(BigInt(14), BigInt(9)));
}

TEST_MAIN()
