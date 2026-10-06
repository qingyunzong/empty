#include "compress.hpp"

#include <cstdlib>
#include <iostream>
#include <random>
#include <set>
#include <string>
#include <vector>

namespace {

int failures = 0;

void report(bool ok, const std::string& name, const std::string& detail = "") {
    if (!ok) {
        ++failures;
        std::cerr << "FAIL: " << name;
        if (!detail.empty()) std::cerr << " -- " << detail;
        std::cerr << '\n';
    }
}

std::string join(const std::vector<std::string>& v) {
    std::string out;
    for (const auto& p : v) out += "[" + p + "]";
    return out;
}

// Check solver against brute force for one instance.
void check(const std::string& s, comp::CostModel model, std::size_t max_distinct,
           const std::string& name) {
    comp::Solution fast = comp::solve(s, model, max_distinct);
    comp::Solution slow = comp::solve_brute(s, model, max_distinct);
    report(fast.ok == slow.ok, name, "feasibility mismatch on '" + s + "'");
    if (!fast.ok || !slow.ok) return;
    report(fast.cost == slow.cost, name,
           "cost " + std::to_string(fast.cost) + " != brute " + std::to_string(slow.cost) +
               " on '" + s + "'");
    report(fast.pieces == slow.pieces, name,
           "pieces " + join(fast.pieces) + " != brute " + join(slow.pieces) + " on '" + s + "'");
    // Sanity: pieces concatenate back to s and respect the distinct budget.
    std::string cat;
    for (const auto& p : fast.pieces) cat += p;
    report(cat == s, name, "pieces do not concatenate to input");
    report(std::set<std::string>(fast.pieces.begin(), fast.pieces.end()).size() <= max_distinct,
           name, "distinct budget exceeded");
}

void exhaustive_binary(int max_len, comp::CostModel model, std::size_t max_distinct) {
    for (int len = 0; len <= max_len; ++len) {
        std::size_t total = std::size_t{1} << len;
        for (std::size_t bits = 0; bits < total; ++bits) {
            std::string s;
            for (int i = 0; i < len; ++i) s.push_back((bits >> i) & 1 ? 'b' : 'a');
            check(s, model, max_distinct, "binary exhaustive");
        }
    }
}

void exhaustive_ternary(int max_len, comp::CostModel model, std::size_t max_distinct) {
    for (int len = 0; len <= max_len; ++len) {
        std::size_t total = 1;
        for (int i = 0; i < len; ++i) total *= 3;
        for (std::size_t code = 0; code < total; ++code) {
            std::string s;
            std::size_t x = code;
            for (int i = 0; i < len; ++i) {
                s.push_back(char('a' + x % 3));
                x /= 3;
            }
            check(s, model, max_distinct, "ternary exhaustive");
        }
    }
}

void random_strings(int count, int max_len, int alphabet, unsigned seed) {
    std::mt19937 rng(seed);
    for (int t = 0; t < count; ++t) {
        int len = 1 + (int)(rng() % max_len);
        std::string s;
        for (int i = 0; i < len; ++i) s.push_back(char('a' + rng() % alphabet));
        comp::CostModel model;
        model.dict_per_char = 1 + (long long)(rng() % 3);
        model.ref_per_char = 1 + (long long)(rng() % 3);
        model.dict_flat = (long long)(rng() % 4);
        model.ref_flat = (long long)(rng() % 3);
        std::size_t max_distinct = 1 + rng() % 6;
        check(s, model, max_distinct, "random");
    }
}

void test_known_cases() {
    // "abab": ["ab","ab"] costs dict(2)+ref(4)=6, ["a","b","a","b"] costs 2+4=6.
    // Tie -> lexicographically smaller sequence wins: "a" < "ab".
    comp::Solution sol = comp::solve("abab");
    report(sol.ok && sol.cost == 6, "known abab cost", "cost=" + std::to_string(sol.cost));
    report(sol.pieces == std::vector<std::string>({"a", "b", "a", "b"}),
           "known abab pieces", join(sol.pieces));

    // "aaaa": ["aa","aa"] -> dict 2 + ref 4 = 6 beats ["a","a","a","a"] -> 1+4=5.
    sol = comp::solve("aaaa");
    report(sol.ok && sol.cost == 5, "known aaaa cost", "cost=" + std::to_string(sol.cost));
    report(sol.pieces == std::vector<std::string>({"a", "a", "a", "a"}),
           "known aaaa pieces", join(sol.pieces));

    // Empty string.
    sol = comp::solve("");
    report(sol.ok && sol.cost == 0 && sol.pieces.empty(), "empty string");

    // Flat reference fee makes long fragments attractive: "abcabc" -> ["abc","abc"]
    // costs dict 3 + 2*ref_flat(1) = 5 vs singles 3 + 6 = 9.
    comp::CostModel m;
    m.dict_per_char = 1;
    m.ref_per_char = 0;
    m.ref_flat = 1;
    sol = comp::solve("abcabc", m);
    report(sol.ok && sol.cost == 5 &&
               sol.pieces == std::vector<std::string>({"abc", "abc"}),
           "flat ref model", "cost=" + std::to_string(sol.cost) + " " + join(sol.pieces));

    // Distinct budget forces merging: 6 distinct chars, budget 2.
    sol = comp::solve("abcdef", {}, 2);
    report(sol.ok && sol.cost == 12 &&
               sol.pieces == std::vector<std::string>({"a", "bcdef"}),
           "budget merge", "cost=" + std::to_string(sol.cost) + " " + join(sol.pieces));

    // Budget 1: whole string is the only option.
    sol = comp::solve("abcdef", {}, 1);
    report(sol.ok && sol.pieces == std::vector<std::string>({"abcdef"}), "budget one");

    // Infeasible: 3 distinct chars, budget 0.
    sol = comp::solve("abc", {}, 0);
    report(!sol.ok, "infeasible budget");
}

void test_length_30() {
    // Worst-case shapes at the n=30 limit; just ensure it terminates sanely.
    std::string same(30, 'a');
    comp::Solution sol = comp::solve(same);
    report(sol.ok && sol.cost == 1 + 30, "30x same char",
           "cost=" + std::to_string(sol.cost));

    std::string ab;
    for (int i = 0; i < 15; ++i) ab += "ab";
    sol = comp::solve(ab);
    report(sol.ok && sol.cost == 2 + 30, "30x alternating",
           "cost=" + std::to_string(sol.cost));

    std::string distinct = "abcdefghijklmnopqrstuvwxyz{|}~"; // 30 distinct chars
    sol = comp::solve(distinct, {}, 18);
    report(sol.ok, "30 distinct chars feasible");
    if (sol.ok) {
        std::set<std::string> d(sol.pieces.begin(), sol.pieces.end());
        report(d.size() <= 18, "30 distinct chars budget");
    }
}

} // namespace

int main() {
    test_known_cases();

    comp::CostModel def;
    exhaustive_binary(10, def, 18);          // 2047 strings, full segmentation check
    exhaustive_binary(8, def, 2);            // tight distinct budget
    exhaustive_ternary(7, def, 18);          // 2187 strings
    exhaustive_ternary(6, def, 3);

    comp::CostModel flats;
    flats.dict_flat = 2;
    flats.ref_flat = 1;
    exhaustive_binary(9, flats, 4);          // non-default cost model

    random_strings(400, 12, 4, 42);
    random_strings(200, 12, 2, 7);

    test_length_30();

    if (failures == 0) {
        std::cout << "all tests passed\n";
        return 0;
    }
    std::cerr << failures << " failure(s)\n";
    return 1;
}
