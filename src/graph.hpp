#pragma once

#include <istream>
#include <vector>

namespace cfg {

struct Graph {
    int entry = 0;
    std::vector<std::vector<int>> succ;
    std::vector<std::vector<int>> pred;

    int addNode();
    int size() const { return static_cast<int>(succ.size()); }
    void addEdge(int u, int v);
    void removeEdge(int u, int v);
    int edgeCount() const;
    bool operator==(const Graph&) const = default;
};

// Text format, one directive per line ('#' starts a comment):
//   entry N
//   edge U V
// Nodes are auto-created; entry defaults to 0.
Graph loadGraph(std::istream& in);

} // namespace cfg
