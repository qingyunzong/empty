#include "counter_set.hpp"

#include <cstdio>
#include <optional>
#include <random>
#include <stdexcept>
#include <vector>

static int failures = 0;

#define CHECK(cond)                                                     \
    do {                                                                \
        if (!(cond)) {                                                  \
            std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            ++failures;                                                 \
        }                                                               \
    } while (0)

static void testInitialState() {
    CounterSet cs(9);
    CHECK(cs.firstZero() == std::optional<std::size_t>(0));
    CHECK(cs.count(0) == 0);
    CHECK(cs.count(9) == 0);
}

static void testFillAllThenFull() {
    CounterSet cs(4);
    CHECK(cs.add(0, 4, 1));
    CHECK(cs.firstZero() == std::nullopt);  // all full
    CHECK(cs.add(2, 2, 1));
    CHECK(cs.firstZero() == std::nullopt);
    CHECK(cs.add(2, 2, -1));
    CHECK(cs.firstZero() == std::nullopt);  // count[2] back to 1, still full
    CHECK(cs.add(2, 2, -1));
    CHECK(cs.firstZero() == std::optional<std::size_t>(2));
}

static void testFirstZeroIsMinimum() {
    CounterSet cs(9);
    CHECK(cs.add(0, 3, 2));
    CHECK(cs.firstZero() == std::optional<std::size_t>(4));
    CHECK(cs.add(5, 9, 1));
    CHECK(cs.firstZero() == std::optional<std::size_t>(4));
    CHECK(cs.add(4, 4, 1));
    CHECK(cs.firstZero() == std::nullopt);
}

static void testNegativeRejectedAtomically() {
    CounterSet cs(9);
    CHECK(cs.add(0, 9, 3));
    CHECK(cs.add(4, 6, -3));            // now [4,6] are 0, rest 3
    // Subtracting 1 over [3,6] would drive [4,6] negative: reject as a whole.
    CHECK(!cs.add(3, 6, -1));
    for (std::size_t i = 0; i <= 9; ++i) {
        long long expected = (i >= 4 && i <= 6) ? 0 : 3;
        CHECK(cs.count(i) == expected);
    }
    CHECK(cs.firstZero() == std::optional<std::size_t>(4));
    // Exact drain to zero is allowed.
    CHECK(cs.add(0, 3, -3));
    CHECK(cs.firstZero() == std::optional<std::size_t>(0));
}

static void testOutOfRangeThrows() {
    CounterSet cs(3);
    bool threw = false;
    try {
        cs.add(2, 5, 1);
    } catch (const std::out_of_range&) {
        threw = true;
    }
    CHECK(threw);
}

// Cross-check overlapping random updates against a plain count array.
static void testOverlappingUpdatesVsBruteForce() {
    constexpr std::size_t n = 49;
    constexpr int rounds = 4000;
    std::mt19937_64 rng(20261007);
    CounterSet cs(n);
    std::vector<long long> brute(n + 1, 0);

    for (int round = 0; round < rounds; ++round) {
        std::size_t a = rng() % (n + 1);
        std::size_t b = rng() % (n + 1);
        if (a > b) std::swap(a, b);
        long long delta = static_cast<long long>(rng() % 7) - 3;  // [-3, 3]

        bool ok = true;
        if (delta < 0) {
            for (std::size_t i = a; i <= b; ++i) {
                if (brute[i] + delta < 0) { ok = false; break; }
            }
        }
        if (ok) {
            for (std::size_t i = a; i <= b; ++i) brute[i] += delta;
        }
        CHECK(cs.add(a, b, delta) == ok);

        std::optional<std::size_t> expected;
        for (std::size_t i = 0; i <= n; ++i) {
            if (brute[i] == 0) { expected = i; break; }
        }
        CHECK(cs.firstZero() == expected);
    }

    for (std::size_t i = 0; i <= n; ++i) {
        CHECK(cs.count(i) == brute[i]);
    }
}

static void testSingleSlot() {
    CounterSet cs(0);
    CHECK(cs.firstZero() == std::optional<std::size_t>(0));
    CHECK(cs.add(0, 0, 5));
    CHECK(cs.firstZero() == std::nullopt);
    CHECK(!cs.add(0, 0, -6));
    CHECK(cs.add(0, 0, -5));
    CHECK(cs.firstZero() == std::optional<std::size_t>(0));
}

int main() {
    testInitialState();
    testFillAllThenFull();
    testFirstZeroIsMinimum();
    testNegativeRejectedAtomically();
    testOutOfRangeThrows();
    testOverlappingUpdatesVsBruteForce();
    testSingleSlot();

    if (failures == 0) {
        std::printf("all tests passed\n");
        return 0;
    }
    std::printf("%d check(s) failed\n", failures);
    return 1;
}
