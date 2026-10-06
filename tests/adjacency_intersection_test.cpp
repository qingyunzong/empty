// Tests for graph::intersect_adjacency, verified against a std::set-based
// reference intersection that is allowed to read whole lists into memory.

#include "graph/adjacency_intersection.hpp"

#include <algorithm>
#include <cstdlib>
#include <iostream>
#include <map>
#include <random>
#include <set>
#include <string>
#include <vector>

namespace {

using graph::AdjacencyEntry;
using graph::IntersectionHit;
using graph::IntersectionErrorCode;
using graph::NodeId;
using graph::SourceId;

int g_failures = 0;

#define CHECK(cond)                                                       \
    do {                                                                  \
        if (!(cond)) {                                                    \
            ++g_failures;                                                 \
            std::cerr << "CHECK failed at " << __FILE__ << ':' << __LINE__ \
                      << ": " #cond << '\n';                              \
        }                                                                 \
    } while (0)

// Cursor replaying an in-memory list; can be armed to fail at a given index.
class VectorCursor final : public graph::AdjacencyCursor {
public:
    explicit VectorCursor(std::vector<AdjacencyEntry> entries,
                          std::size_t fail_at = static_cast<std::size_t>(-1))
        : entries_(std::move(entries)), fail_at_(fail_at) {}

    graph::Expected<std::optional<AdjacencyEntry>, graph::CursorError> next()
        override {
        if (pos_ == fail_at_) {
            return decltype(next())::err(
                graph::CursorError{"injected cursor failure"});
        }
        if (pos_ >= entries_.size()) {
            return decltype(next())::ok(std::nullopt);
        }
        return decltype(next())::ok(entries_[pos_++]);
    }

private:
    std::vector<AdjacencyEntry> entries_;
    std::size_t pos_ = 0;
    std::size_t fail_at_;
};

std::shared_ptr<graph::AdjacencyCursor> make_cursor(
    std::vector<AdjacencyEntry> entries,
    std::size_t fail_at = static_cast<std::size_t>(-1)) {
    return std::make_shared<VectorCursor>(std::move(entries), fail_at);
}

// Reference: full materialization, per-set dedup, then key intersection with
// source union. Ground truth for the streaming implementation.
std::vector<IntersectionHit> reference_intersection(
    const std::vector<std::vector<AdjacencyEntry>>& lists) {
    std::vector<std::map<NodeId, std::set<SourceId>>> per_set(lists.size());
    for (std::size_t i = 0; i < lists.size(); ++i) {
        for (const auto& e : lists[i]) {
            per_set[i][e.node].insert(e.source);
        }
    }
    std::vector<IntersectionHit> out;
    if (lists.empty()) {
        return out;
    }
    for (const auto& [node, sources] : per_set[0]) {
        bool in_all = true;
        for (std::size_t i = 1; i < lists.size() && in_all; ++i) {
            in_all = per_set[i].count(node) != 0;
        }
        if (!in_all) {
            continue;
        }
        std::set<SourceId> merged = sources;
        for (std::size_t i = 1; i < lists.size(); ++i) {
            const auto& s = per_set[i].at(node);
            merged.insert(s.begin(), s.end());
        }
        out.push_back(
            IntersectionHit{node, std::vector<SourceId>(merged.begin(), merged.end())});
    }
    return out;
}

graph::Expected<graph::IntersectionResult, graph::IntersectionError> run(
    const std::vector<std::vector<AdjacencyEntry>>& lists,
    std::size_t max_resident_ids) {
    std::vector<std::shared_ptr<graph::AdjacencyCursor>> cursors;
    for (const auto& l : lists) {
        cursors.push_back(make_cursor(l));
    }
    return graph::intersect_adjacency(cursors,
                                      graph::MemoryBudget{max_resident_ids});
}

int test_basic_intersection() {
    std::vector<std::vector<AdjacencyEntry>> lists = {
        {{1, 10}, {2, 10}, {4, 11}, {7, 10}},
        {{2, 20}, {4, 20}, {4, 21}, {9, 20}},
        {{2, 30}, {4, 30}, {5, 30}},
    };
    auto res = run(lists, 64);
    CHECK(res.has_value());
    if (!res) return g_failures;
    CHECK(res.value().hits == reference_intersection(lists));
    const auto& hits = res.value().hits;
    CHECK(hits.size() == 2);
    CHECK(hits[0].node == 2 && hits[1].node == 4);
    CHECK((hits[0].sources == std::vector<SourceId>{10, 20, 30}));
    CHECK((hits[1].sources == std::vector<SourceId>{11, 20, 21, 30}));
    return g_failures;
}

int test_duplicates_unique_output() {
    std::vector<std::vector<AdjacencyEntry>> lists = {
        {{3, 1}, {3, 1}, {3, 2}, {5, 1}, {5, 1}, {5, 1}},
        {{3, 7}, {3, 7}, {5, 8}, {5, 9}, {5, 9}},
    };
    auto res = run(lists, 64);
    CHECK(res.has_value());
    if (!res) return g_failures;
    CHECK(res.value().hits == reference_intersection(lists));
    const auto& hits = res.value().hits;
    CHECK(hits.size() == 2);
    CHECK((hits[0].sources == std::vector<SourceId>{1, 2, 7}));
    CHECK((hits[1].sources == std::vector<SourceId>{1, 8, 9}));
    return g_failures;
}

int test_cursor_error_publishes_nothing() {
    std::vector<AdjacencyEntry> a{{1, 1}, {2, 1}, {3, 1}, {4, 1}};
    std::vector<AdjacencyEntry> b{{2, 2}, {3, 2}, {4, 2}, {5, 2}};
    // Second cursor fails after yielding 2 entries, mid-intersection.
    std::vector<std::shared_ptr<graph::AdjacencyCursor>> cursors = {
        make_cursor(a), make_cursor(b, /*fail_at=*/2)};

    bool published = false;
    graph::IntersectionResult published_result;
    auto res = graph::intersect_adjacency(cursors, graph::MemoryBudget{64});
    if (res.has_value()) {
        // Publication only ever happens on success.
        published = true;
        published_result = std::move(res).value();
    }
    CHECK(!res.has_value());
    CHECK(res.error().code == IntersectionErrorCode::kCursorFailure);
    CHECK(res.error().cursor_index == 1);
    CHECK(!published);
    CHECK(published_result.hits.empty());
    return g_failures;
}

int test_error_at_first_element() {
    std::vector<std::shared_ptr<graph::AdjacencyCursor>> cursors = {
        make_cursor({{1, 1}}), make_cursor({}, /*fail_at=*/0)};
    auto res = graph::intersect_adjacency(cursors, graph::MemoryBudget{64});
    CHECK(!res.has_value());
    CHECK(res.error().code == IntersectionErrorCode::kCursorFailure);
    return g_failures;
}

int test_budget_exceeded() {
    std::vector<std::vector<AdjacencyEntry>> lists = {
        {{1, 1}, {2, 1}},
        {{1, 2}, {2, 2}},
        {{1, 3}, {2, 3}},
    };
    // 3 cursors need at least 3 resident head slots; allow only 2.
    auto res = run(lists, 2);
    CHECK(!res.has_value());
    CHECK(res.error().code == IntersectionErrorCode::kBudgetExceeded);
    return g_failures;
}

int test_resident_ids_bounded_on_large_input() {
    // Large interleaved lists; intersection must stay within k+1 resident IDs.
    constexpr NodeId n = 200000;
    std::vector<std::vector<AdjacencyEntry>> lists(4);
    for (NodeId i = 0; i < n; ++i) {
        for (std::size_t k = 0; k < lists.size(); ++k) {
            // Each set holds multiples of (k+2), plus duplicates.
            if (i % (k + 2) == 0) {
                lists[k].push_back({i, static_cast<SourceId>(k)});
                lists[k].push_back({i, static_cast<SourceId>(k + 100)});
            }
        }
    }
    const std::size_t k = lists.size();
    auto res = run(lists, k + 1);  // exact minimum budget
    CHECK(res.has_value());
    if (!res) return g_failures;
    CHECK(res.value().peak_resident_ids <= k + 1);
    CHECK(res.value().hits == reference_intersection(lists));
    return g_failures;
}

int test_unsorted_input_detected() {
    std::vector<std::vector<AdjacencyEntry>> lists = {
        {{1, 1}, {5, 1}, {3, 1}},  // 3 < 5: violates ordering
        {{1, 2}, {3, 2}, {5, 2}},
    };
    auto res = run(lists, 64);
    CHECK(!res.has_value());
    CHECK(res.error().code == IntersectionErrorCode::kUnsortedInput);
    return g_failures;
}

int test_empty_and_single_inputs() {
    // Zero cursors: empty intersection, nothing resident.
    {
        auto res = graph::intersect_adjacency({}, graph::MemoryBudget{0});
        CHECK(res.has_value());
        CHECK(res.value().hits.empty());
        CHECK(res.value().peak_resident_ids == 0);
    }
    // One empty list among several: intersection is empty.
    {
        std::vector<std::vector<AdjacencyEntry>> lists = {
            {{1, 1}, {2, 1}}, {}, {{2, 3}}};
        auto res = run(lists, 64);
        CHECK(res.has_value());
        CHECK(res.value().hits.empty());
    }
    // Single set: dedup + source merge.
    {
        std::vector<std::vector<AdjacencyEntry>> lists = {
            {{2, 5}, {2, 6}, {2, 5}, {9, 5}}};
        auto res = run(lists, 64);
        CHECK(res.has_value());
        if (!res) return g_failures;
        CHECK(res.value().hits == reference_intersection(lists));
        const auto& hits = res.value().hits;
        CHECK(hits.size() == 2);
        CHECK((hits[0].sources == std::vector<SourceId>{5, 6}));
    }
    return g_failures;
}

int test_fuzz_against_reference() {
    std::mt19937_64 rng(20261007);
    for (int iter = 0; iter < 300; ++iter) {
        std::uniform_int_distribution<std::size_t> set_count_dist(1, 5);
        std::size_t num_sets = set_count_dist(rng);
        std::vector<std::vector<AdjacencyEntry>> lists(num_sets);
        for (auto& list : lists) {
            std::uniform_int_distribution<std::size_t> len_dist(0, 60);
            std::size_t len = len_dist(rng);
            std::vector<NodeId> nodes;
            nodes.reserve(len);
            std::uniform_int_distribution<NodeId> node_dist(0, 40);
            for (std::size_t j = 0; j < len; ++j) {
                nodes.push_back(node_dist(rng));
            }
            std::sort(nodes.begin(), nodes.end());
            std::uniform_int_distribution<SourceId> src_dist(0, 6);
            for (NodeId node : nodes) {
                list.push_back({node, src_dist(rng)});
            }
        }
        auto res = run(lists, lists.size() + 1);
        CHECK(res.has_value());
        if (!res) return g_failures;
        auto expected = reference_intersection(lists);
        if (res.value().hits != expected) {
            ++g_failures;
            std::cerr << "fuzz mismatch at iteration " << iter << '\n';
            return g_failures;
        }
        // Output must be unique and sorted by node.
        for (std::size_t j = 1; j < res.value().hits.size(); ++j) {
            CHECK(res.value().hits[j - 1].node < res.value().hits[j].node);
        }
    }
    return g_failures;
}

const std::map<std::string, int (*)()> kTests = {
    {"basic_intersection", test_basic_intersection},
    {"duplicates_unique_output", test_duplicates_unique_output},
    {"cursor_error_publishes_nothing", test_cursor_error_publishes_nothing},
    {"error_at_first_element", test_error_at_first_element},
    {"budget_exceeded", test_budget_exceeded},
    {"resident_ids_bounded_on_large_input", test_resident_ids_bounded_on_large_input},
    {"unsorted_input_detected", test_unsorted_input_detected},
    {"empty_and_single_inputs", test_empty_and_single_inputs},
    {"fuzz_against_reference", test_fuzz_against_reference},
};

}  // namespace

int main(int argc, char** argv) {
    if (argc != 2) {
        std::cerr << "usage: " << argv[0] << " <test-name>\n";
        return 2;
    }
    auto it = kTests.find(argv[1]);
    if (it == kTests.end()) {
        std::cerr << "unknown test: " << argv[1] << '\n';
        return 2;
    }
    int failures = it->second();
    if (failures != 0) {
        std::cerr << argv[1] << ": " << failures << " failure(s)\n";
        return 1;
    }
    std::cout << argv[1] << ": OK\n";
    return 0;
}
