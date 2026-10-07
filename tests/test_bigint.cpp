#include "exact_stats/bigint.hpp"
#include "check.hpp"

using exact_stats::BigInt;
// gcd and divmod are hidden friends of BigInt, reached via ADL.

static BigInt pow2(unsigned e) {
    BigInt r(1), two(2);
    for (unsigned i = 0; i < e; ++i) r = r * two;
    return r;
}

int main() {
    // Decimal round-trips, including values far beyond 64 bits.
    CHECK_EQ(BigInt(0).to_string(), std::string("0"));
    CHECK_EQ(BigInt(-42).to_string(), std::string("-42"));
    CHECK_EQ(BigInt::from_decimal("123456789012345678901234567890").to_string(),
             std::string("123456789012345678901234567890"));
    CHECK_EQ(BigInt::from_decimal("-99999999999999999999999999999999").to_string(),
             std::string("-99999999999999999999999999999999"));
    CHECK_EQ(BigInt::from_decimal("000123").to_string(), std::string("123"));
    CHECK_EQ(BigInt::from_decimal("-0").to_string(), std::string("0"));

    // Known large values.
    CHECK_EQ(pow2(64).to_string(), std::string("18446744073709551616"));
    CHECK_EQ(pow2(100).to_string(), std::string("1267650600228229401496703205376"));
    BigInt fact(1);
    for (int i = 2; i <= 30; ++i) fact = fact * BigInt(i);
    CHECK_EQ(fact.to_string(), std::string("265252859812191058636308480000000"));

    // Arithmetic identities on pseudo-random operands of varying sizes.
    testutil::SplitMix64 rng{12345};
    const BigInt two64 = BigInt::from_u64(~0ULL) + BigInt(1);
    for (int iter = 0; iter < 300; ++iter) {
        BigInt a, b;
        for (int k = 0; k < 1 + (int)(iter % 4); ++k) {
            a = a * two64 + BigInt::from_u64(rng.next());
            b = b * two64 + BigInt::from_u64(rng.next());
        }
        if (iter % 2) a = -a;
        if (iter % 3) b = -b;

        CHECK_EQ((a + b) - b, a);
        CHECK_EQ((a - b) + b, a);
        CHECK_EQ(a * b, b * a);
        CHECK_EQ(-(-a), a);
        CHECK((a < b) == (b > a));
        CHECK((a == b) == (a - b).is_zero());

        BigInt aa = a.abs(), bb = b.abs();
        if (!bb.is_zero()) {
            auto [q, r] = divmod(aa, bb);
            CHECK_EQ(q * bb + r, aa);
            CHECK(r >= BigInt(0) && r < bb);
            CHECK_EQ(aa / bb, q);
            CHECK_EQ(aa % bb, r);
        }
        BigInt g = gcd(a, b);
        if (!a.is_zero() || !b.is_zero()) {
            CHECK(g > BigInt(0));
            CHECK_EQ(aa % g, BigInt(0));
            CHECK_EQ(bb % g, BigInt(0));
        }
    }

    // Specific gcd / sign checks.
    CHECK_EQ(gcd(pow2(100), pow2(60)), pow2(60));
    CHECK_EQ(gcd(BigInt::from_decimal("1071"), BigInt::from_decimal("462")),
             BigInt(21));
    CHECK(BigInt(-5) < BigInt(3));
    CHECK(BigInt(0) > BigInt(-1));
    CHECK(BigInt::from_decimal("-100000000000000000000") < BigInt(-1));

    // Truncated (C++ semantics) signed division.
    CHECK_EQ(BigInt(-7) / BigInt(2), BigInt(-3));
    CHECK_EQ(BigInt(-7) % BigInt(2), BigInt(-1));
    CHECK_EQ(BigInt(7) / BigInt(-2), BigInt(-3));
    CHECK_EQ(BigInt(7) % BigInt(-2), BigInt(1));
    CHECK_EQ(BigInt(-7) / BigInt(-2), BigInt(3));

    std::cout << "test_bigint OK" << std::endl;
    return 0;
}
