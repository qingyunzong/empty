#include <stdexcept>

#include <detreduce/rational.hpp>

#include "check.hpp"

using detreduce::bigint;
using detreduce::rational;

int main() {
    // Canonical normalization.
    CHECK(rational(bigint(2), bigint(4)) == rational(bigint(1), bigint(2)));
    CHECK(rational(bigint(6), bigint(-8)) == rational(bigint(-3), bigint(4)));
    CHECK(rational(bigint(0), bigint(7)) == rational(0));
    CHECK(rational(bigint(-6), bigint(-8)).to_string() == "3/4");
    CHECK(rational(bigint(5), bigint(1)).to_string() == "5");

    // Zero denominator is rejected.
    bool threw = false;
    try {
        rational bad(bigint(1), bigint(0));
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    CHECK(threw);

    // Arithmetic.
    CHECK(rational(1, 2) + rational(1, 3) == rational(bigint(5), bigint(6)));
    CHECK(rational(1, 2) - rational(1, 3) == rational(bigint(1), bigint(6)));
    CHECK(rational(2, 3) * rational(3, 4) == rational(1, 2));
    CHECK(rational(1, 2) / rational(3, 5) == rational(bigint(5), bigint(6)));
    CHECK(rational(1, 3) < rational(1, 2));
    CHECK(rational(-2, 3) < rational(-1, 2));

    // Harmonic number H_10 = 7381/2520 (exact).
    rational h;
    for (int k = 1; k <= 10; ++k) h += rational(1, k);
    CHECK(h == rational(bigint(7381), bigint(2520)));
    CHECK(h.to_string() == "7381/2520");

    // Geometric series: sum_{k=1..60} 1/2^k = (2^60 - 1) / 2^60.
    bigint pow2 = 1;
    for (int i = 0; i < 60; ++i) pow2 *= 2;
    rational g;
    bigint d = 2;
    for (int k = 0; k < 60; ++k) {
        g += rational(bigint(1), d);
        d *= 2;
    }
    CHECK(g.num() == pow2 - bigint(1));
    CHECK(g.den() == pow2);

    TEST_SUMMARY("test_rational");
}
