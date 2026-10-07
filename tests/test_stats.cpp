#include "exact_stats/stats_array.hpp"
#include "check.hpp"

#include <vector>

using exact_stats::BigInt;
using exact_stats::Rational;
using exact_stats::StatsArray;

static BigInt pow2(unsigned e) {
    BigInt r(1), two(2);
    for (unsigned i = 0; i < e; ++i) r = r * two;
    return r;
}

// Recompute exact statistics from scratch (Σx and Σx²) for verification.
static Rational model_mean(const std::vector<BigInt>& v, std::size_t l, std::size_t r) {
    BigInt s;
    for (std::size_t i = l; i < r; ++i) s += v[i];
    return Rational(s, BigInt::from_u64(r - l));
}
static Rational model_variance(const std::vector<BigInt>& v, std::size_t l, std::size_t r) {
    BigInt s, q;
    for (std::size_t i = l; i < r; ++i) { s += v[i]; q += v[i] * v[i]; }
    BigInt n = BigInt::from_u64(r - l);
    return Rational(n * q - s * s, n * n);
}

static void known_values() {
    StatsArray a = StatsArray::from_values({BigInt(0), BigInt(1)});
    CHECK_EQ(a.mean(), Rational(BigInt(1), BigInt(2)));
    CHECK_EQ(a.variance(), Rational(BigInt(1), BigInt(4)));

    StatsArray b = StatsArray::from_values({BigInt(1), BigInt(2), BigInt(3), BigInt(4)});
    CHECK_EQ(b.mean(), Rational(BigInt(5), BigInt(2)));
    CHECK_EQ(b.variance(), Rational(BigInt(5), BigInt(4)));

    StatsArray c = StatsArray::from_values({BigInt(7), BigInt(7), BigInt(7)});
    CHECK_EQ(c.variance(), Rational(0));
    CHECK_EQ(c.mean(), Rational(7));

    // Range add: [1,2,3,4] += 10 on [1,3) -> [1,12,13,4].
    b.range_add(1, 3, BigInt(10));
    CHECK_EQ(b.at(0), BigInt(1));
    CHECK_EQ(b.at(1), BigInt(12));
    CHECK_EQ(b.at(2), BigInt(13));
    CHECK_EQ(b.at(3), BigInt(4));
    CHECK_EQ(b.sum(), BigInt(30));
    CHECK_EQ(b.sumsq(), BigInt(330));
    CHECK_EQ(b.mean(), Rational(BigInt(15), BigInt(2)));
    CHECK_EQ(b.variance(), Rational(BigInt(105), BigInt(4)));
    // Sub-range queries.
    CHECK_EQ(b.mean(1, 3), Rational(BigInt(25), BigInt(2)));
    CHECK_EQ(b.variance(1, 3), Rational(BigInt(1), BigInt(4)));
}

static void snapshot_isolation() {
    StatsArray base = StatsArray::from_values(
        {BigInt(1), BigInt(2), BigInt(3), BigInt(4), BigInt(5)});
    StatsArray branch_a = base.snapshot();
    StatsArray branch_b = base.snapshot();

    branch_a.range_add(0, 5, BigInt(100));
    branch_b.range_add(0, 2, BigInt(-7));
    branch_b.set(4, BigInt(-1000));
    base.range_add(2, 3, BigInt(1));

    // Base: only its own +1 at index 2.
    CHECK_EQ(base.at(0), BigInt(1));
    CHECK_EQ(base.at(2), BigInt(4));
    CHECK_EQ(base.at(4), BigInt(5));
    CHECK_EQ(base.sum(), BigInt(16));

    // Branch A: everything +100, unaffected by base/branch_b edits.
    CHECK_EQ(branch_a.at(0), BigInt(101));
    CHECK_EQ(branch_a.at(2), BigInt(103));
    CHECK_EQ(branch_a.at(4), BigInt(105));
    CHECK_EQ(branch_a.sum(), BigInt(515));

    // Branch B: -7 on [0,2) and -1000 at 4, unaffected by base/branch_a.
    CHECK_EQ(branch_b.at(0), BigInt(-6));
    CHECK_EQ(branch_b.at(2), BigInt(3));
    CHECK_EQ(branch_b.at(4), BigInt(-1000));
    CHECK_EQ(branch_b.sum(), BigInt(-6 - 5 + 3 + 4 - 1000));

    // Snapshot of a snapshot stays independent too.
    StatsArray branch_b2 = branch_b.snapshot();
    branch_b2.range_add(0, 5, BigInt(1));
    CHECK_EQ(branch_b.at(0), BigInt(-6));
    CHECK_EQ(branch_b2.at(0), BigInt(-5));
}

static void big_values() {
    BigInt huge = pow2(100);              // > 2^64
    BigInt huge2 = BigInt::pow10(45);     // way beyond 64 bits
    StatsArray a = StatsArray::from_values({huge, -huge2, huge + huge2});
    // Mean and variance recomputed by hand from Σx and Σx².
    BigInt sum = huge - huge2 + huge + huge2;         // 2*huge
    BigInt sumsq = huge * huge + huge2 * huge2 + (huge + huge2) * (huge + huge2);
    CHECK_EQ(a.sum(), sum);
    CHECK_EQ(a.sumsq(), sumsq);
    CHECK_EQ(a.mean(), Rational(sum, BigInt(3)));
    CHECK_EQ(a.variance(), Rational(BigInt(3) * sumsq - sum * sum, BigInt(9)));

    // Counts beyond 64 bits via the aggregated API: value 3 with count
    // p = 2^70, value 11 with count q = 2^69 + 1.
    BigInt p = pow2(70);
    BigInt q = pow2(69) + BigInt(1);
    BigInt n = p + q;
    BigInt s = BigInt(3) * p + BigInt(11) * q;
    BigInt sq = BigInt(9) * p + BigInt(121) * q;
    CHECK_EQ(StatsArray::mean_of(s, n), Rational(s, n));
    // Two-point variance: p*q*(a-b)^2 / (p+q)^2, with (a-b)^2 = 64.
    Rational expected(BigInt(64) * p * q, n * n);
    CHECK_EQ(StatsArray::variance_of(s, sq, n), expected);
}

// Randomized cross-check: several snapshot branches evolve independently;
// every query is verified against Σx/Σx² recomputed from a plain model.
static void randomized_cross_check() {
    testutil::SplitMix64 rng{20261008};
    const BigInt two64 = BigInt::from_u64(~0ULL) + BigInt(1);

    auto random_bigint = [&](bool allow_negative) {
        BigInt v;
        int chunks = 1 + (int)rng.below(3); // up to ~192 bits
        for (int k = 0; k < chunks; ++k)
            v = v * two64 + BigInt::from_u64(rng.next());
        if (allow_negative && (rng.next() & 1)) v = -v;
        return v;
    };

    struct Branch {
        StatsArray arr;
        std::vector<BigInt> model;
    };

    std::size_t n = 1 + rng.below(12);
    std::vector<BigInt> init(n);
    for (auto& x : init) x = random_bigint(true);
    std::vector<Branch> branches{{StatsArray::from_values(init), init}};

    for (int iter = 0; iter < 3000; ++iter) {
        std::size_t bi = rng.below(branches.size());
        Branch& b = branches[bi];
        std::size_t m = b.model.size();
        unsigned op = rng.below(10);
        if (op < 3 && branches.size() < 8) {
            branches.push_back({b.arr.snapshot(), b.model});
        } else if (op < 7) {
            std::size_t l = rng.below(m), r = l + rng.below(m - l + 1);
            BigInt delta = random_bigint(true);
            b.arr.range_add(l, r, delta);
            for (std::size_t i = l; i < r; ++i) b.model[i] += delta;
        } else if (op < 9) {
            std::size_t i = rng.below(m);
            BigInt v = random_bigint(true);
            b.arr.set(i, v);
            b.model[i] = v;
        } else {
            std::size_t l = rng.below(m), r = l + 1 + rng.below(m - l);
            CHECK_EQ(b.arr.mean(l, r), model_mean(b.model, l, r));
            CHECK_EQ(b.arr.variance(l, r), model_variance(b.model, l, r));
            BigInt s, q;
            for (std::size_t i = l; i < r; ++i) {
                s += b.model[i];
                q += b.model[i] * b.model[i];
            }
            CHECK_EQ(b.arr.range_sum(l, r), s);
            CHECK_EQ(b.arr.range_sumsq(l, r), q);
        }
    }

    // Final full verification of every branch, element by element.
    for (auto& b : branches) {
        for (std::size_t i = 0; i < b.model.size(); ++i)
            CHECK_EQ(b.arr.at(i), b.model[i]);
        CHECK_EQ(b.arr.mean(), model_mean(b.model, 0, b.model.size()));
        CHECK_EQ(b.arr.variance(), model_variance(b.model, 0, b.model.size()));
    }
}

int main() {
    known_values();
    snapshot_isolation();
    big_values();
    randomized_cross_check();
    std::cout << "test_stats OK" << std::endl;
    return 0;
}
