#include "check.hpp"
#include "curve2d/rational.hpp"

using namespace curve2d;

int main() {
  // Normalization
  CHECK(Rational(2, 4) == Rational(1, 2));
  CHECK(Rational(-3, 6) == Rational(-1, 2));
  CHECK(Rational(3, -6) == Rational(-1, 2));
  CHECK(Rational(0, 7).num() == 0 && Rational(0, 7).den() == 1);
  CHECK(Rational(5).den() == 1);

  // Arithmetic
  CHECK(Rational(1, 2) + Rational(1, 3) == Rational(5, 6));
  CHECK(Rational(1, 2) - Rational(3, 4) == Rational(-1, 4));
  CHECK(Rational(2, 3) * Rational(3, 4) == Rational(1, 2));
  CHECK(Rational(1, 2) / Rational(3, 4) == Rational(2, 3));
  CHECK(-Rational(3, 4) == Rational(-3, 4));

  // Comparison
  CHECK(Rational(1, 3) < Rational(1, 2));
  CHECK(Rational(-2, 3) < Rational(-1, 2));
  CHECK(Rational(2, 4) <= Rational(1, 2));
  CHECK(Rational(7, 3) > Rational(2));
  CHECK(Rational(5, 2) >= Rational(5, 2));

  // Large magnitudes (beyond int64 intermediates)
  i128 big = static_cast<i128>(1) << 100;
  CHECK(Rational(big, 3) * Rational(3, 1) == Rational(big, 1));
  CHECK(Rational(big, big) == Rational(1));

  // String form
  CHECK(Rational(3, 4).toString() == "3/4");
  CHECK(Rational(-6, 3).toString() == "-2");

  return tst::summary("test_rational");
}
