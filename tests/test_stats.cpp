#include "statlib/stats_tree.hpp"

#include <cstdint>
#include <vector>

#include "check.hpp"

using statlib::BigInt;
using statlib::Rational;
using statlib::StatsTree;

// Naive reference model: keeps raw values and recomputes everything from
// scratch via sum(x) and sum(x^2).
struct Naive {
    std::vector<BigInt> a;

    explicit Naive(std::vector<BigInt> v) : a(std::move(v)) {}

    void add(std::size_t l, std::size_t r, const BigInt& v) {
        for (std::size_t i = l; i < r; ++i) a[i] += v;
    }
    BigInt sum(std::size_t l, std::size_t r) const {
        BigInt s;
        for (std::size_t i = l; i < r; ++i) s += a[i];
        return s;
    }
    BigInt sumsq(std::size_t l, std::size_t r) const {
        BigInt s;
        for (std::size_t i = l; i < r; ++i) s += a[i] * a[i];
        return s;
    }
    Rational mean(std::size_t l, std::size_t r) const {
        return Rational(sum(l, r), BigInt(static_cast<unsigned long long>(r - l)));
    }
    Rational variance(std::size_t l, std::size_t r) const {
        Rational ex2(sumsq(l, r), BigInt(static_cast<unsigned long long>(r - l)));
        Rational ex = mean(l, r);
        return ex2 - ex * ex;
    }
};

struct SplitMix {
    std::uint64_t s;
    std::uint64_t next() {
        std::uint64_t z = (s += 0x9E3779B97F4A7C15ULL);
        z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
        z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
        return z ^ (z >> 31);
    }
    // Random signed integer with up to `bits` magnitude bits.
    BigInt bigint(unsigned bits) {
        BigInt v;
        unsigned done = 0;
        while (done < bits) {
            v = (v << 64) + BigInt(static_cast<unsigned long long>(next()));
            done += 64;
        }
        if (bits % 64 != 0) {
            // Trim to requested width by masking via mod 2^bits.
            BigInt m = BigInt::pow2(bits);
            BigInt q, r;
            divmod(v, m, q, r);
            v = r;
        }
        if (next() & 1) v = -v;
        return v;
    }
};

static void check_range(const StatsTree& t, const Naive& n, std::size_t l, std::size_t r) {
    CHECK_EQ(t.sum(l, r), n.sum(l, r));
    CHECK_EQ(t.sumsq(l, r), n.sumsq(l, r));
    CHECK_EQ(t.mean(l, r), n.mean(l, r));
    CHECK_EQ(t.variance(l, r), n.variance(l, r));
}

static void run() {
    // Hand-computed exact values on [1, 2, 4].
    {
        StatsTree t({BigInt(1), BigInt(2), BigInt(4)});
        CHECK_EQ(t.mean(0, 3), Rational(BigInt(7), BigInt(3)));
        CHECK_EQ(t.variance(0, 3), Rational(BigInt(14), BigInt(9)));
        t.add(1, 3, BigInt(3));  // -> [1, 5, 7]
        CHECK_EQ(t.sum(0, 3), BigInt(13));
        CHECK_EQ(t.sumsq(0, 3), BigInt(1 + 25 + 49));
        CHECK_EQ(t.variance(0, 3), Rational(BigInt(56), BigInt(9)));
    }

    // Randomized cross-check against the naive sum/sumsq recomputation on
    // small arrays, with adds and initial values beyond 64 bits.
    {
        SplitMix rng{42};
        for (int trial = 0; trial < 25; ++trial) {
            std::size_t n = 1 + rng.next() % 33;
            std::vector<BigInt> init(n);
            for (auto& v : init) v = rng.bigint(70);
            StatsTree t(init);
            Naive ref(init);
            for (int op = 0; op < 200; ++op) {
                std::size_t l = rng.next() % n;
                std::size_t r = l + 1 + rng.next() % (n - l);
                BigInt v = rng.bigint(70);
                t.add(l, r, v);
                ref.add(l, r, v);
                std::size_t ql = rng.next() % n;
                std::size_t qr = ql + 1 + rng.next() % (n - ql);
                check_range(t, ref, ql, qr);
            }
            check_range(t, ref, 0, n);
        }
    }

    // Snapshot branches must not pollute each other.
    {
        SplitMix rng{7};
        std::size_t n = 17;
        std::vector<BigInt> init(n);
        for (auto& v : init) v = rng.bigint(40);
        StatsTree base(init);
        StatsTree branch_a = base.fork();
        StatsTree branch_b = base.fork();
        Naive ref_base(init), ref_a(init), ref_b(init);
        for (int op = 0; op < 100; ++op) {
            std::size_t l = rng.next() % n;
            std::size_t r = l + 1 + rng.next() % (n - l);
            BigInt va = rng.bigint(50);
            BigInt vb = rng.bigint(50);
            branch_a.add(l, r, va);
            ref_a.add(l, r, va);
            branch_b.add(l, r, vb);
            ref_b.add(l, r, vb);
        }
        check_range(branch_a, ref_a, 0, n);
        check_range(branch_b, ref_b, 0, n);
        check_range(base, ref_base, 0, n);  // untouched by both branches
        // Branching again from a modified tree keeps working.
        StatsTree branch_c = branch_a.fork();
        branch_c.add(0, n, BigInt(5));
        ref_a.add(0, n, BigInt(5));
        check_range(branch_c, ref_a, 0, n);
        ref_a.add(0, n, BigInt(-5));
        check_range(branch_a, ref_a, 0, n);
    }

    // Values far beyond 64 bits, exact to the last digit.
    {
        std::size_t n = 64;
        std::vector<BigInt> init(n);
        for (std::size_t i = 0; i < n; ++i)
            init[i] = BigInt::pow2(100) + BigInt(static_cast<unsigned long long>(i));
        StatsTree t(init);
        Naive ref(init);
        BigInt v = BigInt::pow2(90) + BigInt(12345);
        t.add(0, n, v);
        ref.add(0, n, v);
        t.add(3, 60, BigInt("-999999999999999999999999"));
        ref.add(3, 60, BigInt("-999999999999999999999999"));
        check_range(t, ref, 0, n);
        check_range(t, ref, 3, 60);
        check_range(t, ref, 0, 3);
        check_range(t, ref, 60, 64);
    }

    // Count * value products exceeding 64 bits: adding 2^70 to 100000
    // elements contributes 2^70 * 100000 (~2^87) to the sum, exactly.
    {
        std::size_t n = 100000;
        StatsTree t(std::vector<BigInt>(n, BigInt(1)));
        BigInt v = BigInt::pow2(70);
        t.add(0, n, v);
        BigInt expect_sum = BigInt(static_cast<unsigned long long>(n)) +
                            v * BigInt(static_cast<unsigned long long>(n));
        CHECK_EQ(t.sum(0, n), expect_sum);
        BigInt x = v + BigInt(1);
        CHECK_EQ(t.sumsq(0, n), x * x * BigInt(static_cast<unsigned long long>(n)));
        CHECK_EQ(t.mean(0, n), Rational(x));
        CHECK_EQ(t.variance(0, n), Rational(BigInt(0)));
    }
}

TEST_MAIN()
