#include "inspector.hpp"

#include <algorithm>
#include <limits>
#include <queue>
#include <stdexcept>
#include <unordered_map>
#include <utility>

namespace inspect {

namespace {

constexpr long long kInf = std::numeric_limits<long long>::max() / 4;
constexpr int kNodeBits = 4; // n <= 10 < 16, vertex occupies low 4 bits of key

// reach[u] = true iff u is reachable from src following edge directions.
std::vector<bool> reachableFrom(const Problem& p, int src, bool reversed) {
  std::vector<std::vector<int>> adj(p.n);
  for (const Edge& e : p.edges) {
    if (reversed)
      adj[e.v].push_back(e.u);
    else
      adj[e.u].push_back(e.v);
  }
  std::vector<bool> seen(p.n, false);
  std::vector<int> stack{src};
  seen[src] = true;
  while (!stack.empty()) {
    int u = stack.back();
    stack.pop_back();
    for (int v : adj[u]) {
      if (!seen[v]) {
        seen[v] = true;
        stack.push_back(v);
      }
    }
  }
  return seen;
}

} // namespace

std::vector<InfeasibleReason> findInfeasibleEdges(const Problem& p) {
  std::vector<bool> fromStart = reachableFrom(p, p.start, false);
  std::vector<bool> toStart = reachableFrom(p, p.start, true);
  std::vector<InfeasibleReason> bad;
  for (int id : p.required) {
    const Edge& e = p.edges[id];
    InfeasibleReason r;
    r.edgeId = id;
    r.tailUnreachable = !fromStart[e.u];
    r.headCannotReturn = !toStart[e.v];
    if (r.tailUnreachable || r.headCannotReturn)
      bad.push_back(r);
  }
  return bad;
}

Solution solve(const Problem& p) {
  const int k = static_cast<int>(p.required.size());
  if (k > kMaxRequired)
    throw std::invalid_argument("too many required edges (max 60)");

  Solution sol;
  sol.infeasible = findInfeasibleEdges(p);
  if (!sol.infeasible.empty())
    return sol;

  std::vector<int> bitOf(p.edges.size(), -1);
  for (int i = 0; i < k; ++i)
    bitOf[p.required[i]] = i;

  const unsigned long long fullMask =
      (k == 64) ? ~0ull : ((1ull << k) - 1ull);
  auto keyOf = [](unsigned long long mask, int node) {
    return (mask << kNodeBits) | static_cast<unsigned long long>(node);
  };

  std::unordered_map<unsigned long long, long long> dist;
  std::unordered_map<unsigned long long,
                     std::pair<unsigned long long, int>>
      parent; // key -> (previous key, edge id used)
  using Item = std::pair<long long, unsigned long long>;
  std::priority_queue<Item, std::vector<Item>, std::greater<Item>> pq;

  const unsigned long long startKey = keyOf(0, p.start);
  const unsigned long long goalKey = keyOf(fullMask, p.start);
  dist[startKey] = 0;
  pq.push({0, startKey});

  bool found = false;
  while (!pq.empty()) {
    auto [d, key] = pq.top();
    pq.pop();
    if (d != dist[key])
      continue; // stale heap entry
    if (key == goalKey) {
      found = true;
      break; // first pop of the goal is optimal (non-negative weights)
    }
    const int u = static_cast<int>(key & 0xf);
    const unsigned long long mask = key >> kNodeBits;
    for (int id = 0; id < static_cast<int>(p.edges.size()); ++id) {
      const Edge& e = p.edges[id];
      if (e.u != u)
        continue;
      unsigned long long nmask = mask;
      if (bitOf[id] >= 0)
        nmask |= (1ull << bitOf[id]);
      const unsigned long long nkey = keyOf(nmask, e.v);
      const long long nd = d + e.w;
      auto it = dist.find(nkey);
      if (it == dist.end() || nd < it->second) {
        dist[nkey] = nd;
        parent[nkey] = {key, id};
        pq.push({nd, nkey});
      }
    }
  }

  if (!found) {
    // Should not happen after the feasibility pre-check; treat defensively.
    for (int id : p.required)
      sol.infeasible.push_back({id, true, true});
    return sol;
  }

  sol.feasible = true;
  sol.cost = dist[goalKey];
  for (unsigned long long key = goalKey; key != startKey;) {
    auto [prev, id] = parent[key];
    sol.edgeSeq.push_back(id);
    key = prev;
  }
  std::reverse(sol.edgeSeq.begin(), sol.edgeSeq.end());

  sol.coverage.assign(k, 0);
  for (int id : sol.edgeSeq)
    if (bitOf[id] >= 0)
      ++sol.coverage[bitOf[id]];
  return sol;
}

long long solveReferenceCost(const Problem& p) {
  const int k = static_cast<int>(p.required.size());
  if (k > 20)
    throw std::invalid_argument("reference solver supports at most 20 required edges");
  if (!findInfeasibleEdges(p).empty())
    return -1;

  // All-pairs shortest paths (Floyd-Warshall).
  std::vector<std::vector<long long>> d(p.n, std::vector<long long>(p.n, kInf));
  for (int i = 0; i < p.n; ++i)
    d[i][i] = 0;
  for (const Edge& e : p.edges)
    d[e.u][e.v] = std::min(d[e.u][e.v], e.w);
  for (int mid = 0; mid < p.n; ++mid)
    for (int i = 0; i < p.n; ++i)
      for (int j = 0; j < p.n; ++j)
        if (d[i][mid] + d[mid][j] < d[i][j])
          d[i][j] = d[i][mid] + d[mid][j];

  // dp[mask][i]: min cost of a walk from start that covers exactly the
  // required edges in mask and ends at head(required[i]), with i in mask.
  const int states = 1 << k;
  std::vector<std::vector<long long>> dp(states, std::vector<long long>(k, kInf));
  for (int i = 0; i < k; ++i) {
    const Edge& e = p.edges[p.required[i]];
    dp[1 << i][i] = d[p.start][e.u] + e.w;
  }
  for (int mask = 1; mask < states; ++mask) {
    for (int i = 0; i < k; ++i) {
      if (!(mask & (1 << i)) || dp[mask][i] >= kInf)
        continue;
      const Edge& ei = p.edges[p.required[i]];
      for (int j = 0; j < k; ++j) {
        if (mask & (1 << j))
          continue;
        const Edge& ej = p.edges[p.required[j]];
        const long long cand = dp[mask][i] + d[ei.v][ej.u] + ej.w;
        dp[mask | (1 << j)][j] = std::min(dp[mask | (1 << j)][j], cand);
      }
    }
  }

  long long best = kInf;
  const int full = states - 1;
  for (int i = 0; i < k; ++i) {
    const Edge& e = p.edges[p.required[i]];
    best = std::min(best, dp[full][i] + d[e.v][p.start]);
  }
  if (k == 0)
    best = 0;
  return best >= kInf ? -1 : best;
}

} // namespace inspect
