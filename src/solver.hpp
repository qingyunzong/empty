#pragma once
// Exact two-terminal (source-to-target) reachability probability for directed
// graphs with independent edge probabilities, via factoring (pivoting) on edge
// variables with memoization. The recursion DAG *is* the decision diagram.
//
// For a directed graph, conditioning on "edge e works" must NOT contract e
// (contraction would add a spurious v->u connection). Instead the edge becomes
// certainly-present; the recursion still terminates because every branch
// decides one more edge. Cycles are handled naturally.
//
// Budget: at most `budget` internal decision nodes are expanded. When the
// budget is exhausted, unresolved subproblems are assigned the interval
// [0, 1]; intervals propagate upward through nonnegative weights, yielding
// sound lower/upper bounds. No Monte Carlo anywhere.

#include "model.hpp"
#include <cstdint>
#include <functional>
#include <limits>
#include <queue>
#include <sstream>
#include <unordered_map>
#include <vector>

class Solver {
public:
    struct Node {
        uint64_t up = 0, down = 0;  // canonical decided-edge masks
        int edge = -1;              // branch edge (-1 for terminals)
        int hi = -1, lo = -1;       // child node ids (hi = edge works)
        Rational loVal, hiVal;      // sound bounds; equal => exact
        bool terminal = false;
    };

    static constexpr int NODE_ZERO = 0;
    static constexpr int NODE_ONE = 1;
    static constexpr int NODE_UNKNOWN = 2;  // budget-exhausted placeholder

    explicit Solver(const Graph& g,
                    uint64_t budget = std::numeric_limits<uint64_t>::max())
        : g_(g), budget_(budget) {
        Node z;
        z.terminal = true;
        z.loVal = z.hiVal = Rational(0);
        nodes_.push_back(z);
        Node o;
        o.terminal = true;
        o.loVal = o.hiVal = Rational(1);
        nodes_.push_back(o);
        Node u;
        u.terminal = true;
        u.loVal = Rational(0);
        u.hiVal = Rational(1);
        nodes_.push_back(u);
    }

    int solve() { return solveState(0, 0); }

    const std::vector<Node>& nodes() const { return nodes_; }
    bool aborted() const { return aborted_; }
    uint64_t internalCount() const { return internalCount_; }

    // Graphviz DOT rendering of the decision diagram.
    std::string toDot() const {
        std::ostringstream os;
        os << "digraph dd {\n  rankdir=TB;\n";
        for (size_t i = 0; i < nodes_.size(); ++i) {
            const Node& nd = nodes_[i];
            if (nd.terminal) {
                const char* label = i == NODE_ZERO ? "0" : (i == NODE_ONE ? "1" : "?");
                os << "  n" << i << " [shape=box,label=\"" << label << "\"";
                if (i == NODE_UNKNOWN) os << ",style=dashed";
                os << "];\n";
            } else {
                const Edge& e = g_.edges[nd.edge];
                os << "  n" << i << " [shape=ellipse,label=\"e" << nd.edge << ": "
                   << e.u << "->" << e.v << "\\n";
                if (nd.loVal == nd.hiVal)
                    os << nd.loVal.str();
                else
                    os << "[" << nd.loVal.str() << ", " << nd.hiVal.str() << "]";
                os << "\"];\n";
                os << "  n" << i << " -> n" << nd.hi << " [label=\""
                   << e.p.str() << "\"];\n";
                Rational q = Rational(1) - e.p;
                os << "  n" << i << " -> n" << nd.lo << " [label=\"" << q.str()
                   << "\",style=dashed];\n";
            }
        }
        os << "}\n";
        return os.str();
    }

private:
    struct Key {
        uint64_t up, down;
        bool operator==(const Key& o) const { return up == o.up && down == o.down; }
    };
    struct KeyHash {
        size_t operator()(const Key& k) const {
            uint64_t h = k.up * 0x9E3779B97F4A7C15ull;
            h ^= k.down + 0x9E3779B97F4A7C15ull + (h << 6) + (h >> 2);
            return static_cast<size_t>(h);
        }
    };

    const Graph& g_;
    uint64_t budget_;
    bool aborted_ = false;
    uint64_t internalCount_ = 0;
    std::vector<Node> nodes_;
    std::unordered_map<Key, int, KeyHash> memo_;

    // BFS over edges selected by `usable`; returns visited flags.
    std::vector<char> bfs(int start, bool reverse,
                          const std::function<bool(int)>& usable) const {
        std::vector<char> vis(g_.n, 0);
        std::queue<int> q;
        vis[start] = 1;
        q.push(start);
        while (!q.empty()) {
            int x = q.front();
            q.pop();
            for (size_t i = 0; i < g_.edges.size(); ++i) {
                if (!usable(static_cast<int>(i))) continue;
                int a = reverse ? g_.edges[i].v : g_.edges[i].u;
                int b = reverse ? g_.edges[i].u : g_.edges[i].v;
                if (a == x && !vis[b]) {
                    vis[b] = 1;
                    q.push(b);
                }
            }
        }
        return vis;
    }

    int solveState(uint64_t up, uint64_t down) {
        size_t m = g_.edges.size();
        auto notDown = [&](int i) { return !((down >> i) & 1ull); };
        auto isUp = [&](int i) { return (up >> i) & 1ull; };

        std::vector<char> fwd = bfs(g_.s, false, notDown);
        if (!fwd[g_.t]) return NODE_ZERO;
        std::vector<char> fwdUp = bfs(g_.s, false, isUp);
        if (fwdUp[g_.t]) return NODE_ONE;

        // canonicalize: edges that cannot lie on any s-t path (given decided
        // edges) are irrelevant; force them "down" in the state key.
        std::vector<char> bwd = bfs(g_.t, true, notDown);
        for (size_t i = 0; i < m; ++i) {
            if (!((down >> i) & 1ull) &&
                !(fwd[g_.edges[i].u] && bwd[g_.edges[i].v])) {
                up &= ~(1ull << i);
                down |= (1ull << i);
            }
        }

        Key key{up, down};
        auto it = memo_.find(key);
        if (it != memo_.end()) return it->second;

        if (internalCount_ >= budget_) {
            aborted_ = true;
            return NODE_UNKNOWN;
        }

        // branch edge: first undecided edge on a shortest s-t path
        int e = pickBranchEdge(up, down, fwd);

        int id = static_cast<int>(nodes_.size());
        nodes_.push_back(Node{});
        ++internalCount_;
        memo_.emplace(key, id);

        int hi = solveState(up | (1ull << e), down);
        int lo = solveState(up, down | (1ull << e));

        const Rational& p = g_.edges[e].p;
        Rational q = Rational(1) - p;
        Node& nd = nodes_[id];
        nd.up = up;
        nd.down = down;
        nd.edge = e;
        nd.hi = hi;
        nd.lo = lo;
        nd.loVal = p * nodes_[hi].loVal + q * nodes_[lo].loVal;
        nd.hiVal = p * nodes_[hi].hiVal + q * nodes_[lo].hiVal;
        return id;
    }

    int pickBranchEdge(uint64_t up, uint64_t down,
                       const std::vector<char>& fwd) const {
        // BFS tree from s over not-down edges; walk t -> s, take the undecided
        // edge closest to s on that path.
        std::vector<int> parentEdge(g_.n, -1);
        std::queue<int> q;
        q.push(g_.s);
        parentEdge[g_.s] = -2;
        while (!q.empty()) {
            int x = q.front();
            q.pop();
            for (size_t i = 0; i < g_.edges.size(); ++i) {
                if ((down >> i) & 1ull) continue;
                if (g_.edges[i].u == x && parentEdge[g_.edges[i].v] == -1) {
                    parentEdge[g_.edges[i].v] = static_cast<int>(i);
                    q.push(g_.edges[i].v);
                }
            }
        }
        (void)fwd;
        std::vector<int> path;
        for (int v = g_.t; v != g_.s; v = g_.edges[parentEdge[v]].u)
            path.push_back(parentEdge[v]);
        for (auto rit = path.rbegin(); rit != path.rend(); ++rit)
            if (!((up >> *rit) & 1ull)) return *rit;
        // unreachable: a path of only "up" edges would have been terminal-1
        throw std::logic_error("no undecided edge on s-t path");
    }
};
