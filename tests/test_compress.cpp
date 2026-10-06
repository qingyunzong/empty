#include "compress.hpp"

#include <cstdlib>
#include <iostream>
#include <random>
#include <string>
#include <vector>

namespace {

int failures = 0;

void check(bool ok, const std::string& what) {
    if (!ok) {
        std::cerr << "FAIL: " << what << '\n';
        ++failures;
    }
}

std::string join(const std::vector<std::string>& pieces) {
    std::string out;
    for (const auto& p : pieces) out += "[" + p + "]";
    return out;
}

void expect(const std::string& s, std::vector<std::string> cand,
            CostParams params, bool feasible, long long cost,
            std::vector<std::string> pieces, const std::string& name) {
    const CompressResult r = compress_min_cost(s, cand, params);
    check(r.feasible == feasible, name + ": feasibility");
    if (!r.feasible || !feasible) return;
    check(r.cost == cost,
          name + ": cost " + std::to_string(r.cost) + " != " + std::to_string(cost));
    check(r.pieces == pieces,
          name + ": pieces " + join(r.pieces) + " != " + join(pieces));
}

void hand_written_tests() {
    // Dictionary reuse beats per-reference fees: "ab","ab" pays dict once.
    expect("abab", {"a", "b", "ab"}, {5, 1, 1}, true, 11, {"ab", "ab"},
           "reuse-dict-entry");

    // Tie between ["aa"] and ["a","a"] (both cost 2); "a" < "aa" wins.
    expect("aa", {"a", "aa"}, {2, 0, 0}, true, 2, {"a", "a"},
           "tie-smallest-sequence");

    // Same tie, but the single long piece is strictly cheaper.
    expect("aa", {"a", "aa"}, {3, 1, 0}, true, 4, {"aa"}, "long-piece-wins");

    // No tiling exists.
    expect("abc", {"ab"}, {1, 1, 1}, false, 0, {}, "infeasible");

    // Length fee is charged per character of every occurrence.
    expect("ab", {"ab"}, {0, 0, 2}, true, 4, {"ab"}, "length-fee");

    // Empty string tiles trivially with zero cost.
    expect("", {"a"}, {1, 1, 1}, true, 0, {}, "empty-string");

    // Duplicate candidates in input are deduplicated.
    expect("aa", {"a", "a"}, {2, 1, 0}, true, 4, {"a", "a"}, "duplicates");
}

void randomized_cross_check() {
    std::mt19937 rng(20261007);
    for (int iter = 0; iter < 2000; ++iter) {
        const int alpha = 2 + static_cast<int>(rng() % 2); // {a,b} or {a,b,c}
        const int n = 1 + static_cast<int>(rng() % 9);     // length 1..9
        std::string s;
        for (int i = 0; i < n; ++i)
            s += static_cast<char>('a' + rng() % alpha);

        const int m = 1 + static_cast<int>(rng() % 5); // 1..5 candidates
        std::vector<std::string> cand;
        for (int i = 0; i < m; ++i) {
            const int len = 1 + static_cast<int>(rng() % 3);
            std::string c;
            for (int j = 0; j < len; ++j)
                c += static_cast<char>('a' + rng() % alpha);
            cand.push_back(c);
        }

        CostParams p{static_cast<long long>(rng() % 5),
                     static_cast<long long>(rng() % 5),
                     static_cast<long long>(rng() % 5)};

        const CompressResult fast = compress_min_cost(s, cand, p);
        const CompressResult slow = compress_brute_force(s, cand, p);

        const std::string ctx = "iter=" + std::to_string(iter) + " s=" + s;
        check(fast.feasible == slow.feasible, ctx + ": feasibility mismatch");
        if (!fast.feasible || !slow.feasible) continue;
        check(fast.cost == slow.cost,
              ctx + ": cost " + std::to_string(fast.cost) +
                  " != brute " + std::to_string(slow.cost));
        check(fast.pieces == slow.pieces,
              ctx + ": pieces " + join(fast.pieces) +
                  " != brute " + join(slow.pieces));
    }
}

} // namespace

int main() {
    hand_written_tests();
    randomized_cross_check();
    if (failures) {
        std::cerr << failures << " failure(s)\n";
        return EXIT_FAILURE;
    }
    std::cout << "all tests passed\n";
    return EXIT_SUCCESS;
}
