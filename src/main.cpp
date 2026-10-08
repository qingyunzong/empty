#include <algorithm>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "loops.hpp"

namespace {

std::string join_names(const Graph& g, const std::vector<int>& nodes,
                       const char* open, const char* close) {
  std::vector<std::string> ns;
  for (int v : nodes) ns.push_back(g.names[v]);
  std::sort(ns.begin(), ns.end());
  std::ostringstream os;
  os << open;
  for (size_t i = 0; i < ns.size(); ++i) os << (i ? ", " : "") << ns[i];
  os << close;
  return os.str();
}

std::string join_names(const Graph& g, const std::set<int>& nodes) {
  return join_names(g, std::vector<int>(nodes.begin(), nodes.end()), "{",
                    "}");
}

void analyze(const Graph& g, std::ostream& os) {
  int n = g.node_count();
  auto reach = reachable_from(g, g.entry);
  int r = 0;
  for (char c : reach) r += c;

  os << "Graph: " << n << " nodes, " << g.edge_count()
     << " edges, entry=" << g.names[g.entry] << "\n";
  os << "Reachable nodes: " << r << "/" << n << "\n";

  auto sccs = cyclic_sccs(g);
  os << "Cyclic SCCs: " << sccs.size() << "\n";
  for (const auto& comp : sccs) {
    os << "  scc: " << join_names(g, comp, "{", "}")
       << (reach[comp.front()] ? "" : " (unreachable)") << "\n";
  }

  auto loops = natural_loops(g);
  int back_edges = 0;
  for (const auto& l : loops) back_edges += (int)l.back_edge_sources.size();
  os << "Back edges: " << back_edges << "\n";
  for (const auto& l : loops)
    for (int src : l.back_edge_sources)
      os << "  " << g.names[src] << " -> " << g.names[l.header] << "\n";

  // Nesting depth: number of other loops whose body strictly contains ours.
  std::vector<int> depth(loops.size(), 0);
  for (size_t i = 0; i < loops.size(); ++i)
    for (size_t j = 0; j < loops.size(); ++j)
      if (i != j && std::includes(loops[j].body.begin(), loops[j].body.end(),
                                  loops[i].body.begin(), loops[i].body.end()))
        ++depth[i];
  std::vector<size_t> order(loops.size());
  for (size_t i = 0; i < loops.size(); ++i) order[i] = i;
  std::sort(order.begin(), order.end(), [&](size_t a, size_t b) {
    if (depth[a] != depth[b]) return depth[a] < depth[b];
    return loops[a].body.size() > loops[b].body.size();
  });

  os << "Natural loops: " << loops.size() << "\n";
  for (size_t idx : order) {
    const auto& l = loops[idx];
    os << std::string(2 * depth[idx], ' ') << "  header=" << g.names[l.header]
       << " body=" << join_names(g, l.body) << " back_edges={";
    for (size_t i = 0; i < l.back_edge_sources.size(); ++i)
      os << (i ? ", " : "") << g.names[l.back_edge_sources[i]] << "->"
         << g.names[l.header];
    os << "}\n";
  }

  auto irrs = irreducible_loops(g);
  os << "Irreducible loops: " << irrs.size() << "\n";
  for (const auto& il : irrs)
    os << "  entries=" << join_names(g, il.entries, "{", "}")
       << " nodes=" << join_names(g, il.nodes, "{", "}") << "\n";
}

[[noreturn]] void usage(const char* prog, int code) {
  std::cerr << "usage: " << prog << " FILE [--entry NAME] [--split]\n"
            << "  input: lines 'A -> B' (or 'A B'), '# comments', 'entry: X'\n"
            << "  --split: also print analysis of the node-split reducible "
               "graph (input graph is left unchanged)\n";
  std::exit(code);
}

}  // namespace

int main(int argc, char** argv) {
  std::string file, entry;
  bool split = false;
  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    if (a == "--entry" && i + 1 < argc) {
      entry = argv[++i];
    } else if (a == "--split") {
      split = true;
    } else if (a == "--help" || a == "-h") {
      usage(argv[0], 0);
    } else if (!a.empty() && a[0] == '-') {
      usage(argv[0], 2);
    } else if (file.empty()) {
      file = a;
    } else {
      usage(argv[0], 2);
    }
  }
  if (file.empty()) usage(argv[0], 2);

  std::ifstream in(file);
  if (!in) {
    std::cerr << "error: cannot open " << file << "\n";
    return 1;
  }
  std::ostringstream ss;
  ss << in.rdbuf();

  Graph g;
  try {
    g = parse_graph(ss.str(), entry);
  } catch (const std::exception& e) {
    std::cerr << "error: " << e.what() << "\n";
    return 1;
  }

  analyze(g, std::cout);

  if (split) {
    std::string before = to_string(g);
    Graph reduced = split_irreducible(g);
    if (to_string(g) != before) {  // must never happen: input is immutable
      std::cerr << "error: node splitting mutated the input graph\n";
      return 1;
    }
    std::cout << "Split graph (node splitting applied to a copy):\n";
    analyze(reduced, std::cout);
  }
  return 0;
}
