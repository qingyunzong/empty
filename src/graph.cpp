#include "graph.hpp"

#include <algorithm>
#include <sstream>
#include <stdexcept>
#include <string>

namespace cfg {

int Graph::addNode() {
    succ.emplace_back();
    pred.emplace_back();
    return size() - 1;
}

void Graph::addEdge(int u, int v) {
    succ[u].push_back(v);
    pred[v].push_back(u);
}

void Graph::removeEdge(int u, int v) {
    auto eraseFrom = [](std::vector<int>& xs, int x) {
        xs.erase(std::remove(xs.begin(), xs.end(), x), xs.end());
    };
    eraseFrom(succ[u], v);
    eraseFrom(pred[v], u);
}

int Graph::edgeCount() const {
    int n = 0;
    for (const auto& s : succ) n += static_cast<int>(s.size());
    return n;
}

Graph loadGraph(std::istream& in) {
    Graph g;
    std::string line;
    int lineno = 0;
    auto ensure = [&](int v) {
        if (v < 0) throw std::runtime_error("negative node id");
        while (g.size() <= v) g.addNode();
    };
    while (std::getline(in, line)) {
        ++lineno;
        const auto hash = line.find('#');
        if (hash != std::string::npos) line.erase(hash);
        std::istringstream ss(line);
        std::string tok;
        if (!(ss >> tok)) continue;
        const auto fail = [&](const std::string& what) {
            throw std::runtime_error("line " + std::to_string(lineno) + ": " + what);
        };
        if (tok == "entry") {
            int e;
            if (!(ss >> e)) fail("entry expects a node id");
            ensure(e);
            g.entry = e;
        } else if (tok == "edge") {
            int u, v;
            if (!(ss >> u >> v)) fail("edge expects two node ids");
            ensure(u);
            ensure(v);
            g.addEdge(u, v);
        } else {
            fail("unknown directive '" + tok + "'");
        }
    }
    if (g.size() == 0) throw std::runtime_error("empty graph");
    return g;
}

} // namespace cfg
