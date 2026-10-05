#include "test_util.hpp"

using namespace spatial;

int main() {
    // Equality across different representations.
    CHECK(compare(makeRational(1, 3), makeRational(2, 6)) == 0);
    CHECK(compare(makeRational(1, 3), makeRational(1, 2)) < 0);
    CHECK(compare(makeRational(2, 3), makeRational(1, 2)) > 0);

    // Sign normalization: 3/-4 == -3/4, and -3/-4 == 3/4.
    CHECK(compare(makeRational(3, -4), makeRational(-3, 4)) == 0);
    CHECK(compare(makeRational(-3, -4), makeRational(3, 4)) == 0);
    CHECK(compare(makeRational(-1, 2), makeRational(0, 1)) < 0);

    // Zero handling.
    CHECK(compare(makeRational(0, 7), makeRational(0, 1)) == 0);
    CHECK(compare(makeRational(0, 1), makeRational(1, 1000000)) < 0);

    // Large magnitudes: products exceed 64 bits, must stay exact in __int128.
    const std::int64_t big = 4611686018427387903LL; // 2^62 - 1
    CHECK(compare(makeRational(big, 1), makeRational(big - 1, 1)) > 0);
    CHECK(compare(makeRational(big, 3), makeRational(big - 1, 3)) > 0);
    // 2^62/2^30 vs 2^32: exactly equal, must not be off by rounding.
    CHECK(compare(makeRational(big + 1, 1 << 30), makeRational(1LL << 32, 1)) == 0);
    // Adjacent rationals that any float64 would collapse: differ by 1 in the
    // numerator of a huge fraction.
    CHECK(compare(makeRational((__int128)1 << 100, 3), makeRational(((__int128)1 << 100) + 1, 3)) < 0);

    std::puts("test_rational: OK");
    return 0;
}
