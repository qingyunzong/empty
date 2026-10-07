#include "solver.hpp"

#include <cstdint>
#include <functional>
#include <limits>
#include <queue>

namespace patrol {

namespace {

constexpr long long kInf = std::numeric_limits<long long>::max() / 4;

std::vector<std::vector<int>> build_adjacency(const Instance& inst) {
    std::vector<std::vector<int>> adj(inst.n);
    for (int i = 0; i < static_cast<int>(inst.edges.size()); ++i)
        adj[inst.edges[i].from].push_back(i);
    return adj;
}

std::vector<int> required_bits(const Instance& inst) {
    std::vector<int> bit(inst.edges.size(), -1);
    int next = 0;
    for (int i = 0; i < static_cast<int>(inst.edges.size()); ++i)
        if (inst.edges[i].required)
            bit[i] = next++;
    return bit;
}

int required_count(const Instance& inst) {
    int r = 0;
    for (const auto& e : inst.edges)
        r += e.required ? 1 : 0;
    return r;
}

} // namespace

std::vector<std::string> find_reachability_problems(const Instance& inst) {
    const int n = inst.n;
    std::vector<std::vector<int>> adj(n), radj(n);
    for (const auto& e : inst.edges) {
        adj[e.from].push_back(e.to);
        radj[e.to].push_back(e.from);
    }
    auto bfs = [&](const std::vector<std::vector<int>>& g, int src) {
        std::vector<char> vis(n, 0);
        std::queue<int> q;
        vis[src] = 1;
        q.push(src);
        while (!q.empty()) {
            int v = q.front();
            q.pop();
            for (int to : g[v])
                if (!vis[to]) {
                    vis[to] = 1;
                    q.push(to);
                }
        }
        return vis;
    };
    const auto from_start = bfs(adj, inst.start);
    const auto can_reach_start = bfs(radj, inst.start);

    std::vector<std::string> problems;
    for (int i = 0; i < static_cast<int>(inst.edges.size()); ++i) {
        const auto& e = inst.edges[i];
        if (!e.required)
            continue;
        if (!from_start[e.from])
            problems.push_back("edge " + std::to_string(i + 1) + " (" +
                               std::to_string(e.from + 1) + "->" +
                               std::to_string(e.to + 1) +
                               "): tail vertex not reachable from start");
        else if (!can_reach_start[e.to])
            problems.push_back("edge " + std::to_string(i + 1) + " (" +
                               std::to_string(e.from + 1) + "->" +
                               std::to_string(e.to + 1) +
                               "): cannot return from head vertex to start");
    }
    return problems;
}

SolveResult solve(const Instance& inst) {
    SolveResult res;
    res.coverage.assign(inst.edges.size(), 0);

    res.problems = find_reachability_problems(inst);
    if (!res.problems.empty())
        return res;

    const int n = inst.n;
    const int r = required_count(inst);
    const auto bit = required_bits(inst);
    const auto adj = build_adjacency(inst);
    const uint32_t full = (uint32_t{1} << r) - 1;
    const size_t states = static_cast<size_t>(n) << r;

    std::vector<long long> dist(states, kInf);
    std::vector<int64_t> prev_state(states, -1);
    std::vector<int> prev_edge(states, -1);

    auto state_id = [n](int v, uint32_t mask) {
        return size_t(mask) * size_t(n) + size_t(v);
    };

    using Item = std::pair<long long, size_t>;
    std::priority_queue<Item, std::vector<Item>, std::greater<>> pq;
    dist[state_id(inst.start, 0)] = 0;
    pq.emplace(0, state_id(inst.start, 0));

    while (!pq.empty()) {
        auto [d, sid] = pq.top();
        pq.pop();
        if (d != dist[sid])
            continue;
        const int v = static_cast<int>(sid % size_t(n));
        const uint32_t mask = static_cast<uint32_t>(sid / size_t(n));
        for (int ei : adj[v]) {
            const Edge& e = inst.edges[ei];
            uint32_t nmask = mask;
            if (bit[ei] >= 0)
                nmask |= uint32_t{1} << bit[ei];
            const size_t nsid = state_id(e.to, nmask);
            const long long nd = d + e.cost;
            if (nd < dist[nsid]) {
                dist[nsid] = nd;
                prev_state[nsid] = static_cast<int64_t>(sid);
                prev_edge[nsid] = ei;
                pq.emplace(nd, nsid);
            }
        }
    }

    const size_t goal = state_id(inst.start, full);
    // Feasibility was pre-checked, so the goal is always reachable; guard anyway.
    if (dist[goal] >= kInf) {
        res.problems.push_back("no closed walk covers all required edges");
        return res;
    }

    res.feasible = true;
    res.cost = dist[goal];

    std::vector<int> path;
    for (size_t cur = goal; prev_state[cur] >= 0;) {
        path.push_back(prev_edge[cur]);
        cur = static_cast<size_t>(prev_state[cur]);
    }
    res.path_edges.assign(path.rbegin(), path.rend());
    for (int ei : res.path_edges)
        if (inst.edges[ei].required)
            res.coverage[ei] += 1;
    return res;
}

long long reference_cost(const Instance& inst) {
    if (!find_reachability_problems(inst).empty())
        return -1;

    const int n = inst.n;
    const int r = required_count(inst);
    const auto bit = required_bits(inst);
    const auto adj = build_adjacency(inst);
    const uint32_t full = (uint32_t{1} << r) - 1;
    const size_t states = static_cast<size_t>(n) << r;

    std::vector<long long> dist(states, kInf);
    dist[inst.start] = 0; // mask 0, vertex start

    // Fixpoint relaxation (Bellman-Ford style). Costs are non-negative, so it
    // converges within `states` sweeps.
    for (size_t sweep = 0; sweep <= states; ++sweep) {
        bool changed = false;
        for (uint32_t mask = 0; mask <= full; ++mask) {
            for (int v = 0; v < n; ++v) {
                const size_t sid = size_t(mask) * size_t(n) + size_t(v);
                const long long d = dist[sid];
                if (d >= kInf)
                    continue;
                for (int ei : adj[v]) {
                    const Edge& e = inst.edges[ei];
                    uint32_t nmask = mask;
                    if (bit[ei] >= 0)
                        nmask |= uint32_t{1} << bit[ei];
                    const size_t nsid = size_t(nmask) * size_t(n) + size_t(e.to);
                    const long long nd = d + e.cost;
                    if (nd < dist[nsid]) {
                        dist[nsid] = nd;
                        changed = true;
                    }
                }
            }
        }
        if (!changed)
            break;
    }

    const long long ans = dist[size_t(full) * size_t(n) + size_t(inst.start)];
    return ans >= kInf ? -1 : ans;
}

} // namespace patrol
