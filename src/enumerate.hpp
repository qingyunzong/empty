#pragma once
// Brute-force verification: enumerate all 2^m edge-state subsets and sum the
// exact probability of those where the target is reachable from the source.
// Uses a common denominator so only one final reduction is needed.

#include "model.hpp"
#include <queue>

inline bool reachableInSubset(const Graph& g, uint64_t mask) {
    std::vector<char> vis(g.n, 0);
    std::queue<int> q;
    vis[g.s] = 1;
    q.push(g.s);
    while (!q.empty()) {
        int x = q.front();
        q.pop();
        for (size_t i = 0; i < g.edges.size(); ++i) {
            if (!((mask >> i) & 1ull)) continue;
            if (g.edges[i].u == x && !vis[g.edges[i].v]) {
                vis[g.edges[i].v] = 1;
                q.push(g.edges[i].v);
            }
        }
    }
    return vis[g.t];
}

inline Rational enumerateExact(const Graph& g) {
    size_t m = g.edges.size();
    if (m > 26) throw std::runtime_error("enumeration limited to 26 edges");
    BigUInt D(1);
    std::vector<BigUInt> upNum(m), dnNum(m);
    for (size_t i = 0; i < m; ++i) {
        upNum[i] = g.edges[i].p.num.mag;  // parser guarantees 0 <= p <= 1
        dnNum[i] = g.edges[i].p.den - g.edges[i].p.num.mag;
        D *= g.edges[i].p.den;
    }
    BigUInt total;
    uint64_t subsets = 1ull << m;
    for (uint64_t mask = 0; mask < subsets; ++mask) {
        if (!reachableInSubset(g, mask)) continue;
        BigUInt term(1);
        for (size_t i = 0; i < m; ++i) {
            const BigUInt& f = ((mask >> i) & 1ull) ? upNum[i] : dnNum[i];
            if (f.isZero()) {
                term = BigUInt();
                break;
            }
            term *= f;
        }
        total += term;
    }
    return Rational(BigInt(total), D);
}
