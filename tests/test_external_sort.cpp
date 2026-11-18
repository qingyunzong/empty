#include "dlks_formal.hpp"

#include <algorithm>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <numeric>
#include <string>
#include <vector>

namespace {

int g_failures = 0;

#define CHECK(cond)                                                          \
    do {                                                                     \
        if (!(cond)) {                                                       \
            std::fprintf(stderr, "CHECK failed %s:%d: %s\n", __FILE__,       \
                         __LINE__, #cond);                                   \
            ++g_failures;                                                    \
        }                                                                    \
    } while (0)

// Element with a key and its original input position, compared by key only,
// so stability is observable from the output sequence.
struct item {
    int key;
    int origin;
};

struct by_key {
    bool operator()(const item& a, const item& b) const {
        return a.key < b.key;
    }
};

bool same_sequence(const std::vector<item>& a, const std::vector<item>& b) {
    if (a.size() != b.size()) return false;
    for (std::size_t i = 0; i < a.size(); ++i)
        if (a[i].key != b[i].key || a[i].origin != b[i].origin) return false;
    return true;
}

std::vector<item> reference_stable_sort(const std::vector<item>& input) {
    std::vector<item> ref = input;
    std::stable_sort(ref.begin(), ref.end(), by_key{});
    return ref;
}

void check_counts_match(const std::vector<item>& input,
                        const std::vector<item>& output) {
    std::map<int, int> want, got;
    for (const auto& e : input) ++want[e.key];
    for (const auto& e : output) ++got[e.key];
    CHECK(want == got); // same multiset of keys
}

// Exhaustive: every input sequence over a 3-symbol key alphabet, lengths
// 0..7, every memory budget from 2 up to past the input length.
void test_exhaustive_small() {
    constexpr int alphabet = 3;
    constexpr int max_len = 7;
    for (int n = 0; n <= max_len; ++n) {
        int combos = 1;
        for (int i = 0; i < n; ++i) combos *= alphabet;
        for (int code = 0; code < combos; ++code) {
            std::vector<item> input;
            input.reserve(n);
            int rem = code;
            for (int i = 0; i < n; ++i) {
                input.push_back(item{rem % alphabet, i});
                rem /= alphabet;
            }
            const std::vector<item> ref = reference_stable_sort(input);
            for (std::size_t budget = 2; budget <= 9; ++budget) {
                dlks_formal::external_sorter<item, by_key> sorter(budget);
                sorter.push_range(input.begin(), input.end());
                std::vector<item> out;
                sorter.drain(std::back_inserter(out));
                if (!same_sequence(out, ref)) {
                    std::fprintf(stderr,
                                 "mismatch: n=%d code=%d budget=%zu\n", n,
                                 code, budget);
                    CHECK(false);
                }
                check_counts_match(input, out);
            }
        }
    }
}

// Run split points are determined by the budget: every generated run has
// exactly `budget` elements except possibly the final partial run.
void test_run_split_points() {
    for (std::size_t n = 0; n <= 25; ++n) {
        for (std::size_t budget = 2; budget <= 9; ++budget) {
            dlks_formal::external_sorter<item, by_key> sorter(budget);
            for (std::size_t i = 0; i < n; ++i)
                sorter.push(item{static_cast<int>(i % 3), static_cast<int>(i)});
            sorter.finish(); // flushes the final partial run
            const auto& sizes = sorter.generated_run_sizes();
            std::vector<std::size_t> expect(n / budget, budget);
            if (n % budget != 0) expect.push_back(n % budget);
            CHECK(sizes == expect);
            CHECK(std::accumulate(sizes.begin(), sizes.end(),
                                  std::size_t{0}) == n);
        }
    }
}

// Interleave run generation and merging: after every push the number of
// pending runs must stay below the fan-in, and no element may be lost or
// duplicated (conservation: pushed == buffered + elements in runs + emitted).
void test_interleaved_generation_and_merge() {
    for (std::size_t budget = 2; budget <= 7; ++budget) {
        for (std::size_t n : {std::size_t{0}, std::size_t{1}, std::size_t{5},
                              std::size_t{64}, std::size_t{257}}) {
            dlks_formal::external_sorter<item, by_key> sorter(budget);
            std::vector<item> input;
            input.reserve(n);
            unsigned state = 0x9e3779b9u;
            for (std::size_t i = 0; i < n; ++i) {
                state = state * 1664525u + 1013904223u; // LCG, many dup keys
                item e{static_cast<int>((state >> 24) % 4),
                       static_cast<int>(i)};
                input.push_back(e);
                sorter.push(e);
                CHECK(sorter.pending_runs() < sorter.merge_fan_in());
                CHECK(sorter.buffered() + sorter.elements_in_runs() == i + 1);
            }
            const std::vector<item> ref = reference_stable_sort(input);
            // Pull-style drain, checking the stream stays ordered as it comes.
            std::vector<item> out;
            int prev_key = -1;
            while (auto v = sorter.next()) {
                CHECK(v->key >= prev_key); // never out of order
                prev_key = v->key;
                out.push_back(*v);
            }
            CHECK(same_sequence(out, ref));
            check_counts_match(input, out);
        }
    }
}

// Equal keys must come out in original input order (strict stability).
void test_all_equal_keys() {
    for (std::size_t budget = 2; budget <= 6; ++budget) {
        constexpr int n = 40;
        dlks_formal::external_sorter<item, by_key> sorter(budget);
        for (int i = 0; i < n; ++i) sorter.push(item{7, i});
        std::vector<item> out;
        sorter.drain(std::back_inserter(out));
        CHECK(out.size() == static_cast<std::size_t>(n));
        for (int i = 0; i < n; ++i) CHECK(out[i].origin == i);
    }
}

void test_edge_cases() {
    // Empty input.
    {
        dlks_formal::external_sorter<item, by_key> sorter(4);
        CHECK(!sorter.next().has_value());
    }
    // Single element.
    {
        dlks_formal::external_sorter<item, by_key> sorter(2);
        sorter.push(item{5, 0});
        auto v = sorter.next();
        CHECK(v && v->key == 5 && v->origin == 0);
        CHECK(!sorter.next().has_value());
    }
    // Already sorted and reverse sorted inputs.
    for (bool reverse : {false, true}) {
        std::vector<item> input;
        for (int i = 0; i < 50; ++i)
            input.push_back(item{reverse ? 50 - i : i, i});
        const std::vector<item> ref = reference_stable_sort(input);
        for (std::size_t budget = 2; budget <= 10; ++budget) {
            std::vector<item> out;
            dlks_formal::external_sort(input.begin(), input.end(),
                                       std::back_inserter(out), budget,
                                       by_key{});
            CHECK(same_sequence(out, ref));
        }
    }
    // Budget below 2 is rejected.
    {
        bool threw = false;
        try {
            dlks_formal::external_sorter<item, by_key> sorter(1);
        } catch (const std::invalid_argument&) {
            threw = true;
        }
        CHECK(threw);
    }
}

// One-shot API on a different value type (strings), verifying the multiset
// of results equals the input and ordering matches the naive full sort.
void test_one_shot_strings() {
    std::vector<std::string> input = {"pear", "fig", "apple", "fig",
                                      "kiwi", "apple", "fig"};
    for (std::size_t budget = 2; budget <= 8; ++budget) {
        std::vector<std::string> out;
        dlks_formal::external_sort(input.begin(), input.end(),
                                   std::back_inserter(out), budget);
        std::vector<std::string> ref = input;
        std::stable_sort(ref.begin(), ref.end());
        CHECK(out == ref);
        CHECK(std::is_permutation(out.begin(), out.end(), input.begin()));
    }
}

} // namespace

int main() {
    test_exhaustive_small();
    test_run_split_points();
    test_interleaved_generation_and_merge();
    test_all_equal_keys();
    test_edge_cases();
    test_one_shot_strings();
    if (g_failures != 0) {
        std::fprintf(stderr, "%d check(s) failed\n", g_failures);
        return EXIT_FAILURE;
    }
    std::puts("all external sort tests passed");
    return EXIT_SUCCESS;
}
