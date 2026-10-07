#pragma once

#include <string>
#include <vector>

namespace patrol {

// Hard limits for the exact state-space solver (state = vertex x 2^R).
inline constexpr int kMaxVertices = 10;
inline constexpr int kMaxRequiredEdges = 20;

struct Edge {
    int from;       // 0-based vertex
    int to;         // 0-based vertex
    long long cost; // non-negative
    bool required;  // must be traversed at least once
};

struct Instance {
    int n = 0;     // vertices are 0..n-1
    int start = 0; // fixed start/end vertex
    std::vector<Edge> edges;
};

struct SolveResult {
    bool feasible = false;
    // Human-readable reasons when infeasible (one per offending required edge).
    std::vector<std::string> problems;
    long long cost = 0;
    // Edge indices (into Instance::edges) in traversal order.
    std::vector<int> path_edges;
    // coverage[i] = number of times edge i is traversed in the tour
    // (only meaningful for required edges; 0 for the rest).
    std::vector<int> coverage;
};

// Exact solver: Dijkstra over the expanded state graph (vertex, covered-mask).
SolveResult solve(const Instance& inst);

// Independent reference: Bellman-Ford style fixpoint relaxation over the same
// state graph. Returns the optimal cost, or -1 when infeasible. Used to
// cross-check solve() on small instances.
long long reference_cost(const Instance& inst);

// Feasibility check shared by both solvers: every required edge's tail must be
// reachable from start, and start must be reachable from its head.
std::vector<std::string> find_reachability_problems(const Instance& inst);

} // namespace patrol
