#include "analysis.hpp"

#include <algorithm>
#include <functional>
#include <map>
#include <queue>
#include <stack>
#include <stdexcept>

namespace cfg {

std::vector<bool> reachableMask(const Graph& g) {
    std::vector<bool> seen(g.size(), false);
    std::queue<int> q;
    seen[g.entry] = true;
    q.push(g.entry);
    while (!q.empty()) {
        int v = q.front();
        q.pop();
        for (int t : g.succ[v])
            if (!seen[t]) {
                seen[t] = true;
                q.push(t);
            }
    }
    return seen;
}

std::vector<std::vector<int>> stronglyConnected(const Graph& g) {
    const int n = g.size();
    std::vector<int> index(n, -1), low(n, 0), stk;
    std::vector<bool> onStk(n, false);
    std::vector<std::vector<int>> out;
    int next = 0;
    std::function<void(int)> dfs = [&](int v) {
        index[v] = low[v] = next++;
        stk.push_back(v);
        onStk[v] = true;
        for (int t : g.succ[v]) {
            if (index[t] < 0) {
                dfs(t);
                low[v] = std::min(low[v], low[t]);
            } else if (onStk[t]) {
                low[v] = std::min(low[v], index[t]);
            }
        }
        if (low[v] == index[v]) {
            std::vector<int> scc;
            while (true) {
                int w = stk.back();
                stk.pop_back();
                onStk[w] = false;
                scc.push_back(w);
                if (w == v) break;
            }
            out.push_back(std::move(scc));
        }
    };
    for (int v = 0; v < n; ++v)
        if (index[v] < 0) dfs(v);
    return out;
}

std::vector<std::set<int>> dominatorSets(const Graph& g) {
    const int n = g.size();
    std::vector<std::set<int>> dom(n);
    const auto mask = reachableMask(g);
    std::set<int> all;
    for (int v = 0; v < n; ++v)
        if (mask[v]) all.insert(v);
    dom[g.entry] = {g.entry};
    for (int v = 0; v < n; ++v)
        if (mask[v] && v != g.entry) dom[v] = all;
    bool changed = true;
    while (changed) {
        changed = false;
        for (int v = 0; v < n; ++v) {
            if (!mask[v] || v == g.entry) continue;
            std::set<int> nd;
            bool first = true;
            for (int p : g.pred[v]) {
                if (!mask[p]) continue;
                if (first) {
                    nd = dom[p];
                    first = false;
                } else {
                    std::set<int> inter;
                    std::set_intersection(nd.begin(), nd.end(), dom[p].begin(), dom[p].end(),
                                          std::inserter(inter, inter.begin()));
                    nd = std::move(inter);
                }
            }
            nd.insert(v);
            if (nd != dom[v]) {
                dom[v] = std::move(nd);
                changed = true;
            }
        }
    }
    return dom;
}

std::vector<BackEdge> backEdges(const Graph& g, const std::vector<std::set<int>>& dom) {
    std::vector<BackEdge> out;
    for (int u = 0; u < g.size(); ++u) {
        if (dom[u].empty()) continue;
        for (int v : g.succ[u])
            if (!dom[v].empty() && dom[u].count(v)) out.push_back({u, v});
    }
    return out;
}

static bool properSubset(const std::set<int>& a, const std::set<int>& b) {
    return a.size() < b.size() && std::includes(b.begin(), b.end(), a.begin(), a.end());
}

std::vector<NaturalLoop> naturalLoops(const Graph& g, const std::vector<std::set<int>>& dom) {
    std::map<int, std::vector<int>> byHeader;
    for (const auto& be : backEdges(g, dom)) byHeader[be.to].push_back(be.from);

    std::vector<NaturalLoop> loops;
    for (auto& [header, latches] : byHeader) {
        NaturalLoop loop;
        loop.header = header;
        loop.latches = latches;
        loop.body.insert(header);
        std::stack<int> work;
        for (int l : latches) work.push(l);
        while (!work.empty()) {
            int x = work.top();
            work.pop();
            if (!loop.body.insert(x).second) continue;
            for (int p : g.pred[x])
                if (!dom[p].empty()) work.push(p);
        }
        loops.push_back(std::move(loop));
    }
    for (int i = 0; i < (int)loops.size(); ++i)
        for (int j = 0; j < (int)loops.size(); ++j) {
            if (i == j || !properSubset(loops[i].body, loops[j].body)) continue;
            if (loops[i].parent < 0 || loops[j].body.size() < loops[loops[i].parent].body.size())
                loops[i].parent = j;
        }
    return loops;
}

std::vector<IrreducibleLoop> irreducibleLoops(const Graph& g, const std::vector<std::set<int>>& dom) {
    std::vector<IrreducibleLoop> out;
    for (const auto& scc : stronglyConnected(g)) {
        std::set<int> nodes(scc.begin(), scc.end());
        bool cyclic = scc.size() > 1;
        if (scc.size() == 1) {
            int v = scc[0];
            cyclic = std::find(g.succ[v].begin(), g.succ[v].end(), v) != g.succ[v].end();
        }
        if (!cyclic || dom[scc[0]].empty()) continue;
        std::set<int> entries;
        for (int v : scc) {
            if (v == g.entry) entries.insert(v);
            for (int p : g.pred[v])
                if (!nodes.count(p)) entries.insert(v);
        }
        if (entries.size() > 1) out.push_back({std::move(nodes), std::move(entries)});
    }
    return out;
}

Graph splitCopy(const Graph& g) {
    Graph out = g; // work on a copy; the input graph stays untouched
    for (int iter = 0; iter < 64; ++iter) {
        const auto dom = dominatorSets(out);
        const auto irr = irreducibleLoops(out, dom);
        if (irr.empty()) return out;
        const auto& loop = irr.front();
        std::vector<int> entries(loop.entries.begin(), loop.entries.end());
        // Keep the graph entry (if it is one) as the primary entry.
        auto it = std::find(entries.begin(), entries.end(), out.entry);
        if (it != entries.end()) std::swap(*it, entries.front());
        for (size_t k = 1; k < entries.size(); ++k) {
            const int e = entries[k];
            std::map<int, int> copyOf;
            for (int s : loop.nodes) copyOf[s] = out.addNode();
            for (int s : loop.nodes)
                for (int t : out.succ[s]) {
                    if (loop.nodes.count(t))
                        out.addEdge(copyOf[s], copyOf[t]);
                    else
                        out.addEdge(copyOf[s], t);
                }
            std::vector<int> extPreds;
            for (int p : out.pred[e])
                if (!loop.nodes.count(p)) extPreds.push_back(p);
            for (int p : extPreds) {
                out.removeEdge(p, e);
                out.addEdge(p, copyOf[e]);
            }
        }
    }
    throw std::runtime_error("node splitting did not converge");
}

static bool reachableAvoiding(const Graph& g, int banned, int target) {
    if (banned == g.entry) return false;
    std::vector<bool> seen(g.size(), false);
    std::queue<int> q;
    seen[g.entry] = true;
    q.push(g.entry);
    while (!q.empty()) {
        int v = q.front();
        q.pop();
        if (v == target) return true;
        for (int t : g.succ[v])
            if (t != banned && !seen[t]) {
                seen[t] = true;
                q.push(t);
            }
    }
    return false;
}

bool verifyDominatorsByRemoval(const Graph& g, const std::vector<std::set<int>>& dom) {
    const auto mask = reachableMask(g);
    for (int v = 0; v < g.size(); ++v) {
        if (!mask[v]) {
            if (!dom[v].empty()) return false;
            continue;
        }
        std::set<int> ref;
        for (int d = 0; d < g.size(); ++d) {
            if (d == v)
                ref.insert(d);
            else if (mask[d] && !reachableAvoiding(g, d, v))
                ref.insert(d);
        }
        if (ref != dom[v]) return false;
    }
    return true;
}

} // namespace cfg
