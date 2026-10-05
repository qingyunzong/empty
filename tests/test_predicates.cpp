// Test driver: each subcommand is registered as a separate CTest test.
#include "geom/predicates.hpp"

#include <cstdio>
#include <cstring>
#include <random>
#include <string>

using namespace geom;

static int failures = 0;

#define CHECK(cond, ...)                                              \
    do {                                                              \
        if (!(cond)) {                                                \
            ++failures;                                               \
            std::printf("FAIL %s:%d: ", __FILE__, __LINE__);          \
            std::printf(__VA_ARGS__);                                 \
            std::printf("\n");                                        \
        }                                                             \
    } while (0)

static const char* s(Sign s) {
    return s == Sign::positive ? "+" : s == Sign::negative ? "-" : "0";
}

// ---------------------------------------------------------------- orient ---
static int test_orient_basic() {
    Point o{0, 0, 1}, x{4, 0, 2}, y{0, 4, 3};
    auto r1 = orient2d(o, x, y);
    CHECK(r1.sign == Sign::positive && !r1.used_exact, "ccw via filter, got %s exact=%d", s(r1.sign), r1.used_exact);
    auto r2 = orient2d(o, y, x);
    CHECK(r2.sign == Sign::negative && !r2.used_exact, "cw via filter, got %s exact=%d", s(r2.sign), r2.used_exact);
    auto r3 = orient2d(o, x, Point{8, 0, 4}, /*sos_tiebreak=*/false);
    CHECK(r3.sign == Sign::zero && r3.used_exact, "collinear zero via exact, got %s exact=%d", s(r3.sign), r3.used_exact);
    return failures;
}

static int test_orient_degenerate_id() {
    // Exactly collinear triple: sign must come from the ID parity rule.
    Point a{0, 0, 1}, b{2, 2, 2}, c{5, 5, 3};
    auto r = orient2d(a, b, c);
    CHECK(r.used_exact, "collinear must use exact branch");
    CHECK(r.sign == Sign::positive, "ids (1,2,3) even permutation -> +, got %s", s(r.sign));

    auto r2 = orient2d(a, c, b); // ids (1,3,2): odd permutation -> negative
    CHECK(r2.sign == Sign::negative, "ids (1,3,2) odd permutation -> -, got %s", s(r2.sign));

    // Determinism and antisymmetry of the rule.
    CHECK(orient2d(a, b, c).sign == orient2d(a, b, c).sign, "ID rule not deterministic");
    CHECK(orient2d(b, a, c).sign == Sign::negative, "swap a/b flips parity");

    // Duplicate ids -> rule undefined -> zero.
    Point d{1, 1, 1};
    CHECK(orient2d(a, d, Point{3, 3, 1}).sign == Sign::zero, "duplicate ids should yield zero");

    // Without tiebreak, degenerate returns zero.
    CHECK(orient2d(a, b, c, false).sign == Sign::zero, "no-tiebreak collinear should be zero");
    return failures;
}

static int test_orient_near_collinear() {
    // Cassini identity: F45^2 - F44*F46 = 1. The determinant is 1 while the
    // permanent is ~2*F45^2 ~ 2.6e18, far below the filter error bound.
    const std::int64_t F44 = 701408733, F45 = 1134903170, F46 = 1836311903;
    Point a{F45, F44, 1}, b{F46, F45, 2}, c{0, 0, 3};
    auto r = orient2d(a, b, c, false);
    CHECK(r.used_exact, "near-collinear Cassini case must fall to exact branch");
    CHECK(r.sign == Sign::positive, "Cassini det=+1, got %s", s(r.sign));
    CHECK(orient2d_model(a, b, c) == r.sign, "model disagrees on Cassini case");

    // Full-range int64 near-collinear: det = 2^63-1, permanent ~ 2^124.
    const std::int64_t M = std::int64_t{1} << 62;
    Point p{M, M - 1, 1}, q{M - 1, M, 2}, o{0, 0, 3};
    auto r2 = orient2d(p, q, o, false);
    CHECK(r2.used_exact, "int64-extreme case must fall to exact branch");
    CHECK(r2.sign == orient2d_model(p, q, o), "model disagrees on int64-extreme case");
    CHECK(r2.sign == Sign::positive, "expected positive, got %s", s(r2.sign));

    // Negative twin.
    auto r3 = orient2d(q, p, o, false);
    CHECK(r3.sign == Sign::negative && r3.used_exact, "swapped extreme case");
    return failures;
}

static int test_orient_fuzz() {
    std::mt19937_64 rng(20261005);
    int exact_count = 0;
    const int N = 200000;
    for (int i = 0; i < N; ++i) {
        auto rnd_point = [&](std::int64_t id) {
            // Mix full-range and small-magnitude coordinates.
            std::int64_t x, y;
            if (i % 3 == 0) { x = std::int64_t(rng()) >> 1; y = std::int64_t(rng()) >> 1; }
            else            { x = std::int64_t(rng() % 2001) - 1000; y = std::int64_t(rng() % 2001) - 1000; }
            if (rng() & 1) x = -x;
            if (rng() & 1) y = -y;
            return Point{x, y, id};
        };
        Point a = rnd_point(1), b = rnd_point(2), c = rnd_point(3);
        auto r = orient2d(a, b, c, false);
        if (r.used_exact) ++exact_count;
        Sign m = orient2d_model(a, b, c);
        CHECK(r.sign == m, "fuzz orient mismatch: got %s model %s", s(r.sign), s(m));
        if (failures > 5) break;
    }
    std::printf("orient fuzz: %d/%d cases used the exact branch\n", exact_count, N);
    return failures;
}

// --------------------------------------------------------------- incircle ---
static int test_incircle_basic() {
    // Unit square, CCW.
    Point a{0, 0, 1}, b{4, 0, 2}, c{4, 4, 3}, d{0, 4, 4};
    auto inside = incircle(a, b, c, Point{1, 1, 5});
    CHECK(inside.sign == Sign::positive && !inside.used_exact, "center-ish point inside, got %s exact=%d", s(inside.sign), inside.used_exact);
    auto outside = incircle(a, b, c, Point{100, 100, 5});
    CHECK(outside.sign == Sign::negative && !outside.used_exact, "far point outside, got %s exact=%d", s(outside.sign), outside.used_exact);

    // d cocircular with (a,b,c): on the circle through the square corners.
    auto co = incircle(a, b, c, d, /*sos_tiebreak=*/false);
    CHECK(co.sign == Sign::zero && co.used_exact, "cocircular -> zero via exact, got %s", s(co.sign));

    // ID rule on the cocircular case: ids (1,2,3,4) even -> positive.
    auto co_id = incircle(a, b, c, d);
    CHECK(co_id.sign == Sign::positive && co_id.used_exact, "cocircular ID rule even -> +, got %s", s(co_id.sign));
    auto co_id2 = incircle(a, b, d, c); // ids (1,2,4,3): odd -> negative
    CHECK(co_id2.sign == Sign::negative, "cocircular ID rule odd -> -, got %s", s(co_id2.sign));

    // CW winding must give the same inside/outside answer as CCW.
    auto cw = incircle(a, d, c, Point{1, 1, 5}); // (0,0),(0,4),(4,4) is CW
    CHECK(cw.sign == Sign::positive, "CW winding inside, got %s", s(cw.sign));
    return failures;
}

static int test_incircle_near_cocircular() {
    // 3-4-5 circle scaled by 2^58: the permanent is ~K^4 while moving d by
    // a single unit changes the determinant by only ~K^3, so the ratio is
    // far below the filter error bound and the exact branch must engage.
    const std::int64_t K = std::int64_t{1} << 58;
    Point a{3 * K, 4 * K, 1}, b{-4 * K, 3 * K, 2}, c{0, -5 * K, 3};
    Point on{5 * K, 0, 4};          // exactly on the circle
    Point in{5 * K - 1, 0, 5};      // inside by a hair
    Point out{5 * K + 1, 0, 6};     // outside by a hair

    auto r_on = incircle(a, b, c, on, false);
    CHECK(r_on.used_exact && r_on.sign == Sign::zero, "scaled cocircular -> exact zero, got %s", s(r_on.sign));

    auto r_in = incircle(a, b, c, in, false);
    CHECK(r_in.used_exact, "near-cocircular inside must use exact branch");
    CHECK(r_in.sign == incircle_model(a, b, c, in), "model disagrees (inside)");
    CHECK(r_in.sign == Sign::positive, "hair-inside should be positive, got %s", s(r_in.sign));

    auto r_out = incircle(a, b, c, out, false);
    CHECK(r_out.used_exact, "near-cocircular outside must use exact branch");
    CHECK(r_out.sign == incircle_model(a, b, c, out), "model disagrees (outside)");
    CHECK(r_out.sign == Sign::negative, "hair-outside should be negative, got %s", s(r_out.sign));
    return failures;
}

static int test_incircle_fuzz() {
    std::mt19937_64 rng(987654321);
    int exact_count = 0;
    const int N = 100000;
    for (int i = 0; i < N; ++i) {
        auto rnd_point = [&](std::int64_t id) {
            std::int64_t x, y;
            if (i % 4 == 0) { x = std::int64_t(rng()) >> 1; y = std::int64_t(rng()) >> 1; }
            else            { x = std::int64_t(rng() % 4001) - 2000; y = std::int64_t(rng() % 4001) - 2000; }
            if (rng() & 1) x = -x;
            if (rng() & 1) y = -y;
            return Point{x, y, id};
        };
        Point a = rnd_point(1), b = rnd_point(2), c = rnd_point(3), d = rnd_point(4);
        auto r = incircle(a, b, c, d, false);
        if (r.used_exact) ++exact_count;
        Sign m = incircle_model(a, b, c, d);
        CHECK(r.sign == m, "fuzz incircle mismatch: got %s model %s", s(r.sign), s(m));
        if (failures > 5) break;
    }
    std::printf("incircle fuzz: %d/%d cases used the exact branch\n", exact_count, N);
    return failures;
}

// ------------------------------------------------------------------ model ---
static int test_bigint_model() {
    // Self-check the arbitrary-precision model against __int128 on random
    // inputs (63-bit coordinates keep the __int128 oracle overflow-free).
    std::mt19937_64 rng(42);
    for (int i = 0; i < 50000; ++i) {
        auto rnd = [&]() { return static_cast<std::int64_t>(rng() >> 1); };
        Point a{rnd(), rnd(), 1}, b{rnd(), rnd(), 2}, c{rnd(), rnd(), 3};
        __int128 det = (__int128(a.x) - c.x) * (__int128(b.y) - c.y)
                     - (__int128(a.y) - c.y) * (__int128(b.x) - c.x);
        Sign expect = det > 0 ? Sign::positive : det < 0 ? Sign::negative : Sign::zero;
        CHECK(orient2d_model(a, b, c) == expect, "bigint model mismatch vs __int128");
        if (failures > 5) break;
    }
    // BigInt arithmetic identities.
    BigInt x(std::int64_t(-123456789012345ll));
    BigInt y(__int128(1) << 100);
    BigInt z = (x + y) - y;
    CHECK(z == x, "bigint add/sub identity failed");
    CHECK((y * x).sign() == -1, "bigint mul sign failed");
    CHECK((y * x) + y * BigInt(std::int64_t(123456789012345ll)) == BigInt{}, "bigint mul/add identity failed");
    return failures;
}

int main(int argc, char** argv) {
    if (argc < 2) { std::printf("usage: %s <test-name>\n", argv[0]); return 2; }
    std::string t = argv[1];
    int rc = 2;
    if (t == "orient_basic")           rc = test_orient_basic();
    else if (t == "orient_degenerate_id")   rc = test_orient_degenerate_id();
    else if (t == "orient_near_collinear")  rc = test_orient_near_collinear();
    else if (t == "orient_fuzz")            rc = test_orient_fuzz();
    else if (t == "incircle_basic")         rc = test_incircle_basic();
    else if (t == "incircle_near_cocircular") rc = test_incircle_near_cocircular();
    else if (t == "incircle_fuzz")          rc = test_incircle_fuzz();
    else if (t == "bigint_model")           rc = test_bigint_model();
    else { std::printf("unknown test %s\n", t.c_str()); return 2; }
    if (rc == 0) std::printf("%s: OK\n", t.c_str());
    return rc == 0 ? 0 : 1;
}
