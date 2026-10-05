#include <iostream>

#include "check.hpp"
#include "xreduce/bigint.hpp"

using xreduce::BigInt;
using xrtest::Rng;

static BigInt random_bigint(Rng &rng, unsigned limbs) {
  BigInt v(1);
  for (unsigned i = 0; i < limbs; ++i) {
    BigInt limb(static_cast<long long>(rng.next() & 0x7FFFFFFFLL));
    v = v * BigInt(0x7FFFFFFFLL) + limb;
  }
  if (rng.next() & 1)
    v = -v;
  return v;
}

int main() {
  // Powers of two render exactly in decimal.
  CHECK(BigInt::pow2(64).to_string() == "18446744073709551616");
  CHECK(BigInt::pow2(100).to_string() == "1267650600228229401496703205376");
  CHECK(BigInt::pow2(200).to_string() ==
        "1606938044258990275541962092341162602522202993782792835301376");

  // (2^200 - 1) via subtraction.
  BigInt mersenne = BigInt::pow2(200) - BigInt(1);
  CHECK(mersenne.to_string() ==
        "1606938044258990275541962092341162602522202993782792835301375");

  // Small-int sanity.
  CHECK(BigInt(0).to_string() == "0");
  CHECK(BigInt(-42).to_string() == "-42");
  CHECK((BigInt(7) + BigInt(-19)).to_string() == "-12");
  CHECK((BigInt(-7) * BigInt(-13)).to_string() == "91");

  // Algebraic identities on random operands.
  Rng rng(12345);
  for (int trial = 0; trial < 200; ++trial) {
    BigInt a = random_bigint(rng, 1 + rng.below(6));
    BigInt b = random_bigint(rng, 1 + rng.below(6));
    CHECK(a + b == b + a);                 // commutativity
    CHECK((a + b) - b == a);               // add/sub inverse
    CHECK(a * b == b * a);                 // mul commutativity
    CHECK((a - b) + (b - a) == BigInt(0)); // sign symmetry
    if (!b.is_zero()) {
      BigInt q = BigInt::div(a, b);
      BigInt r = BigInt::mod(a, b);
      CHECK(q * b + r == a);               // division identity
      CHECK(r.abs() < b.abs());            // remainder bound
    }
  }

  // gcd: gcd(20!, 15!) == 15!
  BigInt f20(1), f15(1);
  for (long long i = 1; i <= 20; ++i) {
    f20 = f20 * BigInt(i);
    if (i <= 15)
      f15 = f15 * BigInt(i);
  }
  CHECK(BigInt::gcd(f20, f15) == f15);
  CHECK(BigInt::gcd(BigInt(0), BigInt(0)) == BigInt(0));
  CHECK(BigInt::gcd(BigInt(-12), BigInt(18)) == BigInt(6));

  std::cout << "test_bigint: all checks passed" << std::endl;
  return 0;
}
