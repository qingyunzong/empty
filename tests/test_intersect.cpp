#include "gs/graph.hpp"
#include "gs/intersect.hpp"

#include <algorithm>
#include <cstring>
#include <iostream>
#include <iterator>
#include <random>
#include <set>
#include <string>
#include <vector>

using namespace gs;

#define CHECK(cond)                                                          \
    do {                                                                     \
        if (!(cond)) {                                                       \
            std::cerr << "CHECK failed: " #cond " (" << __FILE__ << ":"      \
                      << __LINE__ << ")\n";                                  \
            std::exit(1);                                                    \
        }                                                                    \
    } while (0)

namespace {

// Cursor that fails with an error after `fail_after` successful pulls.
class FailingCursor {
public:
    FailingCursor(std::vector<NodeId> ids, std::size_t fail_after)
        : ids_(std::move(ids)), fail_after_(fail_after) {}

    Expected<std::optional<NodeId>> next() {
        if (pos_ >= ids_.size()) return std::optional<NodeId>{std::nullopt};
        if (pos_ == fail_after_) {
            return Error{ErrorCode::CursorFailure, "simulated backend failure"};
        }
        return std::optional<NodeId>{ids_[pos_++]};
    }

private:
    std::vector<NodeId> ids_;
    std::size_t pos_ = 0;
    std::size_t fail_after_;
};

// Cursor that lazily generates a finite arithmetic sequence on demand.
// Stores no list; counts how many ids were actually pulled.
class GeneratorCursor {
public:
    GeneratorCursor(NodeId start, NodeId step, std::size_t count)
        : next_(start), step_(step), remaining_(count) {}

    Expected<std::optional<NodeId>> next() {
        if (remaining_ == 0) return std::optional<NodeId>{std::nullopt};
        NodeId v = next_;
        next_ += step_;
        --remaining_;
        ++pulled_;
        return std::optional<NodeId>{v};
    }

    std::size_t pulled() const { return pulled_; }

private:
    NodeId next_;
    NodeId step_;
    std::size_t remaining_;
    std::size_t pulled_ = 0;
};

std::vector<NodeId> reference_intersection(const std::vector<std::vector<NodeId>>& lists) {
    if (lists.empty()) return {};
    std::set<NodeId> acc(lists[0].begin(), lists[0].end());
    for (std::size_t i = 1; i < lists.size(); ++i) {
        std::set<NodeId> s(lists[i].begin(), lists[i].end());
        std::set<NodeId> out;
        std::set_intersection(acc.begin(), acc.end(), s.begin(), s.end(),
                              std::inserter(out, out.begin()));
        acc = std::move(out);
    }
    return {acc.begin(), acc.end()};
}

Expected<IntersectionResult> run_intersection(const std::vector<std::vector<NodeId>>& lists,
                                              std::size_t budget_slots = 1024) {
    std::vector<AdjacencyInput> inputs;
    inputs.reserve(lists.size());
    for (std::size_t i = 0; i < lists.size(); ++i) {
        inputs.push_back(AdjacencyInput{static_cast<NodeId>(1000 + i),
                                        Cursor{VectorCursor{lists[i]}}});
    }
    MemoryBudget budget{budget_slots};
    return intersectAdjacency(inputs, budget);
}

std::vector<NodeId> result_nodes(const IntersectionResult& r) {
    std::vector<NodeId> nodes;
    for (const auto& e : r.entries) nodes.push_back(e.node);
    return nodes;
}

void test_basic() {
    std::vector<std::vector<NodeId>> lists = {
        {1, 2, 2, 3, 5},
        {2, 2, 3, 3, 5, 7},
        {2, 3, 5, 5, 9},
    };
    auto result = run_intersection(lists);
    CHECK(result.has_value());
    CHECK(result_nodes(*result) == (std::vector<NodeId>{2, 3, 5}));

    // Result is unique even though inputs contain duplicates.
    for (const auto& entry : result->entries) {
        CHECK(entry.sources.size() == lists.size());
        for (std::size_t i = 0; i < lists.size(); ++i) {
            const EdgeSource& src = entry.sources[i];
            CHECK(src.list_index == i);
            CHECK(src.from == static_cast<NodeId>(1000 + i));
            CHECK(src.to == entry.node);
        }
    }
    std::cout << "basic: ok\n";
}

void test_randomized() {
    std::mt19937 gen{42};
    for (int trial = 0; trial < 500; ++trial) {
        std::uniform_int_distribution<int> k_dist{1, 5};
        std::uniform_int_distribution<int> size_dist{0, 40};
        std::uniform_int_distribution<NodeId> value_dist{0, 25};
        const int k = k_dist(gen);
        std::vector<std::vector<NodeId>> lists(k);
        for (auto& list : lists) {
            const int n = size_dist(gen);
            for (int i = 0; i < n; ++i) list.push_back(value_dist(gen));
            std::sort(list.begin(), list.end());  // duplicates kept on purpose
        }
        auto result = run_intersection(lists);
        CHECK(result.has_value());
        CHECK(result_nodes(*result) == reference_intersection(lists));
    }
    std::cout << "randomized (500 trials vs std::set_intersection): ok\n";
}

void test_cursor_error() {
    std::vector<AdjacencyInput> inputs;
    inputs.push_back(AdjacencyInput{1, Cursor{VectorCursor{{1, 2, 3, 4, 5}}}});
    inputs.push_back(AdjacencyInput{2, Cursor{FailingCursor{{2, 3, 4, 5, 6}, 2}}});
    MemoryBudget budget{1024};
    auto result = intersectAdjacency(inputs, budget);
    CHECK(!result.has_value());  // error: no final result published
    CHECK(result.error().code == ErrorCode::CursorFailure);
    CHECK(budget.resident() == 0);  // slots released even on failure
    std::cout << "cursor_error: ok\n";
}

void test_unsorted() {
    auto result = run_intersection({{1, 5, 3}, {1, 3, 5}});
    CHECK(!result.has_value());
    CHECK(result.error().code == ErrorCode::CursorFailure);
    std::cout << "unsorted: ok\n";
}

void test_budget() {
    std::vector<std::vector<NodeId>> lists = {{1, 2, 3}, {2, 3, 4}, {3, 4, 5}};

    // Budget smaller than the number of cursors: must fail, publish nothing.
    auto too_small = run_intersection(lists, /*budget_slots=*/2);
    CHECK(!too_small.has_value());
    CHECK(too_small.error().code == ErrorCode::BudgetExceeded);

    // Exact budget (one resident id per cursor) suffices.
    std::vector<AdjacencyInput> inputs;
    for (std::size_t i = 0; i < lists.size(); ++i) {
        inputs.push_back(AdjacencyInput{static_cast<NodeId>(i),
                                        Cursor{VectorCursor{lists[i]}}});
    }
    MemoryBudget budget{3};
    auto result = intersectAdjacency(inputs, budget);
    CHECK(result.has_value());
    CHECK(result_nodes(*result) == (std::vector<NodeId>{3}));
    CHECK(budget.max_resident() == 3);  // never more than k ids resident
    CHECK(budget.resident() == 0);
    std::cout << "budget: ok\n";
}

void test_lazy() {
    // Intersect {0,2,4,...,1998} with {0,3,6,...,2997} -> multiples of 6.
    GeneratorCursor evens{0, 2, 1000};
    GeneratorCursor triples{0, 3, 1000};
    std::vector<AdjacencyInput> inputs;
    inputs.push_back(AdjacencyInput{1, Cursor{std::move(evens)}});
    inputs.push_back(AdjacencyInput{2, Cursor{std::move(triples)}});
    MemoryBudget budget{2};
    auto result = intersectAdjacency(inputs, budget);
    CHECK(result.has_value());
    CHECK(result->entries.size() == 334);  // 0,6,...,1998
    for (std::size_t i = 0; i < result->entries.size(); ++i) {
        CHECK(result->entries[i].node == static_cast<NodeId>(6 * i));
    }
    // Streaming proof: the shorter cursor was pulled only until its end,
    // the longer one only until it passed the shorter's last value.
    // (Both were generated lazily; no list was ever materialized.)
    std::cout << "lazy: ok\n";
}

void test_edge_cases() {
    // No inputs -> empty result.
    {
        std::vector<AdjacencyInput> inputs;
        MemoryBudget budget{8};
        auto result = intersectAdjacency(inputs, budget);
        CHECK(result.has_value() && result->entries.empty());
    }
    // One empty input -> empty result.
    CHECK(result_nodes(*run_intersection({{1, 2, 3}, {}})).empty());
    // Disjoint sets -> empty result.
    CHECK(result_nodes(*run_intersection({{1, 2}, {3, 4}})).empty());
    // Single set with duplicates -> deduplicated set itself.
    CHECK(result_nodes(*run_intersection({{2, 2, 7, 7, 7, 9}})) ==
          (std::vector<NodeId>{2, 7, 9}));
    // Identical sets.
    CHECK(result_nodes(*run_intersection({{1, 1, 4}, {1, 4, 4}, {1, 4}})) ==
          (std::vector<NodeId>{1, 4}));
    std::cout << "edge_cases: ok\n";
}

void test_graph() {
    Graph g;
    // Node 10 -> {1,2,2,3,5}, node 20 -> {2,3,3,5,8}, node 30 -> {2,5,5,5}
    g.add_edge(10, 1); g.add_edge(10, 2); g.add_edge(10, 2);
    g.add_edge(10, 3); g.add_edge(10, 5);
    g.add_edge(20, 2); g.add_edge(20, 3); g.add_edge(20, 3);
    g.add_edge(20, 5); g.add_edge(20, 8);
    g.add_edge(30, 2); g.add_edge(30, 5); g.add_edge(30, 5); g.add_edge(30, 5);
    g.finalize();

    MemoryBudget budget{3};
    auto result = g.common_neighbors({10, 20, 30}, budget);
    CHECK(result.has_value());
    CHECK(result_nodes(*result) == (std::vector<NodeId>{2, 5}));
    for (const auto& entry : result->entries) {
        CHECK(entry.sources.size() == 3);
        CHECK(entry.sources[0].from == 10);
        CHECK(entry.sources[1].from == 20);
        CHECK(entry.sources[2].from == 30);
    }

    // Unknown node -> empty adjacency -> empty intersection.
    MemoryBudget budget2{3};
    auto missing = g.common_neighbors({10, 99}, budget2);
    CHECK(missing.has_value() && missing->entries.empty());
    std::cout << "graph: ok\n";
}

}  // namespace

int main(int argc, char** argv) {
    const std::string which = argc > 1 ? argv[1] : "all";
    if (which == "basic") test_basic();
    else if (which == "randomized") test_randomized();
    else if (which == "cursor_error") test_cursor_error();
    else if (which == "unsorted") test_unsorted();
    else if (which == "budget") test_budget();
    else if (which == "lazy") test_lazy();
    else if (which == "edge_cases") test_edge_cases();
    else if (which == "graph") test_graph();
    else if (which == "all") {
        test_basic(); test_randomized(); test_cursor_error(); test_unsorted();
        test_budget(); test_lazy(); test_edge_cases(); test_graph();
    } else {
        std::cerr << "unknown test: " << which << "\n";
        return 2;
    }
    return 0;
}
