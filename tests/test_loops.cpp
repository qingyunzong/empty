#include <algorithm>
#include <iostream>
#include <map>
#include <random>
#include <set>
#include <vector>

#include "loops.hpp"

static int failures = 0;

#define CHECK(...)                                                 \
  do {                                                           \
    if (!(__VA_ARGS__)) {                                        \
      ++failures;                                                \
      std::cerr << "FAIL " << __FILE__ << ":" << __LINE__ << " " \
                << #__VA_ARGS__ << "\n";                         \
    }                                                            \
  } while (0)

static std::set<std::string> name_set(const Graph& g, const std::set<int>& s) {
  std::set<std::string> out;
  for (int v : s) out.insert(g.names[v]);
  return out;
}

static void test_nested_loops() {
  Graph g = parse_graph(R"(
    entry: A
    A -> B
    B -> C
    C -> D
    D -> C
    D -> E
    E -> B
    E -> F
  )");
  auto loops = natural_loops(g);
  CHECK(loops.size() == 2);
  if (loops.size() != 2) return;
  const NaturalLoop *inner = nullptr, *outer = nullptr;
  for (const auto& l : loops) {
    if (g.names[l.header] == "C") inner = &l;
    if (g.names[l.header] == "B") outer = &l;
  }
  CHECK(inner && outer);
  if (!inner || !outer) return;
  CHECK(name_set(g, inner->body) == std::set<std::string>{"C", "D"});
  CHECK(name_set(g, outer->body) ==
        std::set<std::string>{"B", "C", "D", "E"});
  // Containment: inner body is a strict subset of the outer body.
  CHECK(std::includes(outer->body.begin(), outer->body.end(),
                      inner->body.begin(), inner->body.end()));
  CHECK(inner->body.size() < outer->body.size());
  CHECK(irreducible_loops(g).empty());
}

static void test_irreducible_loop() {
  Graph g = parse_graph(R"(
    entry: S
    S -> A
    S -> B
    A -> B
    B -> A
    A -> T
    B -> T
  )");
  CHECK(natural_loops(g).empty());
  auto irrs = irreducible_loops(g);
  CHECK(irrs.size() == 1);
  if (irrs.size() != 1) return;
  CHECK(name_set(g, std::set<int>(irrs[0].nodes.begin(), irrs[0].nodes.end())) ==
        std::set<std::string>{"A", "B"});
  CHECK(name_set(g,
                 std::set<int>(irrs[0].entries.begin(), irrs[0].entries.end())) ==
        std::set<std::string>{"A", "B"});
}

static void test_multiple_back_edges_one_loop() {
  Graph g = parse_graph(R"(
    entry: A
    A -> B
    B -> C
    B -> D
    C -> B
    C -> D
    D -> B
  )");
  auto loops = natural_loops(g);
  CHECK(loops.size() == 1);  // two back edges, single header -> one loop
  if (loops.size() != 1) return;
  CHECK(g.names[loops[0].header] == "B");
  CHECK(name_set(g, loops[0].body) == std::set<std::string>{"B", "C", "D"});
  CHECK(loops[0].back_edge_sources.size() == 2);
  std::set<std::string> srcs;
  for (int s : loops[0].back_edge_sources) srcs.insert(g.names[s]);
  CHECK(srcs == std::set<std::string>{"C", "D"});
}

static void test_self_loop() {
  Graph g = parse_graph("entry: A\nA -> A\nA -> B\n");
  auto loops = natural_loops(g);
  CHECK(loops.size() == 1);
  if (loops.size() == 1) {
    CHECK(g.names[loops[0].header] == "A");
    CHECK(name_set(g, loops[0].body) == std::set<std::string>{"A"});
  }
  CHECK(irreducible_loops(g).empty());  // single entry: reducible
}

static void test_unreachable_ignored() {
  Graph g = parse_graph("entry: A\nA -> B\nC -> D\nD -> C\n");
  CHECK(natural_loops(g).empty());
  CHECK(irreducible_loops(g).empty());
  auto dom = dominators(g);
  CHECK(dom[g.id.at("C")].empty());  // unreachable: no dominator info
}

static void test_split_keeps_input_unchanged() {
  Graph g = parse_graph(R"(
    entry: S
    S -> A
    S -> B
    A -> B
    B -> A
    A -> T
    B -> T
  )");
  std::string before = to_string(g);
  Graph reduced = split_irreducible(g);
  CHECK(to_string(g) == before);  // input graph must not be modified
  CHECK(irreducible_loops(reduced).empty());
  // Copies exist for both entries of the split loop.
  for (const char* n : {"A#0", "B#0", "A#1", "B#1"})
    CHECK(reduced.id.count(n) == 1);
  // Each copy is now a single-entry natural loop.
  auto loops = natural_loops(reduced);
  CHECK(loops.size() == 2);
  // Untouched nodes and their edges survive.
  CHECK(reduced.id.count("S") == 1 && reduced.id.count("T") == 1);
  auto reach = reachable_from(reduced, reduced.entry);
  CHECK(reach[reduced.id.at("T")]);
}

static void test_split_nested_irreducible() {
  // Two independent irreducible SCCs sharing an exit path.
  Graph g = parse_graph(R"(
    entry: S
    S -> A
    S -> B
    A -> B
    B -> A
    A -> C
    B -> C
    C -> D
    C -> E
    D -> E
    E -> D
    D -> T
    E -> T
  )");
  std::string before = to_string(g);
  Graph reduced = split_irreducible(g);
  CHECK(to_string(g) == before);
  CHECK(irreducible_loops(g).size() == 2);
  CHECK(irreducible_loops(reduced).empty());
  auto reach = reachable_from(reduced, reduced.entry);
  CHECK(reach[reduced.id.at("T")]);
}

static void test_split_reducible_is_identity() {
  Graph g = parse_graph("entry: A\nA -> B\nB -> C\nC -> B\n");
  Graph same = split_irreducible(g);
  CHECK(to_string(same) == to_string(g));
}

// Property test on random small graphs: the fast iterative dominators, the
// back edges and the natural-loop bodies must all agree with brute-force
// reference computations based on full reachability.
static void test_random_small_graphs_against_reference() {
  std::mt19937 rng(20261008);
  for (int iter = 0; iter < 400; ++iter) {
    int n = 1 + (int)(rng() % 8);
    Graph g;
    for (int i = 0; i < n; ++i) g.get_or_add("n" + std::to_string(i));
    for (int u = 0; u < n; ++u)
      for (int v = 0; v < n; ++v)
        if (rng() % 100 < 30) g.add_edge(u, v);
    g.entry = 0;

    auto dom_fast = dominators(g);
    auto dom_ref = dominators_reference(g);
    CHECK(dom_fast == dom_ref);

    auto reach = reachable_from(g, 0);

    // Reference natural loops: for every edge u->v where the reference says
    // v dominates u, the body is {v} plus every node that can reach u with
    // v removed (full-reachability reference, handles multiple back edges).
    std::map<int, std::set<int>> ref_body;
    std::map<int, std::vector<int>> ref_srcs;
    for (int u = 0; u < n; ++u) {
      if (!reach[u]) continue;
      for (int v : g.succ[u]) {
        if (!reach[v] || !dom_ref[u].count(v)) continue;
        ref_srcs[v].push_back(u);
        auto& body = ref_body[v];
        body.insert(v);
        body.insert(u);
        for (int w = 0; w < n; ++w) {
          if (w == v || !reach[w]) continue;
          auto from_w = reachable_from(g, w, v);
          if (from_w[u]) body.insert(w);
        }
      }
    }

    auto loops = natural_loops(g);
    CHECK(loops.size() == ref_body.size());
    for (const auto& l : loops) {
      auto it = ref_body.find(l.header);
      CHECK(it != ref_body.end());
      if (it != ref_body.end()) CHECK(l.body == it->second);
      auto srcs = ref_srcs[l.header];
      std::sort(srcs.begin(), srcs.end());
      CHECK(l.back_edge_sources == srcs);
    }

    // Irreducibility cross-check: an SCC is reducible iff some member
    // dominates every member (using reference dominators).
    auto irrs = irreducible_loops(g);
    std::set<std::vector<int>> irr_set;
    for (const auto& il : irrs) irr_set.insert(il.nodes);
    for (const auto& comp : cyclic_sccs(g)) {
      if (!reach[comp.front()]) continue;
      bool dominating_member = false;
      for (int v : comp) {
        bool all = true;
        for (int w : comp)
          if (!dom_ref[w].count(v)) all = false;
        if (all) dominating_member = true;
      }
      bool expect_irreducible = !dominating_member;
      CHECK(expect_irreducible == irr_set.count(comp));
    }
  }
}

static void test_dominators_known_graph() {
  // Classic reducible CFG with multiple back edges into one header.
  Graph g = parse_graph(R"(
    entry: A
    A -> B
    B -> C
    B -> D
    C -> E
    D -> E
    E -> B
    E -> F
  )");
  auto dom = dominators(g);
  auto ref = dominators_reference(g);
  CHECK(dom == ref);
  auto B = g.id.at("B"), E = g.id.at("E"), F = g.id.at("F");
  CHECK(dom[E].count(B));   // B dominates E
  CHECK(!dom[B].count(E));  // E does not dominate B
  CHECK(dom[F].count(B) && dom[F].count(E));
  auto loops = natural_loops(g);
  CHECK(loops.size() == 1);
  if (loops.size() == 1) {
    CHECK(loops[0].header == B);
    CHECK(name_set(g, loops[0].body) ==
          std::set<std::string>{"B", "C", "D", "E"});
  }
}

int main() {
  test_nested_loops();
  test_irreducible_loop();
  test_multiple_back_edges_one_loop();
  test_self_loop();
  test_unreachable_ignored();
  test_split_keeps_input_unchanged();
  test_split_nested_irreducible();
  test_split_reducible_is_identity();
  test_random_small_graphs_against_reference();
  test_dominators_known_graph();
  if (failures) {
    std::cerr << failures << " check(s) failed\n";
    return 1;
  }
  std::cout << "all unit tests passed\n";
  return 0;
}
