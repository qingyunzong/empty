#include <motion/bigint.hpp>
#include <motion/rational.hpp>

#include <stdexcept>

#include "check.hpp"

using motion::BigInt;
using motion::Rational;

static Rational R(long long num, long long den = 1) { return Rational(BigInt(num), BigInt(den)); }

int main() {
    // ---- BigInt ----
    CHECK(BigInt(0).to_string() == "0");
    CHECK(BigInt(-7).to_string() == "-7");
    CHECK(BigInt(123456789).to_string() == "123456789");

    BigInt pow2 = 1;
    for (int i = 0; i < 128; ++i) pow2 *= BigInt(2);  // 2^128
    CHECK(pow2.to_string() == "340282366920938463463374607431768211456");
    CHECK((pow2 / BigInt(10)).to_string() == "34028236692093846346337460743176821145");
    CHECK(pow2 % BigInt(10) == BigInt(6));
    CHECK((pow2 - BigInt(1)).to_string() == "340282366920938463463374607431768211455");
    CHECK((pow2 + pow2) == pow2 * BigInt(2));

    BigInt neg = BigInt(-3) * pow2;
    CHECK(neg.to_string() == "-1020847100762815390390123822295304634368");
    CHECK(neg / BigInt(2) == BigInt(-3) * (pow2 / BigInt(2)));
    CHECK((-pow2) + pow2 == BigInt(0));

    // 向零截断除法与取余
    CHECK(BigInt(-7) / BigInt(2) == BigInt(-3));
    CHECK(BigInt(-7) % BigInt(2) == BigInt(-1));
    CHECK(BigInt(7) % BigInt(-2) == BigInt(1));
    CHECK(BigInt(7) / BigInt(-2) == BigInt(-3));

    CHECK(BigInt::gcd(BigInt(48), BigInt(180)) == BigInt(12));
    CHECK(BigInt::gcd(BigInt(0), BigInt(5)) == BigInt(5));
    CHECK(BigInt::gcd(BigInt(-12), BigInt(18)) == BigInt(6));
    CHECK(BigInt::gcd(pow2, pow2 - BigInt(2)) == BigInt(2));

    CHECK(motion::compare(BigInt(-5), BigInt(3)) < 0);
    CHECK(motion::compare(BigInt(3), BigInt(3)) == 0);
    CHECK(BigInt(-1) < BigInt(0) && BigInt(0) < BigInt(1));

    bool threw = false;
    try {
        (void)(BigInt(1) / BigInt(0));
    } catch (const std::domain_error&) {
        threw = true;
    }
    CHECK(threw);

    // ---- Rational ----
    CHECK(R(1, 2) + R(1, 3) == R(5, 6));
    CHECK(R(1, 2) - R(1, 3) == R(1, 6));
    CHECK(R(3, 4) * R(2, 9) == R(1, 6));
    CHECK(R(1, 2) / R(3, 5) == R(5, 6));
    CHECK(R(0, 7) == R(0));

    // 约分与符号规范化
    CHECK(R(2, 4) == R(1, 2));
    CHECK(R(-1, -2) == R(1, 2));
    CHECK(R(1, -2) == R(-1, 2));
    CHECK(R(1, -2).to_string() == "-1/2");
    CHECK(R(6, 3).to_string() == "2");
    CHECK(R(5, 6).to_string() == "5/6");

    // 比较
    CHECK(R(1, 3) < R(1, 2));
    CHECK(R(-2, 3) > R(-3, 4));
    CHECK(R(7, 2) >= R(7, 2));

    // 大数精度：1/3 + 1/2^128
    Rational tiny(BigInt(1), pow2);
    Rational sum = R(1, 3) + tiny;
    CHECK(sum.num() == pow2 + BigInt(3));
    CHECK(sum.den() == pow2 * BigInt(3));

    threw = false;
    try {
        Rational bad(BigInt(1), BigInt(0));
        (void)bad;
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    CHECK(threw);

    return tst::summary();
}
