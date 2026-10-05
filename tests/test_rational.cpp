#include <iostream>

#include "check.hpp"
#include "xreduce/rational.hpp"

using xreduce::BigInt;
using xreduce::Rational;

int main() {
  // Normalization.
  CHECK(Rational(BigInt(2), BigInt(4)) == Rational(BigInt(1), BigInt(2)));
  CHECK(Rational(BigInt(-3), BigInt(-9)).to_string() == "1/3");
  CHECK(Rational(BigInt(5), BigInt(-10)).to_string() == "-1/2");
  CHECK(Rational(BigInt(0), BigInt(7)) == Rational(0));

  // Basic arithmetic.
  CHECK((Rational(BigInt(1), BigInt(2)) + Rational(BigInt(1), BigInt(3)))
            .to_string() == "5/6");
  CHECK((Rational(BigInt(1), BigInt(2)) - Rational(BigInt(1), BigInt(3)))
            .to_string() == "1/6");
  CHECK((Rational(BigInt(2), BigInt(3)) * Rational(BigInt(9), BigInt(4)))
            .to_string() == "3/2");

  // Exact harmonic numbers (verified against Python's fractions module).
  Rational h20;
  for (long long i = 1; i <= 20; ++i)
    h20 = h20 + Rational(BigInt(1), BigInt(i));
  CHECK(h20.to_string() == "55835135/15519504");

  Rational h50;
  for (long long i = 1; i <= 50; ++i)
    h50 = h50 + Rational(BigInt(1), BigInt(i));
  CHECK(h50.to_string() == "13943237577224054960759/3099044504245996706400");

  // Huge operands stay exact.
  Rational big(BigInt::pow2(150), BigInt::pow2(100));
  CHECK(big.to_string() ==
        "1125899906842624/1"); // 2^50, fully reduced

  std::cout << "test_rational: all checks passed" << std::endl;
  return 0;
}
