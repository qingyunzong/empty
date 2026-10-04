#include "curvelib/rational.hpp"
#include "test_util.hpp"

using curvelib::Rational;

int main() {
  // Normalization
  CHECK(Rational(2, 4) == Rational(1, 2));
  CHECK(Rational(-3, 6) == Rational(-1, 2));
  CHECK(Rational(3, -6) == Rational(-1, 2));
  CHECK(Rational(-3, -6) == Rational(1, 2));
  CHECK(Rational(0, 7).isZero());
  CHECK(Rational(5, 1).isInteger());
  CHECK(Rational(10, 5) == Rational(2));

  // Arithmetic
  CHECK(Rational(1, 2) + Rational(1, 3) == Rational(5, 6));
  CHECK(Rational(1, 2) - Rational(2, 3) == Rational(-1, 6));
  CHECK(Rational(2, 3) * Rational(3, 4) == Rational(1, 2));
  CHECK(Rational(1, 2) / Rational(3, 4) == Rational(2, 3));
  CHECK(-Rational(3, 4) == Rational(-3, 4));

  // Comparison across denominators
  CHECK(Rational(1, 3) < Rational(1, 2));
  CHECK(Rational(-2, 3) < Rational(-1, 2));
  CHECK(Rational(7, 4) > Rational(3, 2));
  CHECK(Rational(2, 3) <= Rational(4, 6));
  CHECK(Rational(2, 3) >= Rational(4, 6));

  // Large intermediates (int64 overflow would break these without __int128)
  const std::int64_t big = 3'000'000'000LL; // > 2^31
  CHECK(Rational(big, 1) * Rational(big, 1) == Rational(big * big, 1));
  CHECK(Rational(big, 7) + Rational(big, 13) ==
        Rational(big * 20, 91));

  // Sign / string
  CHECK(Rational(-5, 2).sign() == -1);
  CHECK(Rational(0).sign() == 0);
  CHECK(Rational(4, 2).toString() == "2");
  CHECK(Rational(-6, 4).toString() == "-3/2");

  return testutil::summary("rational");
}
