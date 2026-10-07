#include "solver.hpp"

#include <cstdlib>
#include <iostream>
#include <random>
#include <string>
#include <vector>

namespace {

int failures = 0;

#define CHECK(cond)                                                            \
    do {                                                                       \
        if (!(cond)) {                                                         \
            std::cerr << "FAIL " << __FILE__ << ":" << __LINE__ << "  "        \
                      << #cond << "\n";                                        \
            ++failures;                                                        \
        }                                                                      \
    } while (0)

using patrol::Edge;
using patrol::Instance;

// Simulates the returned tour and validates it end to end.
void check_tour(const Instance& inst, const patrol::SolveResult& res) {
    CHECK(res.feasible);
    int cur = inst.start;
    long long total = 0;
    std::vector<int> cov(inst.edges.size(), 0);
    for (int ei : res.path_edges) {
        CHECK(ei >= 0 && ei < static_cast<int>(inst.edges.size()));
        const Edge& e = inst.edges[ei];
        CHECK(e.from == cur);
        total += e.cost;
        cur = e.to;
        cov[ei] += 1;
    }
    CHECK(cur == inst.start);
    CHECK(total == res.cost);
    for (size_t i = 0; i < inst.edges.size(); ++i) {
        if (inst.edges[i].required) {
            CHECK(cov[i] >= 1);               // every required edge covered
            CHECK(res.coverage[i] == cov[i]); // reported counts are exact
        }
    }
}

void test_single_required_edge() {
    Instance inst;
    inst.n = 2;
    inst.start = 0;
    inst.edges = {{0, 1, 5, true}, {1, 0, 2, false}};
    const auto res = patrol::solve(inst);
    CHECK(res.feasible);
    CHECK(res.cost == 7);
    CHECK(res.path_edges.size() == 2);
    CHECK(res.coverage[0] == 1);
    check_tour(inst, res);
    CHECK(patrol::reference_cost(inst) == 7);
}

void test_unreachable_tail() {
    Instance inst;
    inst.n = 3;
    inst.start = 0;
    inst.edges = {{1, 2, 1, true}, {2, 1, 1, false}};
    const auto res = patrol::solve(inst);
    CHECK(!res.feasible);
    CHECK(!res.problems.empty());
    CHECK(patrol::reference_cost(inst) == -1);
}

void test_unreachable_return() {
    Instance inst;
    inst.n = 3;
    inst.start = 0;
    inst.edges = {{0, 1, 1, true}, {1, 2, 1, false}}; // 2 is a sink
    const auto res = patrol::solve(inst);
    CHECK(!res.feasible);
    CHECK(!res.problems.empty());
    CHECK(patrol::reference_cost(inst) == -1);
}

void test_forced_repetition() {
    // Required edges force re-traversal of the cheap return edge.
    Instance inst;
    inst.n = 3;
    inst.start = 0;
    inst.edges = {
        {0, 1, 1, true},  // edge 1
        {1, 0, 2, false}, // edge 2
        {0, 2, 1, true},  // edge 3
        {2, 0, 9, false}, // edge 4 (expensive direct return)
        {2, 1, 1, false}, // edge 5
    };
    const auto res = patrol::solve(inst);
    CHECK(res.feasible);
    // Optimal: 0->1 (1), 1->0 (2), 0->2 (1), 2->1 (1), 1->0 (2) = 7.
    CHECK(res.cost == 7);
    check_tour(inst, res);
    CHECK(patrol::reference_cost(inst) == 7);
}

void test_zero_cost_edges() {
    Instance inst;
    inst.n = 3;
    inst.start = 0;
    inst.edges = {{0, 1, 0, false}, {1, 2, 0, true}, {2, 0, 0, false}};
    const auto res = patrol::solve(inst);
    CHECK(res.feasible);
    CHECK(res.cost == 0);
    check_tour(inst, res);
    CHECK(patrol::reference_cost(inst) == 0);
}

void test_no_required_edges() {
    Instance inst;
    inst.n = 2;
    inst.start = 1;
    inst.edges = {{0, 1, 3, false}};
    const auto res = patrol::solve(inst);
    CHECK(res.feasible);
    CHECK(res.cost == 0);
    CHECK(res.path_edges.empty());
    CHECK(patrol::reference_cost(inst) == 0);
}

void test_required_self_loop() {
    Instance inst;
    inst.n = 2;
    inst.start = 0;
    inst.edges = {{0, 0, 4, true}, {0, 1, 1, false}, {1, 0, 1, false}};
    const auto res = patrol::solve(inst);
    CHECK(res.feasible);
    CHECK(res.cost == 4);
    CHECK(res.coverage[0] == 1);
    check_tour(inst, res);
    CHECK(patrol::reference_cost(inst) == 4);
}

void test_detour_cheaper_than_direct() {
    // Covering 0->1 required; returning directly costs 10, detour costs 3.
    Instance inst;
    inst.n = 3;
    inst.start = 0;
    inst.edges = {
        {0, 1, 2, true},
        {1, 0, 10, false},
        {1, 2, 1, false},
        {2, 0, 2, false},
    };
    const auto res = patrol::solve(inst);
    CHECK(res.feasible);
    CHECK(res.cost == 5);
    check_tour(inst, res);
    CHECK(patrol::reference_cost(inst) == 5);
}

void test_random_cross_check() {
    std::mt19937 rng(20261007);
    for (int iter = 0; iter < 800; ++iter) {
        Instance inst;
        inst.n = 2 + static_cast<int>(rng() % 5); // 2..6 vertices
        inst.start = static_cast<int>(rng() % inst.n);
        const int m = 1 + static_cast<int>(rng() % 11); // 1..11 edges
        int required = 0;
        for (int i = 0; i < m; ++i) {
            Edge e;
            e.from = static_cast<int>(rng() % inst.n);
            e.to = static_cast<int>(rng() % inst.n);
            e.cost = static_cast<long long>(rng() % 10);
            e.required = (rng() % 100) < 40 && required < 8;
            required += e.required ? 1 : 0;
            inst.edges.push_back(e);
        }
        const auto res = patrol::solve(inst);
        const long long ref = patrol::reference_cost(inst);
        if (!res.feasible) {
            CHECK(ref == -1);
            continue;
        }
        CHECK(ref == res.cost);
        check_tour(inst, res);
    }
}

} // namespace

int main() {
    test_single_required_edge();
    test_unreachable_tail();
    test_unreachable_return();
    test_forced_repetition();
    test_zero_cost_edges();
    test_no_required_edges();
    test_required_self_loop();
    test_detour_cheaper_than_direct();
    test_random_cross_check();

    if (failures == 0) {
        std::cout << "all tests passed\n";
        return 0;
    }
    std::cerr << failures << " check(s) failed\n";
    return 1;
}
