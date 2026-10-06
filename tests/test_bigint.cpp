#include <cstdint>
#include <random>

#include <detreduce/bigint.hpp>

#include "check.hpp"

using detreduce::bigint;

static bigint random_bigint(std::mt19937_64& rng, int max_limbs, bool allow_neg) {
    std::uniform_int_distribution<int> nl(1, max_limbs);
    const int limbs = nl(rng);
    bigint v;
    for (int i = 0; i < limbs; ++i) {
        bigint limb(rng());
        for (int s = 0; s < i; ++s) limb = limb * bigint(0x100000000ull) * bigint(0x100000000ull);
        v += limb;
    }
    if (allow_neg && (rng() & 1)) v = -v;
    return v;
}

int main() {
    CHECK(bigint(0).to_string() == "0");
    CHECK(bigint(-5).to_string() == "-5");
    CHECK(bigint(0) == bigint(-0));
    CHECK((bigint(0xFFFFFFFFFFFFFFFFull) + bigint(1)).to_string() == "18446744073709551616");

    // 2^100 in decimal (known constant).
    bigint p = 1;
    for (int i = 0; i < 100; ++i) p = p * 2;
    CHECK(p.to_string() == "1267650600228229401496703205376");

    // from_string round trip.
    auto v = bigint::from_string("-123456789012345678901234567890");
    CHECK(v.has_value());
    CHECK(v->to_string() == "-123456789012345678901234567890");
    CHECK(!bigint::from_string("12x3").has_value());

    // Sign and comparison.
    CHECK(bigint(-3) < bigint(2));
    CHECK(bigint(-5) < bigint(-3));
    CHECK(bigint(7) > bigint(-100));
    CHECK(bigint(0).sign() == 0 && bigint(-9).sign() == -1 && bigint(9).sign() == 1);

    // Randomized arithmetic identities over multiple limbs.
    std::mt19937_64 rng(42);
    for (int t = 0; t < 300; ++t) {
        const bigint a = random_bigint(rng, 4, true);
        const bigint b = random_bigint(rng, 4, true);
        CHECK(a + b - b == a);
        CHECK(a * b == b * a);
        CHECK((a + b) * (a - b) == a * a - b * b);
        if (!b.is_zero()) {
            const bigint q = a / b;
            const bigint r = a % b;
            CHECK(q * b + r == a);
            CHECK(r.abs() < b.abs());
            CHECK(r.is_zero() || r.sign() == a.sign());  // truncated division
        }
    }

    // gcd: gcd(g*x, g*y) == g * gcd(x, y).
    for (int t = 0; t < 100; ++t) {
        const bigint g = random_bigint(rng, 2, false) + bigint(1);
        const bigint x = random_bigint(rng, 2, false) + bigint(1);
        const bigint y = random_bigint(rng, 2, false) + bigint(1);
        CHECK(bigint::gcd(g * x, g * y) == g * bigint::gcd(x, y));
    }
    CHECK(bigint::gcd(bigint(0), bigint(12)) == bigint(12));
    CHECK(bigint::gcd(bigint(-8), bigint(12)) == bigint(4));

    TEST_SUMMARY("test_bigint");
}
