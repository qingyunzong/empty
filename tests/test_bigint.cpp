#include "statlib/bigint.hpp"

#include "check.hpp"

using statlib::BigInt;

static void run() {
    // Basic construction and printing, including values beyond 64 bits.
    CHECK_EQ(BigInt(0).to_string(), "0");
    CHECK_EQ(BigInt(-42).to_string(), "-42");
    CHECK_EQ(BigInt::pow2(64).to_string(), "18446744073709551616");
    CHECK_EQ(BigInt::pow2(100).to_string(), "1267650600228229401496703205376");
    CHECK_EQ(BigInt("-1267650600228229401496703205376").to_string(),
             "-1267650600228229401496703205376");

    // Round-trip through decimal strings.
    BigInt a("123456789012345678901234567890123456789");
    BigInt b("-987654321098765432109876543210");
    CHECK_EQ(BigInt(a.to_string()), a);
    CHECK_EQ(BigInt(b.to_string()), b);

    // Addition / subtraction identities with big operands.
    CHECK_EQ(a + b - b, a);
    CHECK_EQ((a + b).to_string(), "123456788024691357802469135780246913579");
    CHECK_EQ(a - a, BigInt(0));
    CHECK_EQ(-(-a), a);
    CHECK_EQ(a + (-a), BigInt(0));

    // Multiplication / division identities.
    CHECK_EQ(a * b / b, a);
    CHECK_EQ(a * BigInt(1), a);
    CHECK_EQ(a * BigInt(0), BigInt(0));
    BigInt q, r;
    divmod(a, b, q, r);
    CHECK_EQ(q * b + r, a);
    CHECK(r.sign() >= 0);  // a > 0, truncation keeps remainder sign of dividend

    // Truncated division signs.
    CHECK_EQ(BigInt(-7) / BigInt(2), BigInt(-3));
    CHECK_EQ(BigInt(-7) % BigInt(2), BigInt(-1));
    CHECK_EQ(BigInt(7) / BigInt(-2), BigInt(-3));
    CHECK_EQ(BigInt(7) % BigInt(-2), BigInt(1));
    CHECK_EQ(BigInt(-7) / BigInt(-2), BigInt(3));

    // Shifts.
    CHECK_EQ(BigInt(1) << 100, BigInt::pow2(100));
    CHECK_EQ((a << 37) >> 37, a);
    CHECK_EQ(BigInt(3) << 64, BigInt(3) * BigInt::pow2(64));
    CHECK_EQ(BigInt::pow2(100) >> 100, BigInt(1));

    // Comparisons.
    CHECK(BigInt::pow2(100) > BigInt::pow2(99));
    CHECK(BigInt(-5) < BigInt(0));
    CHECK(BigInt(0) == BigInt(0));
    CHECK(BigInt::pow2(64) > BigInt(-1));
    CHECK(a != b);

    // gcd, including values beyond 64 bits.
    BigInt g = BigInt::pow2(70) * BigInt(27);
    CHECK_EQ(BigInt::gcd(BigInt::pow2(100) * BigInt(27), BigInt::pow2(70) * BigInt(81)), g);
    CHECK_EQ(BigInt::gcd(BigInt(0), BigInt(0)), BigInt(0));
    CHECK_EQ(BigInt::gcd(BigInt(-12), BigInt(18)), BigInt(6));

    // Product of two >64-bit values lands exactly where expected.
    BigInt p = BigInt::pow2(100) * BigInt::pow2(60);
    CHECK_EQ(p, BigInt::pow2(160));
}

TEST_MAIN()
