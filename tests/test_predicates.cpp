// CTest driver for the robust geometry predicates.
// Usage: test_predicates <case-name>

#include <cinttypes>
#include <cstdio>
#include <cstring>
#include <random>
#include <utility>

#include "geom/predicates.hpp"

using geom::Method;
using geom::Point;
using geom::PredicateResult;

static int g_failures = 0;

#define CHECK(cond)                                                        \
    do {                                                                   \
        if (!(cond)) {                                                     \
            ++g_failures;                                                  \
            std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);    \
        }                                                                  \
    } while (0)

static const char* method_name(Method m) {
    switch (m) {
        case Method::kFloatFilter: return "float-filter";
        case Method::kExactI128: return "exact-i128";
        case Method::kExactBigInt: return "exact-bigint";
    }
    return "?";
}

static void report(const char* what, const PredicateResult& r) {
    std::printf("  %-40s sign=%+d degenerate=%d method=%s\n", what, r.sign,
                r.degenerate ? 1 : 0, method_name(r.method));
}

// ---------------------------------------------------------------- orient --

static void orient_basic() {
    Point a{1, 0, 0}, b{2, 4, 0}, c{3, 1, 3};
    PredicateResult r = geom::orient2d(a, b, c);
    report("orient CCW", r);
    CHECK(r.sign == +1);
    CHECK(!r.used_exact());  // clear case: filter must decide

    r = geom::orient2d(a, b, {3, 1, -3});
    report("orient CW", r);
    CHECK(r.sign == -1);
    CHECK(!r.used_exact());

    // Antisymmetry: swapping any two points flips the sign.
    CHECK(geom::orient2d(b, a, c).sign == -geom::orient2d(a, b, c).sign);
    CHECK(geom::orient2d(a, c, b).sign == -geom::orient2d(a, b, c).sign);
}

static void orient_id_rule() {
    // Exactly collinear -> exact tier -> ID rule.
    Point a{1, 0, 0}, b{2, 2, 2}, c{3, 5, 5};
    PredicateResult r = geom::orient2d(a, b, c);
    report("collinear ids(1,2,3)", r);
    CHECK(r.used_exact());
    CHECK(r.method == Method::kExactI128);  // small coords: i128 tier
    CHECK(r.degenerate);
    CHECK(r.sign == geom::id_rule({1, 2, 3}));
    CHECK(r.sign == +1);  // (1,2,3) is already sorted: even parity

    // Antisymmetry of the tie-break.
    PredicateResult s = geom::orient2d(b, a, c);
    report("collinear ids(2,1,3)", s);
    CHECK(s.degenerate);
    CHECK(s.sign == -r.sign);

    // Determinism.
    CHECK(geom::orient2d(a, b, c).sign == r.sign);

    // Large-coordinate collinear case: same rule through the bigint tier.
    const std::int64_t k = std::int64_t{1} << 40;
    PredicateResult t = geom::orient2d({1, 0, 0}, {2, k, k}, {3, 2 * k, 2 * k});
    report("collinear big coords", t);
    CHECK(t.method == Method::kExactBigInt);
    CHECK(t.degenerate);
    CHECK(t.sign == +1);
}

static void orient_extrema() {
    // Near-collinear extrema: coordinates/determinants beyond double
    // precision. Every result is checked against the bigint model.
    const std::int64_t p53 = (std::int64_t{1} << 53) + 1;
    const std::int64_t p62 = std::int64_t{1} << 62;

    struct Case {
        Point a, b, c;
    } cases[] = {
        // det = -(2^53+1): float rounding error (~2^54) exceeds |det|.
        {{1, 0, 0}, {2, p53, p53}, {3, p53 + 1, p53}},
        // det = 2^124 - 1 > 0, far beyond float resolution.
        {{1, 0, 0}, {2, p62, 1}, {3, 1, p62}},
        // det = -(2^124 - 1).
        {{1, 0, 0}, {2, 1, p62}, {3, p62, 1}},
        // det = -2^63 with extreme opposite corners.
        {{1, -p62, -p62}, {2, p62, p62}, {3, p62, p62 - 1}},
        // det = +2^63 (mirror image).
        {{1, -p62, -p62}, {2, p62, p62 - 1}, {3, p62, p62}},
        // Unit-offset from a huge diagonal: det = -2^62.
        {{1, 0, 0}, {2, p62, p62}, {3, p62 + 1, p62}},
    };

    for (const auto& tc : cases) {
        PredicateResult r = geom::orient2d(tc.a, tc.b, tc.c);
        int model = geom::orient2d_model(tc.a, tc.b, tc.c);
        report("extremum", r);
        std::printf("    model sign=%+d\n", model);
        CHECK(r.used_exact());  // filter must not dare to decide these
        CHECK(r.method == Method::kExactBigInt);  // coords exceed i128 tier
        CHECK(model != 0);
        CHECK(r.sign == model);
    }
}

static void orient_fuzz() {
    std::mt19937_64 rng(20261005);
    int counts[3] = {0, 0, 0};
    int degenerates = 0;

    auto run_one = [&](const Point& a, const Point& b, const Point& c) {
        PredicateResult r = geom::orient2d(a, b, c);
        int model = geom::orient2d_model(a, b, c);
        counts[static_cast<int>(r.method)]++;
        if (model == 0) {
            CHECK(r.degenerate);
            CHECK(r.sign == geom::id_rule({a.id, b.id, c.id}));
            ++degenerates;
        } else {
            CHECK(!r.degenerate);
            CHECK(r.sign == model);
        }
    };

    // Uniform random coordinates at several bit widths.
    for (int bits : {8, 20, 29, 40, 53, 62}) {
        std::int64_t lo = -(std::int64_t{1} << bits);
        std::int64_t hi = (std::int64_t{1} << bits) - 1;
        std::uniform_int_distribution<std::int64_t> dist(lo, hi);
        for (int i = 0; i < 4000; ++i) {
            run_one({1, dist(rng), dist(rng)},
                    {2, dist(rng), dist(rng)},
                    {3, dist(rng), dist(rng)});
        }
    }

    // Adversarial near-collinear: c sits on or one lattice step off the
    // primitive line through a and b, with huge coordinates.
    std::uniform_int_distribution<std::int64_t> coord(-(std::int64_t{1} << 60),
                                                      (std::int64_t{1} << 60) - 1);
    std::uniform_int_distribution<std::int64_t> step(-1000000, 1000000);
    std::uniform_int_distribution<int> nudge(-1, 1);
    for (int i = 0; i < 20000; ++i) {
        std::int64_t ax = coord(rng), ay = coord(rng);
        std::int64_t px = step(rng), py = step(rng);
        if (px == 0 && py == 0) px = 1;
        std::int64_t k = step(rng);
        int n = nudge(rng);
        Point a{1, ax, ay};
        Point b{2, ax + px, ay + py};
        Point c{3, ax + k * px - n * py, ay + k * py + n * px};
        run_one(a, b, c);
    }

    // Adversarial near-collinear with small coordinates: exercises the
    // exact i128 tier (collinear cases defeat the float filter).
    std::uniform_int_distribution<std::int64_t> small(-(std::int64_t{1} << 28),
                                                      (std::int64_t{1} << 28) - 1);
    for (int i = 0; i < 5000; ++i) {
        std::int64_t ax = small(rng), ay = small(rng);
        std::int64_t px = step(rng) % 1000, py = step(rng) % 1000;
        if (px == 0 && py == 0) px = 1;
        std::int64_t k = step(rng) % 1000;
        int n = nudge(rng);
        run_one({1, ax, ay},
                {2, ax + px, ay + py},
                {3, ax + k * px - n * py, ay + k * py + n * px});
    }

    std::printf("  fuzz: filter=%d i128=%d bigint=%d degenerate=%d\n",
                counts[0], counts[1], counts[2], degenerates);
    CHECK(counts[1] > 0);  // i128 tier was exercised
    CHECK(counts[2] > 0);  // bigint tier was exercised
}

// --------------------------------------------------------------- incircle --

static void incircle_basic() {
    Point a{1, 0, 0}, b{2, 4, 0}, c{3, 0, 4};  // CCW; circle center (2,2)
    PredicateResult in = geom::incircle(a, b, c, {4, 2, 2});
    report("d inside", in);
    CHECK(in.sign == +1);
    CHECK(!in.used_exact());

    PredicateResult out = geom::incircle(a, b, c, {4, 10, 10});
    report("d outside", out);
    CHECK(out.sign == -1);
    CHECK(!out.used_exact());
}

static void incircle_id_rule() {
    // Cocircular: (1,0),(0,1),(-1,0),(0,-1) all on the unit circle.
    Point a{1, 1, 0}, b{2, 0, 1}, c{3, -1, 0}, d{4, 0, -1};
    PredicateResult r = geom::incircle(a, b, c, d);
    report("cocircular ids(1,2,3,4)", r);
    CHECK(r.used_exact());
    CHECK(r.degenerate);
    CHECK(r.sign == geom::id_rule({1, 2, 3, 4}));
    CHECK(r.sign == +1);

    PredicateResult s = geom::incircle(a, b, d, c);  // swap c,d
    report("cocircular ids(1,2,4,3)", s);
    CHECK(s.degenerate);
    CHECK(s.sign == -r.sign);
}

static void incircle_extrema() {
    // Points on the circle x^2+y^2 = R^2 with R = 5^23 (integer points from
    // the 3-4-5 triple scaled up), plus near-circle probes. Coordinates
    // exceed 2^53, so the float filter cannot even run and the bigint tier
    // must answer; the model confirms it.
    const std::int64_t k5 = 11920928955078125;  // 5^23 > 2^53
    Point a{1, 3 * (k5 / 5), 4 * (k5 / 5)};  // (3,4)*5^22, on circle R=5^23
    Point b{2, 0, k5};                       // (0, R)
    Point c{3, -k5, 0};                      // (-R, 0)
    CHECK(geom::orient2d_model(a, b, c) > 0);  // ensure CCW

    // d exactly on the circle -> degenerate -> ID rule.
    PredicateResult on = geom::incircle(a, b, c, {4, k5, 0});
    report("d on huge circle", on);
    CHECK(on.method == Method::kExactBigInt);
    CHECK(on.degenerate);
    CHECK(on.sign == geom::id_rule({1, 2, 3, 4}));

    // d one lattice step inside / outside along x.
    PredicateResult in = geom::incircle(a, b, c, {4, k5 - 1, 0});
    report("d one step inside", in);
    CHECK(in.method == Method::kExactBigInt);
    CHECK(in.sign == +1);
    CHECK(geom::incircle_model(a, b, c, {4, k5 - 1, 0}) == +1);

    PredicateResult out = geom::incircle(a, b, c, {4, k5 + 1, 0});
    report("d one step outside", out);
    CHECK(out.method == Method::kExactBigInt);
    CHECK(out.sign == -1);
    CHECK(geom::incircle_model(a, b, c, {4, k5 + 1, 0}) == -1);
}

static void incircle_fuzz() {
    std::mt19937_64 rng(20261005);
    int counts[3] = {0, 0, 0};
    int degenerates = 0;

    auto run_one = [&](Point a, Point b, Point c, Point d) {
        int o = geom::orient2d_model(a, b, c);
        if (o < 0) std::swap(b, c);  // enforce CCW triangle
        if (o == 0) return;          // degenerate triangle: skip
        PredicateResult r = geom::incircle(a, b, c, d);
        int model = geom::incircle_model(a, b, c, d);
        counts[static_cast<int>(r.method)]++;
        if (model == 0) {
            CHECK(r.degenerate);
            CHECK(r.sign == geom::id_rule({a.id, b.id, c.id, d.id}));
            ++degenerates;
        } else {
            CHECK(!r.degenerate);
            CHECK(r.sign == model);
        }
    };

    for (int bits : {8, 20, 29, 40, 53}) {
        std::int64_t lo = -(std::int64_t{1} << bits);
        std::int64_t hi = (std::int64_t{1} << bits) - 1;
        std::uniform_int_distribution<std::int64_t> dist(lo, hi);
        for (int i = 0; i < 3000; ++i) {
            run_one({1, dist(rng), dist(rng)},
                    {2, dist(rng), dist(rng)},
                    {3, dist(rng), dist(rng)},
                    {4, dist(rng), dist(rng)});
        }
    }

    // Adversarial near-cocircular: points on/near a scaled integer circle.
    std::uniform_int_distribution<std::int64_t> mag(1, 30000);
    std::uniform_int_distribution<int> nudge(-1, 1);
    for (int i = 0; i < 5000; ++i) {
        std::int64_t m = mag(rng), n = mag(rng);
        // Pythagorean circle through (u,v) with u=m^2-n^2, v=2mn, r=m^2+n^2.
        std::int64_t u = m * m - n * n, v = 2 * m * n, r = m * m + n * n;
        int e = nudge(rng);
        run_one({1, u, v},
                {2, -v, u},
                {3, -u, -v},
                {4, r + e, 0});  // on the circle when e == 0
    }

    std::printf("  fuzz: filter=%d i128=%d bigint=%d degenerate=%d\n",
                counts[0], counts[1], counts[2], degenerates);
    CHECK(counts[1] + counts[2] > 0);
}

// ------------------------------------------------------------------ main --

struct Case {
    const char* name;
    void (*fn)();
};

static const Case kCases[] = {
    {"orient_basic", orient_basic},
    {"orient_id_rule", orient_id_rule},
    {"orient_extrema", orient_extrema},
    {"orient_fuzz", orient_fuzz},
    {"incircle_basic", incircle_basic},
    {"incircle_id_rule", incircle_id_rule},
    {"incircle_extrema", incircle_extrema},
    {"incircle_fuzz", incircle_fuzz},
};

int main(int argc, char** argv) {
    if (argc != 2) {
        std::fprintf(stderr, "usage: %s <case>\n", argv[0]);
        return 2;
    }
    for (const auto& c : kCases) {
        if (std::strcmp(argv[1], c.name) == 0) {
            std::printf("[case %s]\n", c.name);
            c.fn();
            if (g_failures == 0) {
                std::printf("[case %s] OK\n", c.name);
                return 0;
            }
            std::printf("[case %s] %d FAILURE(S)\n", c.name, g_failures);
            return 1;
        }
    }
    std::fprintf(stderr, "unknown case: %s\n", argv[1]);
    return 2;
}
