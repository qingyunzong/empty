#pragma once

#include "gs/intersect.hpp"

#include <algorithm>
#include <unordered_map>
#include <vector>

namespace gs {

// Minimal directed graph whose adjacency lists may contain duplicate
// neighbor ids (e.g. multi-edges). Lists are sorted by finalize().
class Graph {
public:
    void add_edge(NodeId from, NodeId to) { adj_[from].push_back(to); }

    void finalize() {
        for (auto& [node, neighbors] : adj_) {
            std::sort(neighbors.begin(), neighbors.end());
        }
    }

    // Intersect the adjacency sets of `nodes`, streaming from the stored
    // lists via index cursors (no list is copied into the algorithm).
    Expected<IntersectionResult> common_neighbors(const std::vector<NodeId>& nodes,
                                                  MemoryBudget& budget) const {
        std::vector<AdjacencyInput> inputs;
        inputs.reserve(nodes.size());
        for (NodeId node : nodes) {
            auto it = adj_.find(node);
            if (it == adj_.end()) return IntersectionResult{};  // empty adjacency
            inputs.push_back(AdjacencyInput{node, Cursor{SpanCursor{it->second}}});
        }
        return intersectAdjacency(inputs, budget);
    }

private:
    std::unordered_map<NodeId, std::vector<NodeId>> adj_;
};

}  // namespace gs
