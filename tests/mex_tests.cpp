#include <cstdlib>
#include <iostream>
#include <optional>
#include <random>
#include <vector>

#include "mex_counter.hpp"

namespace {

int failures = 0;

void check(bool ok, const char* what) {
    if (!ok) {
        ++failures;
        std::cerr << "FAIL: " << what << '\n';
    }
}

// Brute-force reference model: a plain array of counts.
struct Model {
    explicit Model(std::size_t n) : counts(n + 1, 0) {}

    bool add(std::size_t l, std::size_t r, long long delta) {
        if (l > r || r >= counts.size()) {
            return false;
        }
        if (delta < 0) {
            for (std::size_t i = l; i <= r; ++i) {
                if (counts[i] < -delta) {
                    return false;
                }
            }
        }
        for (std::size_t i = l; i <= r; ++i) {
            counts[i] += delta;
        }
        return true;
    }

    std::optional<std::size_t> first_zero() const {
        for (std::size_t i = 0; i < counts.size(); ++i) {
            if (counts[i] == 0) {
                return i;
            }
        }
        return std::nullopt;
    }

    std::vector<long long> counts;
};

void test_basics() {
    MexCounter c(4);  // tracks 0..4
    check(c.first_zero() == std::optional<std::size_t>(0), "empty mex is 0");
    check(c.add(0, 4, 1), "fill all");
    check(c.first_zero() == std::nullopt, "all positive -> full");
    check(c.add(2, 2, -1), "punch hole at 2");
    check(c.first_zero() == std::optional<std::size_t>(2), "mex is 2");
    check(!c.add(2, 2, -1), "subtract below zero rejected");
    check(c.count_at(2) == 0, "rejected op changed nothing");
    check(c.count_at(0) == 1, "other counts intact");
    check(!c.add(0, 5, 1), "out-of-range rejected");
    check(!c.add(3, 1, 1), "inverted range rejected");
}

void test_reject_is_atomic() {
    MexCounter c(3);
    check(c.add(0, 3, 2), "seed counts");
    check(c.add(1, 1, -2), "zero out index 1");
    // Range [0,2] subtract 2 would drive index 1 negative: reject all.
    check(!c.add(0, 2, -2), "overlapping subtract rejected");
    check(c.count_at(0) == 2 && c.count_at(1) == 0 && c.count_at(2) == 2,
          "atomic rejection leaves every count unchanged");
    check(c.first_zero() == std::optional<std::size_t>(1), "mex still 1");
}

// Randomized overlapping updates cross-checked against the model array.
void test_random_against_model(std::mt19937_64& rng, std::size_t n,
                               int rounds) {
    MexCounter c(n);
    Model m(n);
    std::uniform_int_distribution<std::size_t> idx(0, n);
    std::uniform_int_distribution<long long> delta(-4, 6);
    for (int t = 0; t < rounds; ++t) {
        std::size_t a = idx(rng), b = idx(rng);
        if (a > b) {
            std::swap(a, b);
        }
        long long d = delta(rng);
        bool got = c.add(a, b, d);
        bool want = m.add(a, b, d);
        check(got == want, "accept/reject matches model");
        if (got != want) {
            return;
        }
        auto got_mex = c.first_zero();
        auto want_mex = m.first_zero();
        check(got_mex == want_mex, "mex matches model");
        if (got_mex != want_mex) {
            return;
        }
    }
    for (std::size_t i = 0; i <= n; ++i) {
        check(c.count_at(i) == m.counts[i], "final counts match model");
    }
}

}  // namespace

int main() {
    test_basics();
    test_reject_is_atomic();
    std::mt19937_64 rng(20261008);
    for (std::size_t n : {1, 2, 7, 33}) {
        test_random_against_model(rng, n, 20000);
    }
    if (failures != 0) {
        std::cerr << failures << " check(s) failed\n";
        return EXIT_FAILURE;
    }
    std::cout << "all tests passed\n";
    return EXIT_SUCCESS;
}
