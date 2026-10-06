#include "inspector.hpp"

#include <cassert>
#include <iostream>
#include <random>
#include <vector>

using inspect::Edge;
using inspect::Problem;
using inspect::Solution;

namespace {

int failures = 0;

#define CHECK(cond)                                                          \
  do {                                                                       \
    if (!(cond)) {                                                           \
      std::cerr << "FAIL " << __FILE__ << ":" << __LINE__ << ": " #cond      \
                << "\n";                                                     \
      ++failures;                                                            \
    }                                                                        \
  } while (0)

// Simulates the returned walk and verifies every structural invariant.
void validateWalk(const Problem& p, const Solution& sol) {
  CHECK(sol.feasible);
  CHECK(sol.coverage.size() == p.required.size());
  int cur = p.start;
  long long cost = 0;
  std::vector<int> actualCoverage(p.required.size(), 0);
  for (int id : sol.edgeSeq) {
    CHECK(id >= 0 && id < static_cast<int>(p.edges.size()));
    const Edge& e = p.edges[id];
    CHECK(e.u == cur); // walk must be contiguous
    cur = e.v;
    cost += e.w;
    for (size_t i = 0; i < p.required.size(); ++i)
      if (p.required[i] == id)
        ++actualCoverage[i];
  }
  CHECK(cur == p.start);          // closed walk
  CHECK(cost == sol.cost);        // reported cost matches the walk
  for (size_t i = 0; i < p.required.size(); ++i) {
    CHECK(actualCoverage[i] >= 1); // every required edge is covered
    CHECK(sol.coverage[i] == actualCoverage[i]); // coverage report is exact
  }
}

void testSimpleLoop() {
  Problem p;
  p.n = 2;
  p.start = 0;
  p.edges = {{0, 1, 2}, {1, 0, 3}};
  p.required = {0};
  Solution sol = inspect::solve(p);
  validateWalk(p, sol);
  CHECK(sol.cost == 5);
  CHECK(sol.edgeSeq == std::vector<int>({0, 1}));
  CHECK(sol.coverage == std::vector<int>({1}));
}

void testUnreachable() {
  Problem p;
  p.n = 3;
  p.start = 0;
  p.edges = {{0, 1, 1}, {1, 2, 1}}; // no way back to 0
  p.required = {1};
  Solution sol = inspect::solve(p);
  CHECK(!sol.feasible);
  CHECK(sol.infeasible.size() == 1);
  CHECK(sol.infeasible[0].edgeId == 1);
  CHECK(!sol.infeasible[0].tailUnreachable);
  CHECK(sol.infeasible[0].headCannotReturn);
  CHECK(inspect::solveReferenceCost(p) == -1);
}

void testTailUnreachable() {
  Problem p;
  p.n = 3;
  p.start = 1;
  p.edges = {{1, 2, 1}, {2, 1, 1}, {0, 1, 1}};
  p.required = {2}; // edge 0->1: start 1 cannot reach vertex 0
  Solution sol = inspect::solve(p);
  CHECK(!sol.feasible);
  CHECK(sol.infeasible.size() == 1);
  CHECK(sol.infeasible[0].tailUnreachable);
}

void testZeroCostEdges() {
  Problem p;
  p.n = 2;
  p.start = 0;
  p.edges = {{0, 1, 0}, {1, 0, 0}};
  p.required = {0, 1};
  Solution sol = inspect::solve(p);
  validateWalk(p, sol);
  CHECK(sol.cost == 0);
}

void testBothParallelRequired() {
  // Two parallel required edges 0->1 force covering each of them.
  Problem p;
  p.n = 2;
  p.start = 0;
  p.edges = {{0, 1, 1}, {0, 1, 2}, {1, 0, 1}};
  p.required = {0, 1};
  Solution sol = inspect::solve(p);
  validateWalk(p, sol);
  CHECK(sol.cost == 1 + 1 + 2 + 1);
  CHECK(sol.coverage == std::vector<int>({1, 1}));
}

void testRequiredEdgeRepeated() {
  // Required edge 0 (0->1, cost 1) is the only cheap way out of 0; the other
  // required edge 2 (1->2) plus return edges force traversing edge 0 twice.
  Problem p;
  p.n = 3;
  p.start = 0;
  p.edges = {{0, 1, 1}, {1, 0, 4}, {1, 2, 1}, {2, 0, 1}};
  p.required = {0, 2};
  Solution sol = inspect::solve(p);
  validateWalk(p, sol);
  // Optimal: 0->1 (e0), 1->2 (e2), 2->0 (e3): cost 3, each required once.
  CHECK(sol.cost == 3);
  CHECK(sol.coverage == std::vector<int>({1, 1}));
}

void testNoRequiredEdges() {
  Problem p;
  p.n = 2;
  p.start = 0;
  p.edges = {{0, 1, 5}, {1, 0, 7}};
  p.required = {};
  Solution sol = inspect::solve(p);
  CHECK(sol.feasible);
  CHECK(sol.cost == 0);
  CHECK(sol.edgeSeq.empty());
  CHECK(inspect::solveReferenceCost(p) == 0);
}

void testSelfLoop() {
  Problem p;
  p.n = 1;
  p.start = 0;
  p.edges = {{0, 0, 9}};
  p.required = {0};
  Solution sol = inspect::solve(p);
  validateWalk(p, sol);
  CHECK(sol.cost == 9);
  CHECK(sol.edgeSeq == std::vector<int>({0}));
}

// Cross-checks the state-space Dijkstra against the independent
// Floyd-Warshall + subset-DP reference on random small graphs.
void testRandomCrossCheck() {
  std::mt19937 rng(20261007);
  for (int trial = 0; trial < 500; ++trial) {
    Problem p;
    p.n = 1 + static_cast<int>(rng() % 6); // 1..6 vertices
    p.start = static_cast<int>(rng() % p.n);
    const int m = static_cast<int>(rng() % 13); // 0..12 edges
    for (int i = 0; i < m; ++i) {
      Edge e;
      e.u = static_cast<int>(rng() % p.n);
      e.v = static_cast<int>(rng() % p.n);
      e.w = static_cast<long long>(rng() % 7); // 0..6, includes zero cost
      p.edges.push_back(e);
    }
    const int kMax = std::min(m, 6);
    const int k = kMax == 0 ? 0 : static_cast<int>(rng() % (kMax + 1));
    std::vector<int> ids(m);
    for (int i = 0; i < m; ++i)
      ids[i] = i;
    for (int i = 0; i < k; ++i) {
      const int j = i + static_cast<int>(rng() % (m - i));
      std::swap(ids[i], ids[j]);
      p.required.push_back(ids[i]);
    }

    Solution sol = inspect::solve(p);
    const long long ref = inspect::solveReferenceCost(p);
    if (!sol.feasible) {
      CHECK(ref == -1);
      CHECK(!sol.infeasible.empty());
      continue;
    }
    CHECK(ref == sol.cost);
    validateWalk(p, sol);
  }
}

} // namespace

int main() {
  testSimpleLoop();
  testUnreachable();
  testTailUnreachable();
  testZeroCostEdges();
  testBothParallelRequired();
  testRequiredEdgeRepeated();
  testNoRequiredEdges();
  testSelfLoop();
  testRandomCrossCheck();
  if (failures == 0) {
    std::cout << "all tests passed\n";
    return 0;
  }
  std::cerr << failures << " check(s) failed\n";
  return 1;
}
