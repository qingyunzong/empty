// Unit tests: NTT+CRT convolution vs. a naive O(n*m) big-integer reference.

#include <cstdint>
#include <cstdio>
#include <random>
#include <vector>

#include "../src/convolution.hpp"

using conv::BigInt;

static int failures = 0;

#define CHECK(cond, msg)                                          \
    do {                                                          \
        if (!(cond)) {                                            \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__,    \
                         __LINE__, msg);                          \
            ++failures;                                           \
        }                                                         \
    } while (0)

static std::vector<BigInt> naive(const std::vector<int64_t>& a,
                                 const std::vector<int64_t>& b) {
    std::vector<BigInt> c(a.size() + b.size() - 1);
    for (size_t i = 0; i < a.size(); ++i)
        for (size_t j = 0; j < b.size(); ++j)
            c[i + j].add(BigInt::from_i64_product(a[i], b[j]));
    return c;
}

static void compare(const std::vector<int64_t>& a, const std::vector<int64_t>& b,
                    const char* tag) {
    auto got = conv::convolution(a, b);
    auto want = naive(a, b);
    CHECK(got.size() == want.size(), tag);
    for (size_t i = 0; i < want.size() && i < got.size(); ++i)
        if (got[i] != want[i]) {
            std::fprintf(stderr, "FAIL %s coeff %zu: got %s want %s\n", tag, i,
                         got[i].to_string().c_str(), want[i].to_string().c_str());
            ++failures;
            return;
        }
}

int main() {
    constexpr int64_t kMax = INT64_MAX;
    constexpr int64_t kMin = INT64_MIN;
    std::mt19937_64 rng(20261007);

    // 1. Random short sequences, mixed magnitudes incl. extremes.
    for (int trial = 0; trial < 200; ++trial) {
        auto gen = [&]() {
            std::vector<int64_t> v(1 + rng() % 40);
            for (auto& x : v) {
                switch (rng() % 6) {
                    case 0: x = kMax; break;
                    case 1: x = kMin; break;
                    case 2: x = 0; break;
                    case 3: x = 1; break;
                    case 4: x = -1; break;
                    default: x = static_cast<int64_t>(rng()); break;
                }
            }
            return v;
        };
        auto a = gen();
        auto b = gen();
        compare(a, b, "random");
    }

    // 2. Extreme positive/negative cancellation: {M,-M} * {M,M} = {M^2, 0, -M^2}.
    {
        std::vector<int64_t> a{kMax, -kMax}, b{kMax, kMax};
        auto c = conv::convolution(a, b);
        BigInt m2 = BigInt::from_i64_product(kMax, kMax);
        CHECK(c.size() == 3, "cancel size");
        CHECK(c[0] == m2, "cancel c0 == M^2");
        CHECK(c[1].is_zero(), "cancel c1 == 0");
        BigInt neg = m2;
        neg.neg = true;
        CHECK(c[2] == neg, "cancel c2 == -M^2");
    }

    // 3. INT64_MIN squares: {m,m} * {m,m} = {2^126, 2^127, 2^126}.
    {
        std::vector<int64_t> a{kMin, kMin}, b{kMin, kMin};
        auto c = conv::convolution(a, b);
        CHECK(c.size() == 3, "min size");
        CHECK(c[0].to_string() == "85070591730234615865843651857942052864",
              "min c0 == 2^126");
        CHECK(c[1].to_string() == "170141183460469231731687303715884105728",
              "min c1 == 2^127");
        CHECK(c[2].to_string() == "85070591730234615865843651857942052864",
              "min c2 == 2^126");
    }

    // 4. Alternating extremes, long enough to stress CRT (vs naive).
    {
        std::vector<int64_t> a(500), b(500);
        for (size_t i = 0; i < 500; ++i) {
            a[i] = (i % 2) ? kMin : kMax;
            b[i] = (i % 2) ? kMax : kMin;
        }
        compare(a, b, "alternating-extremes");
    }

    // 5. Full-scale length: n = m = 100000 (total 200000), a_i = b_i = (-1)^i.
    //    Closed form: c_k = (-1)^k * (k+1) for k < n, (-1)^k * (2n-1-k) after.
    {
        const size_t n = 100000;
        std::vector<int64_t> a(n), b(n);
        for (size_t i = 0; i < n; ++i) a[i] = b[i] = (i % 2) ? -1 : 1;
        auto c = conv::convolution(a, b);
        CHECK(c.size() == 2 * n - 1, "full-scale size");
        for (size_t k = 0; k < c.size(); ++k) {
            int64_t cnt = k < n ? static_cast<int64_t>(k + 1)
                                : static_cast<int64_t>(2 * n - 1 - k);
            if (k % 2) cnt = -cnt;
            BigInt want = BigInt::from_u64(cnt < 0 ? 0ull - static_cast<uint64_t>(cnt)
                                                   : static_cast<uint64_t>(cnt));
            want.neg = cnt < 0;
            if (c[k] != want) {
                std::fprintf(stderr, "FAIL full-scale coeff %zu\n", k);
                ++failures;
                break;
            }
        }
    }

    // 6. Length limit enforced.
    {
        std::vector<int64_t> a(100001, 1), b(100000, 1);
        bool threw = false;
        try {
            conv::convolution(a, b);
        } catch (const std::length_error&) {
            threw = true;
        }
        CHECK(threw, "length limit throws");
    }

    // 7. Degenerate cases.
    compare({0}, {kMin, kMax, kMin}, "zero-times-extremes");
    compare({kMin}, {kMin}, "min-min-single");
    compare({5}, {-7}, "single");

    if (failures == 0) std::puts("all convolution tests passed");
    return failures ? 1 : 0;
}
