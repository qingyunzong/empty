#include "loops.hpp"

#include <algorithm>
#include <functional>
#include <map>
#include <sstream>
#include <stdexcept>

int Graph::edge_count() const {
  int m = 0;
  for (const auto& s : succ) m += static_cast<int>(s.size());
  return m;
}

int Graph::get_or_add(const std::string& name) {
  auto [it, inserted] = id.emplace(name, static_cast<int>(names.size()));
  if (inserted) {
    names.push_back(name);
    succ.emplace_back();
    pred.emplace_back();
  }
  return it->second;
}

void Graph::add_edge(int u, int v) {
  succ[u].push_back(v);
  pred[v].push_back(u);
}

void Graph::add_edge(const std::string& a, const std::string& b) {
  add_edge(get_or_add(a), get_or_add(b));
}

namespace {

std::string trim(const std::string& s) {
  size_t b = s.find_first_not_of(" \t\r\n");
  if (b == std::string::npos) return "";
  size_t e = s.find_last_not_of(" \t\r\n");
  return s.substr(b, e - b + 1);
}

}  // namespace

Graph parse_graph(const std::string& text, const std::string& entry_name) {
  Graph g;
  std::string entry;
  std::istringstream in(text);
  std::string line;
  while (std::getline(in, line)) {
    size_t hash = line.find('#');
    if (hash != std::string::npos) line = line.substr(0, hash);
    line = trim(line);
    if (line.empty()) continue;
    if (line.rfind("entry:", 0) == 0) {
      entry = trim(line.substr(6));
      continue;
    }
    size_t arrow = line.find("->");
    if (arrow != std::string::npos) line.replace(arrow, 2, " ");
    std::istringstream ls(line);
    std::string a, b;
    ls >> a;
    if (ls >> b) {
      g.add_edge(a, b);
    } else {
      g.get_or_add(a);  // isolated node declaration
    }
  }
  if (!entry_name.empty()) entry = entry_name;
  if (entry.empty()) {
    if (g.node_count() == 0) throw std::runtime_error("empty graph, no entry");
    entry = g.names.front();
  }
  g.entry = g.get_or_add(entry);
  return g;
}

std::string to_string(const Graph& g) {
  std::ostringstream os;
  os << "entry=" << (g.entry >= 0 ? g.names[g.entry] : std::string("<none>"))
     << "\n";
  for (int i = 0; i < g.node_count(); ++i) {
    os << g.names[i] << ":";
    for (int v : g.succ[i]) os << " " << g.names[v];
    os << "\n";
  }
  return os.str();
}

std::vector<char> reachable_from(const Graph& g, int start, int skip) {
  int n = g.node_count();
  std::vector<char> seen(n, 0);
  if (start < 0 || start >= n || start == skip) return seen;
  std::vector<int> stack{start};
  seen[start] = 1;
  while (!stack.empty()) {
    int u = stack.back();
    stack.pop_back();
    for (int v : g.succ[u]) {
      if (v == skip || seen[v]) continue;
      seen[v] = 1;
      stack.push_back(v);
    }
  }
  return seen;
}

std::vector<std::vector<int>> cyclic_sccs(const Graph& g) {
  int n = g.node_count();
  std::vector<int> index(n, -1), low(n, 0);
  std::vector<char> on_stack(n, 0);
  std::vector<int> stack;
  int next_index = 0;
  std::vector<std::vector<int>> result;

  std::function<void(int)> strongconnect = [&](int v) {
    index[v] = low[v] = next_index++;
    stack.push_back(v);
    on_stack[v] = 1;
    for (int w : g.succ[v]) {
      if (index[w] < 0) {
        strongconnect(w);
        low[v] = std::min(low[v], low[w]);
      } else if (on_stack[w]) {
        low[v] = std::min(low[v], index[w]);
      }
    }
    if (low[v] == index[v]) {
      std::vector<int> comp;
      int w;
      do {
        w = stack.back();
        stack.pop_back();
        on_stack[w] = 0;
        comp.push_back(w);
      } while (w != v);
      bool cyclic = comp.size() > 1;
      if (!cyclic) {
        int s = comp[0];
        cyclic = std::find(g.succ[s].begin(), g.succ[s].end(), s) !=
                 g.succ[s].end();
      }
      if (cyclic) {
        std::sort(comp.begin(), comp.end());
        result.push_back(std::move(comp));
      }
    }
  };
  for (int v = 0; v < n; ++v)
    if (index[v] < 0) strongconnect(v);
  std::sort(result.begin(), result.end(),
            [](const auto& a, const auto& b) { return a.front() < b.front(); });
  return result;
}

std::vector<std::set<int>> dominators(const Graph& g) {
  int n = g.node_count();
  std::vector<std::set<int>> dom(n);
  if (g.entry < 0 || g.entry >= n) return dom;
  auto reach = reachable_from(g, g.entry);
  std::set<int> all;
  for (int i = 0; i < n; ++i)
    if (reach[i]) all.insert(i);
  for (int i = 0; i < n; ++i)
    if (reach[i]) dom[i] = all;
  dom[g.entry] = {g.entry};
  bool changed = true;
  while (changed) {
    changed = false;
    for (int i = 0; i < n; ++i) {
      if (!reach[i] || i == g.entry) continue;
      std::set<int> acc;
      bool first = true;
      for (int p : g.pred[i]) {
        if (!reach[p]) continue;
        if (first) {
          acc = dom[p];
          first = false;
        } else {
          std::set<int> tmp;
          std::set_intersection(acc.begin(), acc.end(), dom[p].begin(),
                                dom[p].end(), std::inserter(tmp, tmp.begin()));
          acc = std::move(tmp);
        }
      }
      acc.insert(i);
      if (acc != dom[i]) {
        dom[i] = std::move(acc);
        changed = true;
      }
    }
  }
  return dom;
}

std::vector<std::set<int>> dominators_reference(const Graph& g) {
  int n = g.node_count();
  std::vector<std::set<int>> dom(n);
  if (g.entry < 0 || g.entry >= n) return dom;
  auto reach = reachable_from(g, g.entry);
  for (int d = 0; d < n; ++d) {
    if (!reach[d]) continue;
    auto without = reachable_from(g, g.entry, d);
    for (int v = 0; v < n; ++v)
      if (reach[v] && !without[v]) dom[v].insert(d);
  }
  return dom;
}

std::vector<NaturalLoop> natural_loops(const Graph& g) {
  int n = g.node_count();
  auto dom = dominators(g);
  auto reach = reachable_from(g, g.entry);
  std::map<int, NaturalLoop> by_header;
  for (int u = 0; u < n; ++u) {
    if (!reach[u]) continue;
    for (int v : g.succ[u]) {
      if (!reach[v] || !dom[u].count(v)) continue;  // not a back edge
      auto& loop = by_header[v];
      loop.header = v;
      loop.back_edge_sources.push_back(u);
      // Reverse walk from u, never stepping into the header v. When the
      // back edge is a self-loop (u == v) the header is already in the
      // loop, so nothing is explored (classic natural-loop algorithm).
      std::set<int> body{u};
      std::vector<int> stack;
      if (u != v) stack.push_back(u);
      while (!stack.empty()) {
        int x = stack.back();
        stack.pop_back();
        for (int p : g.pred[x]) {
          if (p == v || !reach[p] || body.count(p)) continue;
          body.insert(p);
          stack.push_back(p);
        }
      }
      body.insert(v);
      loop.body.insert(body.begin(), body.end());
    }
  }
  std::vector<NaturalLoop> loops;
  for (auto& [h, loop] : by_header) {
    std::sort(loop.back_edge_sources.begin(), loop.back_edge_sources.end());
    loops.push_back(std::move(loop));
  }
  return loops;
}

std::vector<IrreducibleLoop> irreducible_loops(const Graph& g) {
  int n = g.node_count();
  auto reach = reachable_from(g, g.entry);
  std::vector<IrreducibleLoop> result;
  for (const auto& comp : cyclic_sccs(g)) {
    if (!reach[comp.front()]) continue;  // unreachable SCC: not a live loop
    std::set<int> in(comp.begin(), comp.end());
    std::vector<int> entries;
    for (int v : comp) {
      bool is_entry = (v == g.entry);
      for (int p : g.pred[v])
        if (reach[p] && !in.count(p)) is_entry = true;
      if (is_entry) entries.push_back(v);
    }
    if (entries.size() > 1)
      result.push_back(IrreducibleLoop{comp, std::move(entries)});
  }
  (void)n;
  return result;
}

Graph split_irreducible(const Graph& g) {
  int n = g.node_count();
  auto reach = reachable_from(g, g.entry);
  struct Split {
    std::vector<int> nodes;
    std::vector<int> entries;
    std::unordered_map<int, int> entry_pos;
  };
  std::vector<Split> splits;
  std::vector<int> split_of(n, -1);
  for (const auto& loop : irreducible_loops(g)) {
    Split s;
    s.nodes = loop.nodes;
    s.entries = loop.entries;
    for (int i = 0; i < static_cast<int>(s.entries.size()); ++i)
      s.entry_pos[s.entries[i]] = i;
    for (int v : s.nodes) split_of[v] = static_cast<int>(splits.size());
    splits.push_back(std::move(s));
  }
  if (splits.empty()) return g;

  Graph out;
  std::vector<int> single(n, -1);
  std::vector<std::vector<int>> copy_id(n);
  for (int v = 0; v < n; ++v)
    if (split_of[v] < 0) single[v] = out.get_or_add(g.names[v]);
  for (const auto& s : splits)
    for (size_t k = 0; k < s.entries.size(); ++k)
      for (int v : s.nodes)
        copy_id[v].push_back(
            out.get_or_add(g.names[v] + "#" + std::to_string(k)));
  out.entry = single[g.entry];  // the entry is never inside a split loop

  auto copy_of_entry = [&](int v) -> int {
    const auto& s = splits[split_of[v]];
    auto it = s.entry_pos.find(v);
    // v is guaranteed to be an entry when the source side is reachable;
    // fall back to copy 0 for edges originating in unreachable nodes.
    size_t k = it != s.entry_pos.end() ? it->second : 0;
    return copy_id[v][k];
  };

  for (int u = 0; u < n; ++u) {
    for (int v : g.succ[u]) {
      int su = split_of[u], sv = split_of[v];
      if (su < 0 && sv < 0) {
        out.add_edge(single[u], single[v]);
      } else if (su < 0) {
        out.add_edge(single[u], copy_of_entry(v));
      } else if (sv < 0) {
        for (int w : copy_id[u]) out.add_edge(w, single[v]);
      } else if (su == sv) {
        for (size_t k = 0; k < copy_id[u].size(); ++k)
          out.add_edge(copy_id[u][k], copy_id[v][k]);
      } else {
        int dst = copy_of_entry(v);
        for (int w : copy_id[u]) out.add_edge(w, dst);
      }
    }
  }
  return out;
}
