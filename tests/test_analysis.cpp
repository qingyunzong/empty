#include "analysis.hpp"

#include <iostream>
#include <set>
#include <sstream>
#include <string>
#include <vector>

using namespace cfg;

static int failures = 0;

#define CHECK(cond)                                                                                \
    do {                                                                                           \
        if (!(cond)) {                                                                             \
            ++failures;                                                                            \
            std::cerr << "FAIL " << __FILE__ << ':' << __LINE__ << ": " #cond "\n";                \
        }                                                                                          \
    } while (0)

static Graph makeGraph(std::initializer_list<std::pair<int, int>> edges, int entry = 0,
                       int nodes = -1) {
    Graph g;
    int hi = entry;
    for (auto [u, v] : edges) hi = std::max(hi, std::max(u, v));
    if (nodes >= 0) hi = std::max(hi, nodes - 1);
    while (g.size() <= hi) g.addNode();
    g.entry = entry;
    for (auto [u, v] : edges) g.addEdge(u, v);
    return g;
}

static int countReachable(const Graph& g) {
    int n = 0;
    for (bool b : reachableMask(g)) n += b ? 1 : 0;
    return n;
}

// Short graph, fully reachable: outer loop {1,2,3,4} with nested inner {2,3}.
static Graph nestedGraph() {
    return makeGraph({{0, 1}, {1, 2}, {2, 3}, {3, 2}, {2, 4}, {4, 1}, {1, 5}});
}

// Classic irreducible: SCC {1,2} entered at both 1 and 2.
static Graph irreducibleGraph() {
    return makeGraph({{0, 1}, {0, 2}, {1, 2}, {2, 1}, {1, 3}, {2, 3}});
}

// One header, two latches (multiple back edges).
static Graph multiBackEdgeGraph() {
    return makeGraph({{0, 1}, {1, 2}, {2, 1}, {1, 3}, {3, 1}, {1, 4}});
}

static void testNestedNaturalLoops() {
    const Graph g = nestedGraph();
    CHECK(countReachable(g) == g.size()); // short graph fully reachable
    const auto dom = dominatorSets(g);
    CHECK(verifyDominatorsByRemoval(g, dom));

    const auto bes = backEdges(g, dom);
    CHECK(bes.size() == 2);

    const auto loops = naturalLoops(g, dom);
    CHECK(loops.size() == 2);
    const NaturalLoop *outer = nullptr, *inner = nullptr;
    for (const auto& l : loops) {
        if (l.header == 1) outer = &l;
        if (l.header == 2) inner = &l;
    }
    CHECK(outer && inner);
    CHECK(outer->body == std::set<int>({1, 2, 3, 4}));
    CHECK(inner->body == std::set<int>({2, 3}));
    // nesting by containment: inner's parent is outer, outer is top level
    CHECK(outer->parent == -1);
    CHECK(inner->parent == (int)(outer - loops.data()));

    CHECK(irreducibleLoops(g, dom).empty());
}

static void testIrreducibleLoop() {
    const Graph g = irreducibleGraph();
    CHECK(countReachable(g) == g.size());
    const auto dom = dominatorSets(g);
    CHECK(verifyDominatorsByRemoval(g, dom));

    CHECK(backEdges(g, dom).empty()); // no dominator-backed edge
    CHECK(naturalLoops(g, dom).empty());

    const auto irr = irreducibleLoops(g, dom);
    CHECK(irr.size() == 1);
    CHECK(irr[0].nodes == std::set<int>({1, 2}));
    CHECK(irr[0].entries == std::set<int>({1, 2})); // multi-entry => irreducible
}

static void testMultiBackEdge() {
    const Graph g = multiBackEdgeGraph();
    CHECK(countReachable(g) == g.size());
    const auto dom = dominatorSets(g);
    // dominator reference verification on a graph with multiple back edges
    CHECK(verifyDominatorsByRemoval(g, dom));

    const auto bes = backEdges(g, dom);
    CHECK(bes.size() == 2);
    for (const auto& be : bes) CHECK(be.to == 1);

    const auto loops = naturalLoops(g, dom);
    CHECK(loops.size() == 1); // both back edges merge into one natural loop
    CHECK(loops[0].header == 1);
    CHECK(loops[0].latches == std::vector<int>({2, 3}));
    CHECK(loops[0].body == std::set<int>({1, 2, 3}));
    CHECK(irreducibleLoops(g, dom).empty());
}

static void testUnreachableNode() {
    const Graph g = makeGraph({{0, 1}, {1, 0}}, 0, 3); // node 2 unreachable
    CHECK(countReachable(g) == 2);
    const auto dom = dominatorSets(g);
    CHECK(dom[2].empty());
    CHECK(verifyDominatorsByRemoval(g, dom));
    const auto loops = naturalLoops(g, dom);
    CHECK(loops.size() == 1 && loops[0].body == std::set<int>({0, 1}));
}

static void testSelfLoop() {
    const Graph g = makeGraph({{0, 1}, {1, 1}, {1, 2}});
    const auto dom = dominatorSets(g);
    CHECK(verifyDominatorsByRemoval(g, dom));
    const auto loops = naturalLoops(g, dom);
    CHECK(loops.size() == 1);
    CHECK(loops[0].header == 1 && loops[0].body == std::set<int>({1}));
    CHECK(irreducibleLoops(g, dom).empty());
}

static void testNodeSplittingKeepsInput() {
    const Graph g = irreducibleGraph();
    const Graph before = g;
    const Graph split = splitCopy(g);
    CHECK(g == before); // node splitting must not change the input

    const auto dom = dominatorSets(split);
    CHECK(verifyDominatorsByRemoval(split, dom));
    CHECK(irreducibleLoops(split, dom).empty()); // copy is reducible now
    const auto loops = naturalLoops(split, dom);
    CHECK(loops.size() == 2); // one natural loop per entry copy
    CHECK(countReachable(split) == split.size());
}

static void testParser() {
    std::istringstream in("# comment\nentry 0\nedge 0 1\nedge 1 2 # trailing\nedge 2 1\n");
    const Graph g = loadGraph(in);
    CHECK(g.size() == 3 && g.edgeCount() == 3 && g.entry == 0);
    const auto loops = naturalLoops(g, dominatorSets(g));
    CHECK(loops.size() == 1 && loops[0].header == 1);
}

int main() {
    testNestedNaturalLoops();
    testIrreducibleLoop();
    testMultiBackEdge();
    testUnreachableNode();
    testSelfLoop();
    testNodeSplittingKeepsInput();
    testParser();
    if (failures) {
        std::cerr << failures << " check(s) failed\n";
        return 1;
    }
    std::cout << "all unit checks passed\n";
    return 0;
}
