// Unit + randomized cross-check tests. No external framework.
#include "bigint.hpp"
#include "enumerate.hpp"
#include "model.hpp"
#include "rational.hpp"
#include "solver.hpp"

#include <cstdio>
#include <initializer_list>
#include <random>
#include <tuple>
#include <string>

static int failures = 0;
#define CHECK(cond)                                                        \
    do {                                                                   \
        if (!(cond)) {                                                     \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__,   \
                         #cond);                                           \
            ++failures;                                                    \
        }                                                                  \
    } while (0)

// ---------- BigInt ----------
static void test_bigint() {
    CHECK(BigUInt::fromString("0").toString() == "0");
    CHECK(BigUInt::fromString("123456789012345678901234567890").toString() ==
          "123456789012345678901234567890");
    CHECK(gcd(BigUInt(48), BigUInt(36)) == BigUInt(12));
    CHECK(gcd(BigUInt::fromString("1071"), BigUInt::fromString("462")) ==
          BigUInt(21));

    // cross-check against __int128 with random operands
    std::mt19937_64 rng(42);
    for (int i = 0; i < 2000; ++i) {
        unsigned __int128 a = rng();  // 64-bit operands keep a*b within 128 bits
        unsigned __int128 b = rng();
        auto toStr = [](unsigned __int128 v) {
            if (!v) return std::string("0");
            std::string s;
            while (v) {
                s = char('0' + v % 10) + s;
                v /= 10;
            }
            return s;
        };
        BigUInt A = BigUInt::fromString(toStr(a));
        BigUInt B = BigUInt::fromString(toStr(b));
        CHECK((A + B).toString() == toStr(a + b));
        if (a >= b) CHECK((A - B).toString() == toStr(a - b));
        CHECK((A * B).toString() == toStr(a * b));
        if (b != 0) {
            auto [q, r] = divmod(A, B);
            CHECK(q.toString() == toStr(a / b));
            CHECK(r.toString() == toStr(a % b));
        }
        if (!(a == 0 && b == 0)) {
            auto g = [](unsigned __int128 x, unsigned __int128 y) {
                while (y) {
                    unsigned __int128 t = x % y;
                    x = y;
                    y = t;
                }
                return x;
            };
            CHECK(gcd(A, B).toString() == toStr(g(a, b)));
        }
    }
    // large known constants
    {
        BigUInt f(1);
        for (uint32_t k = 2; k <= 50; ++k) f = BigUInt::mulSmall(f, k);
        CHECK(f.toString() ==
              "30414093201713378043612608166064768844377641568960512000000000000");
        BigUInt two(2);
        BigUInt p = two.shlBits(199);  // 2^200
        CHECK(p.toString() ==
              "1606938044258990275541962092341162602522202993782792835301376");
    }
    // signed arithmetic
    CHECK((BigInt(-5) + BigInt(3)) == BigInt(-2));
    CHECK((BigInt(-5) * BigInt(-3)) == BigInt(15));
    CHECK((BigInt(7) - BigInt(10)) == BigInt(-3));
    CHECK(BigInt(-7).toString() == "-7");
}

// ---------- Rational ----------
static void test_rational() {
    Rational half = Rational::fromInts(1, 2), third = Rational::fromInts(1, 3);
    CHECK((half + third) == Rational::fromInts(5, 6));
    CHECK((half * third) == Rational::fromInts(1, 6));
    CHECK(Rational::fromInts(2, 4) == half);
    CHECK(Rational::fromInts(-6, 9) == Rational::fromInts(-2, 3));
    CHECK(half.str() == "1/2");
    CHECK(Rational::fromInts(7, 1).str() == "7");
    CHECK(half.decimal(3) == "0.500");
    CHECK(Rational::fromInts(1, 7).decimal(6) == "0.142857");
    CHECK((Rational(1) - half) == half);
    // big operands stay exact
    Rational a(BigInt::fromString("123456789012345678901234567890"),
               BigUInt::fromString("98765432109876543210987654321"));
    Rational b(BigInt::fromString("11111111111111111111111111"),
               BigUInt::fromString("33333333333333333333333333"));
    Rational c = a * b;
    CHECK(c.num.mag == a.num.mag / gcd(a.num.mag, b.den) *
                           (b.num.mag / gcd(b.num.mag, a.den)));
}

// ---------- parsing ----------
static void test_parse() {
    CHECK(parseProbability("2/3") == Rational::fromInts(2, 3));
    CHECK(parseProbability("0.75") == Rational::fromInts(3, 4));
    CHECK(parseProbability("1") == Rational(1));
    CHECK(parseProbability("0") == Rational(0));
    Graph g = parseGraph(
        "# comment\n"
        "3 2\n"
        "0 2\n"
        "0 1 1/2\n"
        "1 2 0.5\n");
    CHECK(g.n == 3 && g.edges.size() == 2 && g.s == 0 && g.t == 2);
}

// ---------- solver: known values ----------
static Rational solveExact(const Graph& g) {
    Solver s(g);
    int root = s.solve();
    CHECK(!s.aborted());
    CHECK(s.nodes()[root].loVal == s.nodes()[root].hiVal);
    return s.nodes()[root].loVal;
}

static Graph makeGraph(int n, int s, int t,
                       std::initializer_list<std::tuple<int, int, int64_t, int64_t>> es) {
    Graph g;
    g.n = n;
    g.s = s;
    g.t = t;
    for (auto [u, v, pn, pd] : es)
        g.edges.push_back({u, v, Rational::fromInts(pn, pd)});
    return g;
}

static void test_known() {
    // single edge
    CHECK(solveExact(makeGraph(2, 0, 1, {{0, 1, 2, 3}})) == Rational::fromInts(2, 3));
    // series
    CHECK(solveExact(makeGraph(3, 0, 2, {{0, 1, 1, 2}, {1, 2, 1, 3}})) ==
          Rational::fromInts(1, 6));
    // parallel: 1-(1-1/2)(1-1/3) = 2/3
    CHECK(solveExact(makeGraph(2, 0, 1, {{0, 1, 1, 2}, {0, 1, 1, 3}})) ==
          Rational::fromInts(2, 3));
    // directed "bridge" (computed by hand): 15/32
    CHECK(solveExact(makeGraph(4, 0, 3,
                               {{0, 1, 1, 2},
                                {0, 2, 1, 2},
                                {1, 3, 1, 2},
                                {2, 3, 1, 2},
                                {1, 2, 1, 2}})) == Rational::fromInts(15, 32));
    // cycle: 0->1, 1->0, 1->2 ; need both 0->1 and 1->2
    CHECK(solveExact(makeGraph(3, 0, 2, {{0, 1, 1, 2}, {1, 0, 1, 2}, {1, 2, 1, 2}})) ==
          Rational::fromInts(1, 4));
    // s == t
    CHECK(solveExact(makeGraph(2, 0, 0, {{0, 1, 1, 2}})) == Rational(1));
    // unreachable
    CHECK(solveExact(makeGraph(3, 0, 2, {{0, 1, 1, 2}})) == Rational(0));
    // certain edges (p=1) and impossible edges (p=0)
    CHECK(solveExact(makeGraph(3, 0, 2, {{0, 1, 1, 1}, {1, 2, 3, 7}, {0, 2, 0, 1}})) ==
          Rational::fromInts(3, 7));
}

// ---------- randomized cross-checks ----------
static Graph randomGraph(std::mt19937& rng, int maxN, int maxM) {
    Graph g;
    g.n = 2 + rng() % (maxN - 1);
    g.s = 0;
    g.t = g.n - 1;
    int m = 1 + rng() % maxM;
    for (int i = 0; i < m; ++i) {
        int u = rng() % g.n, v = rng() % g.n;
        int64_t d = 1 + rng() % 8;
        int64_t nn = rng() % (d + 1);
        g.edges.push_back({u, v, Rational::fromInts(nn, d)});
    }
    return g;
}

static void test_random_exact() {
    std::mt19937 rng(20261007);
    for (int trial = 0; trial < 400; ++trial) {
        Graph g = randomGraph(rng, 6, 12);
        Solver s(g);
        int root = s.solve();
        CHECK(!s.aborted());
        Rational exact = s.nodes()[root].loVal;
        CHECK(s.nodes()[root].hiVal == exact);
        Rational brute = enumerateExact(g);
        if (!(exact == brute)) {
            std::fprintf(stderr, "trial %d: solver=%s enum=%s\n", trial,
                         exact.str().c_str(), brute.str().c_str());
            CHECK(false);
        }
    }
}

static void test_budget_bounds() {
    std::mt19937 rng(777);
    for (int trial = 0; trial < 200; ++trial) {
        Graph g = randomGraph(rng, 6, 14);
        Rational truth = enumerateExact(g);
        uint64_t budget = 1 + rng() % 25;
        Solver s(g, budget);
        int root = s.solve();
        CHECK(s.internalCount() <= budget);
        const Solver::Node& rn = s.nodes()[root];
        if (s.aborted()) {
            // bounds must bracket the exact value
            if (!(rn.loVal <= truth || rn.loVal == truth) ||
                !(truth <= rn.hiVal || truth == rn.hiVal)) {
                std::fprintf(stderr, "trial %d: [%s, %s] does not bracket %s\n",
                             trial, rn.loVal.str().c_str(), rn.hiVal.str().c_str(),
                             truth.str().c_str());
                CHECK(false);
            }
            CHECK(rn.loVal <= rn.hiVal || rn.loVal == rn.hiVal);
        } else {
            CHECK(rn.loVal == truth);
        }
    }
}

static void test_diagram() {
    Graph g = makeGraph(4, 0, 3,
                        {{0, 1, 1, 2}, {0, 2, 1, 2}, {1, 3, 1, 2}, {2, 3, 1, 2}, {1, 2, 1, 2}});
    Solver s(g);
    int root = s.solve();
    CHECK(s.internalCount() > 0);
    for (const auto& nd : s.nodes()) {
        if (nd.terminal) continue;
        CHECK(nd.edge >= 0 && nd.edge < (int)g.edges.size());
        CHECK(nd.hi >= 0 && nd.hi < (int)s.nodes().size());
        CHECK(nd.lo >= 0 && nd.lo < (int)s.nodes().size());
    }
    std::string dot = s.toDot();
    CHECK(dot.find("digraph") != std::string::npos);
    CHECK(dot.find("15/32") != std::string::npos);
    (void)root;
}

int main() {
    test_bigint();
    test_rational();
    test_parse();
    test_known();
    test_random_exact();
    test_budget_bounds();
    test_diagram();
    if (failures) {
        std::fprintf(stderr, "%d FAILURES\n", failures);
        return 1;
    }
    std::puts("all tests passed");
    return 0;
}
