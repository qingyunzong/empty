#pragma once

#include <vector>

namespace inspect {

struct Edge {
  int u = 0;
  int v = 0;
  long long w = 0;
};

struct Problem {
  int n = 0;                 // number of vertices, 1..10
  int start = 0;             // fixed start/end vertex
  std::vector<Edge> edges;   // directed edges, non-negative cost
  std::vector<int> required; // edge ids that must be traversed at least once
};

struct InfeasibleReason {
  int edgeId = 0;
  bool tailUnreachable = false; // start cannot reach edges[edgeId].u
  bool headCannotReturn = false; // edges[edgeId].v cannot reach start
};

struct Solution {
  bool feasible = false;
  long long cost = 0;
  std::vector<int> edgeSeq;  // edge ids in traversal order (starts/ends at start)
  std::vector<int> coverage; // coverage[i] = times required[i] appears in edgeSeq
  std::vector<InfeasibleReason> infeasible; // filled when feasible == false
};

// Maximum number of required edges supported by the bitmask solvers.
inline constexpr int kMaxRequired = 60;

// BFS-based feasibility check: a required edge (u,v) is coverable by a closed
// walk from start iff start reaches u and v reaches start.
std::vector<InfeasibleReason> findInfeasibleEdges(const Problem& p);

// Exact solver: Dijkstra over the (vertex, coverage-mask) state graph.
Solution solve(const Problem& p);

// Independent reference solver for verification on small graphs:
// Floyd-Warshall all-pairs shortest paths + DP over required-edge subsets.
// Only the optimal cost is computed (no edge sequence).
// Requires required.size() <= 20; throws std::invalid_argument otherwise.
long long solveReferenceCost(const Problem& p);

} // namespace inspect
