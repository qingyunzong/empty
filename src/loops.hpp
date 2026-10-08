#pragma once

#include <set>
#include <string>
#include <unordered_map>
#include <vector>

// Directed flow graph with named nodes and a designated entry node.
struct Graph {
  std::vector<std::string> names;
  std::unordered_map<std::string, int> id;
  std::vector<std::vector<int>> succ;
  std::vector<std::vector<int>> pred;
  int entry = -1;

  int node_count() const { return static_cast<int>(names.size()); }
  int edge_count() const;
  int get_or_add(const std::string& name);
  void add_edge(const std::string& a, const std::string& b);
  void add_edge(int u, int v);
};

// Parses lines of the form "A -> B" (or "A B", or bare "A" for an isolated
// node). "#" starts a comment. "entry: X" selects the entry node; the
// explicit entry_name argument, when non-empty, takes precedence. Without
// either, the first node seen becomes the entry.
Graph parse_graph(const std::string& text, const std::string& entry_name = "");

// Canonical textual form (deterministic), used to verify immutability.
std::string to_string(const Graph& g);

// Nodes reachable from start; skip >= 0 removes that node from the graph.
std::vector<char> reachable_from(const Graph& g, int start, int skip = -1);

// Strongly connected components that form cycles (size > 1 or self-loop).
// Each component is sorted ascending; components sorted by first element.
std::vector<std::vector<int>> cyclic_sccs(const Graph& g);

// Iterative dataflow dominators over nodes reachable from the entry.
std::vector<std::set<int>> dominators(const Graph& g);

// Reference dominators from first principles: d dominates v iff v becomes
// unreachable from the entry when d is removed. Expensive; for verification
// of small graphs.
std::vector<std::set<int>> dominators_reference(const Graph& g);

// A natural loop: back edges (source -> header, header dominates source)
// merged by header. body includes the header and every node that can reach
// a back-edge source without passing through the header.
struct NaturalLoop {
  int header = -1;
  std::set<int> body;
  std::vector<int> back_edge_sources;
};
std::vector<NaturalLoop> natural_loops(const Graph& g);

// A reachable cyclic SCC with more than one entry node (a node of the SCC
// that is the graph entry or has a reachable predecessor outside the SCC).
struct IrreducibleLoop {
  std::vector<int> nodes;
  std::vector<int> entries;
};
std::vector<IrreducibleLoop> irreducible_loops(const Graph& g);

// Returns a NEW graph (the input is never modified) in which every
// irreducible loop has been eliminated by node splitting: for a loop with
// entries e_0..e_{k-1}, the loop body is duplicated into k copies, copy i
// being reachable from outside only through e_i's copy (named "X#i").
Graph split_irreducible(const Graph& g);
