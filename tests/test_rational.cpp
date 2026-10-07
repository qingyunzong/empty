#include <cstdint>
#include <limits>

#include "check.hpp"
#include "motion/rational.hpp"

using motion::Rational;

static void normalization() {
  CHECK(Rational(2, 4) == Rational(1, 2));
  CHECK(Rational(-3, -9) == Rational(1, 3));
  const Rational neg(1, -2);
  CHECK(neg.num() == -1 && neg.den() == 2);
  const Rational zero(0, 7);
  CHECK(zero.num() == 0 && zero.den() == 1);
  CHECK(Rational(5) == Rational(5, 1));
}

static void arithmetic() {
  CHECK(Rational(1, 2) + Rational(1, 3) == Rational(5, 6));
  CHECK(Rational(1, 2) - Rational(2, 3) == Rational(-1, 6));
  CHECK(Rational(2, 3) * Rational(3, 4) == Rational(1, 2));
  CHECK(Rational(2, 3) / Rational(4, 5) == Rational(5, 6));
  CHECK(-Rational(3, 4) == Rational(-3, 4));
  CHECK(Rational(7, 3) + Rational(-7, 3) == Rational(0));
}

static void comparison() {
  CHECK(Rational(1, 3) < Rational(1, 2));
  CHECK(Rational(1, 2) > Rational(1, 3));
  CHECK(Rational(2, 4) <= Rational(1, 2));
  CHECK(Rational(2, 4) >= Rational(1, 2));
  CHECK(Rational(-1, 2) < Rational(1, 3));
  CHECK(Rational(3, 1) != Rational(4, 1));
}

static void string_form() {
  CHECK(Rational(5, 6).to_string() == "5/6");
  CHECK(Rational(-3).to_string() == "-3");
  CHECK(Rational(0).to_string() == "0");
}

static void errors() {
  bool threw = false;
  try {
    Rational(1, 0);
  } catch (const std::domain_error&) { threw = true; }
  CHECK(threw);

  threw = false;
  try {
    Rational(1) / Rational(0);
  } catch (const std::domain_error&) { threw = true; }
  CHECK(threw);

  threw = false;
  try {
    const auto big = Rational(std::numeric_limits<std::int64_t>::max()) * Rational(2);
    (void)big;
  } catch (const std::overflow_error&) { threw = true; }
  CHECK(threw);
}

int main() {
  normalization();
  arithmetic();
  comparison();
  string_form();
  errors();
  return 0;
}
