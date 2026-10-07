#include "exact_stats/rational.hpp"
#include "check.hpp"

using exact_stats::BigInt;
using exact_stats::Rational;

int main() {
    // Canonical reduction and sign normalization.
    CHECK_EQ(Rational(BigInt(2), BigInt(4)).to_string(), std::string("1/2"));
    CHECK_EQ(Rational(BigInt(-3), BigInt(-9)).to_string(), std::string("1/3"));
    CHECK_EQ(Rational(BigInt(0), BigInt(5)).to_string(), std::string("0"));
    CHECK_EQ(Rational(BigInt(5), BigInt(-10)).to_string(), std::string("-1/2"));
    CHECK_EQ(Rational(BigInt(7), BigInt(1)).to_string(), std::string("7"));

    // Arithmetic.
    CHECK_EQ(Rational(BigInt(1), BigInt(3)) + Rational(BigInt(1), BigInt(6)),
             Rational(BigInt(1), BigInt(2)));
    CHECK_EQ(Rational(BigInt(2), BigInt(3)) * Rational(BigInt(9), BigInt(4)),
             Rational(BigInt(3), BigInt(2)));
    CHECK_EQ(Rational(BigInt(1), BigInt(2)) - Rational(BigInt(3), BigInt(4)),
             Rational(BigInt(-1), BigInt(4)));
    CHECK_EQ(Rational(BigInt(3), BigInt(4)) / Rational(BigInt(-9), BigInt(8)),
             Rational(BigInt(-2), BigInt(3)));

    // Comparisons, including across signs and large magnitudes.
    CHECK(Rational(BigInt(1), BigInt(3)) < Rational(BigInt(1), BigInt(2)));
    CHECK(Rational(BigInt(-2), BigInt(3)) < Rational(BigInt(-1), BigInt(2)));
    BigInt big = BigInt::pow10(40);
    CHECK_EQ(Rational(big + BigInt(1), big + BigInt(1)), Rational(1));
    CHECK(Rational(big, big + BigInt(1)) < Rational(1));
    CHECK(Rational(big + BigInt(1), big) > Rational(1));

    // (a/b) * (b/a) == 1 for big operands.
    Rational p(BigInt::from_decimal("123456789012345678901234567890"),
               BigInt::from_decimal("98765432109876543210987654321"));
    Rational q(BigInt::from_decimal("98765432109876543210987654321"),
               BigInt::from_decimal("123456789012345678901234567890"));
    CHECK_EQ(p * q, Rational(1));

    std::cout << "test_rational OK" << std::endl;
    return 0;
}
