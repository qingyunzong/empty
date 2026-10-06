#pragma once

#include "graph.hpp"

#include <set>
#include <vector>

namespace cfg {

// Reachability from g.entry.
std::vector<bool> reachableMask(const Graph& g);

// Tarjan SCCs over all nodes (reachable or not).
std::vector<std::vector<int>> stronglyConnected(const Graph& g);

// Iterative dataflow dominator sets. Unreachable nodes get an empty set,
// so dom[v] non-empty <=> v reachable, and u in dom[v] <=> u dominates v.
std::vector<std::set<int>> dominatorSets(const Graph& g);

struct BackEdge {
    int from;
    int to; // header
};

// Edge u -> v with v dominating u (both reachable).
std::vector<BackEdge> backEdges(const Graph& g, const std::vector<std::set<int>>& dom);

struct NaturalLoop {
    int header = -1;
    std::set<int> body; // includes header
    std::vector<int> latches;
    int parent = -1; // index of smallest strictly containing loop, -1 = top level
};

// One loop per header (multiple back edges into one header merge).
// parent links express nesting by containment.
std::vector<NaturalLoop> naturalLoops(const Graph& g, const std::vector<std::set<int>>& dom);

struct IrreducibleLoop {
    std::set<int> nodes;
    std::set<int> entries;
};

// Cyclic, reachable SCCs with more than one entry node.
std::vector<IrreducibleLoop> irreducibleLoops(const Graph& g, const std::vector<std::set<int>>& dom);

// Node splitting: returns a reducible transformed COPY of g.
// The input graph is never modified.
Graph splitCopy(const Graph& g);

// Reference check for short graphs: recomputes dom[v] by the definition
// "d dominates v iff every entry->v path visits d" via node removal.
bool verifyDominatorsByRemoval(const Graph& g, const std::vector<std::set<int>>& dom);

} // namespace cfg
