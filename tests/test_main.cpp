#include <cstdlib>
#include <iostream>
#include <sstream>
#include <string>

#include "solver.hpp"

using namespace sreach;

static int failures = 0;

#define CHECK(cond)                                                       \
    do {                                                                  \
        if (!(cond)) {                                                    \
            std::cerr << "FAIL " << __FILE__ << ":" << __LINE__ << "  "   \
                      << #cond << "\n";                                   \
            ++failures;                                                   \
        }                                                                 \
    } while (0)

static Rational rat(uint64_t n, uint64_t d) { return Rational(BigInt(n), BigInt(d)); }

static Problem makeProblem(int n, int s, int t, bool undirected,
                           std::initializer_list<std::tuple<int, int, uint64_t, uint64_t>> es) {
    Problem p;
    p.n = n;
    p.s = s;
    p.t = t;
    p.undirected = undirected;
    for (auto [u, v, pn, pd] : es) p.edges.push_back(Edge{u, v, rat(pn, pd)});
    return p;
}

static Rational solveExact(const Problem& p) {
    Solver s(p, 50'000'000);
    Interval r = s.solve();
    CHECK(s.isExact());
    CHECK(r.exact());
    return r.lo;
}

static void testBigInt() {
    BigInt a(~0ULL);  // 2^64 - 1
    BigInt sq = a * a;
    CHECK(sq.toString() == "340282366920938463426481119284349108225");
    CHECK(BigInt::divmod(sq, a).first == a);
    CHECK(BigInt::divmod(sq, a).second.isZero());
    CHECK(BigInt::gcd(sq, a) == a);
    CHECK(BigInt::fromString(sq.toString()) == sq);
    BigInt ten30(1);
    for (int i = 0; i < 30; ++i) ten30 = ten30 * BigInt(10);
    CHECK(ten30.toString() == "1" + std::string(30, '0'));
    CHECK(BigInt::divmod(sq - a, a).first == a - BigInt(1));
    BigInt b = BigInt::fromString("123456789012345678901234567890");
    BigInt c = BigInt::fromString("98765432109876543210");
    CHECK(BigInt::divmod(b * c, c).first == b);
    CHECK(BigInt::gcd(BigInt::fromString("1071"), BigInt::fromString("462")).toString() == "21");
}

static void testRational() {
    CHECK(rat(2, 4) == rat(1, 2));
    CHECK(rat(1, 2) + rat(1, 3) == rat(5, 6));
    CHECK(rat(1, 2) * rat(2, 3) == rat(1, 3));
    CHECK(compare(rat(1, 3), rat(1, 2)) < 0);
    CHECK(compare(rat(3, 4), rat(3, 4)) == 0);
    CHECK(rat(0, 7).toString() == "0/1");
}

static void testKnownGraphs() {
    // series: 0->1->2
    CHECK(solveExact(makeProblem(3, 0, 2, false, {{0, 1, 1, 3}, {1, 2, 1, 2}})) == rat(1, 6));
    // parallel: two edges 0->1
    CHECK(solveExact(makeProblem(2, 0, 1, false, {{0, 1, 2, 3}, {0, 1, 1, 4}})) == rat(3, 4));
    // undirected bridge network, all p = 1/2 -> 1/2
    CHECK(solveExact(makeProblem(4, 0, 3, true,
                                 {{0, 1, 1, 2}, {0, 2, 1, 2}, {1, 2, 1, 2}, {1, 3, 1, 2}, {2, 3, 1, 2}})) ==
          rat(1, 2));
    // directed cycle with a shortcut; back edge 2->0 must not matter
    CHECK(solveExact(makeProblem(3, 0, 2, false,
                                 {{0, 1, 1, 2}, {1, 2, 1, 2}, {2, 0, 1, 2}, {0, 2, 1, 2}})) ==
          rat(5, 8));
    // s == t
    CHECK(solveExact(makeProblem(2, 0, 0, false, {{0, 1, 1, 2}})) == rat(1, 1));
    // unreachable
    CHECK(solveExact(makeProblem(3, 0, 2, false, {{0, 1, 1, 2}})) == rat(0, 1));
}

struct Rng {
    uint64_t s;
    uint64_t next() {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        return s;
    }
    uint64_t below(uint64_t n) { return next() % n; }
};

static void testEnumerationCrossCheck() {
    const uint64_t pns[] = {1, 1, 2, 1, 3, 2, 3, 5};
    const uint64_t pds[] = {2, 3, 3, 4, 4, 5, 7, 6};
    Rng rng{0x9e3779b97f4a7c15ULL};
    for (int iter = 0; iter < 300; ++iter) {
        Problem p;
        p.n = 2 + static_cast<int>(rng.below(5));       // 2..6 vertices
        p.s = 0;
        p.t = p.n - 1;
        p.undirected = rng.below(2) != 0;
        const int m = 1 + static_cast<int>(rng.below(14));  // 1..14 edges
        for (int i = 0; i < m; ++i) {
            int u = static_cast<int>(rng.below(static_cast<uint64_t>(p.n)));
            int v = static_cast<int>(rng.below(static_cast<uint64_t>(p.n)));
            if (u == v) v = (v + 1) % p.n;
            size_t k = rng.below(8);
            p.edges.push_back(Edge{u, v, rat(pns[k], pds[k])});
        }
        Solver s(p, 50'000'000);
        Interval r = s.solve();
        Rational brute = enumerateReachability(p);
        if (!(s.isExact() && r.lo == brute)) {
            std::cerr << "cross-check mismatch at iter " << iter << ": solver "
                      << r.lo.toString() << " enum " << brute.toString() << "\n";
            ++failures;
        }
    }
}

static void testBudgetBounds() {
    // 16-edge graph whose full BDD has 112 nodes; a tiny budget must abort.
    Problem p = makeProblem(6, 0, 5, false,
                            {{0, 1, 1, 2}, {0, 2, 1, 2}, {1, 2, 1, 2}, {1, 3, 1, 2},
                             {2, 3, 1, 2}, {2, 4, 1, 2}, {3, 4, 1, 2}, {3, 5, 1, 2},
                             {4, 5, 1, 2}, {0, 3, 1, 2}, {1, 4, 1, 2}, {2, 5, 1, 2},
                             {4, 1, 1, 2}, {5, 3, 1, 2}, {3, 0, 1, 2}, {0, 4, 1, 2}});
    Solver full(p, 50'000'000);
    Interval exact = full.solve();
    CHECK(full.isExact());

    Solver limited(p, 10);
    Interval bounds = limited.solve();
    CHECK(!limited.isExact());
    CHECK(compare(bounds.lo, bounds.hi) < 0);
    CHECK(compare(bounds.lo, exact.lo) <= 0);
    CHECK(compare(exact.lo, bounds.hi) <= 0);
    // bounds must also bracket the brute-force value
    Rational brute = enumerateReachability(p);
    CHECK(brute == exact.lo);
    CHECK(compare(bounds.lo, brute) <= 0 && compare(brute, bounds.hi) <= 0);
}

static void testParser() {
    std::istringstream in(
        "# comment\n"
        "3 2\n"
        "0 2\n"
        "0 1 1/3   # trailing comment\n"
        "1 2 0.5\n");
    Problem p = parseProblem(in, false);
    CHECK(p.n == 3 && p.edges.size() == 2);
    CHECK(p.edges[0].p == rat(1, 3));
    CHECK(p.edges[1].p == rat(1, 2));

    bool threw = false;
    try {
        std::istringstream bad("2 1\n0 1\n0 1 3/2\n");
        Problem bp = parseProblem(bad, false);
        Solver s(bp, 10);  // probability > 1 rejected here
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    CHECK(threw);
}

static void testDot() {
    Solver s(makeProblem(2, 0, 1, false, {{0, 1, 1, 2}}), 100);
    s.solve();
    std::string dot = s.toDot();
    CHECK(dot.find("digraph bdd") != std::string::npos);
    CHECK(dot.find("e0: 0->1") != std::string::npos);
    CHECK(dot.find("-> t1") != std::string::npos);
    CHECK(dot.find("-> t0") != std::string::npos);
}

int main() {
    testBigInt();
    testRational();
    testKnownGraphs();
    testEnumerationCrossCheck();
    testBudgetBounds();
    testParser();
    testDot();
    if (failures) {
        std::cerr << failures << " failure(s)\n";
        return 1;
    }
    std::cout << "all tests passed\n";
    return 0;
}
