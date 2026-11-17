#pragma once

#include "dlks_formal.hpp"

#include <algorithm>
#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace dlks_test {

[[noreturn]] inline void fail(const std::string& context,
                              const std::string& what) {
  throw std::runtime_error(context + ": " + what);
}

inline void require(bool condition, const std::string& context,
                    const std::string& what) {
  if (!condition) {
    fail(context, what);
  }
}

inline std::string edge_text(const dlks_formal::WaitEdge& edge) {
  std::ostringstream out;
  out << edge.waiter << "->" << edge.holder << "/r" << edge.resource
      << "/q" << edge.request;
  return out.str();
}

inline std::string component_text(
    const std::vector<dlks_formal::TransactionId>& component) {
  std::ostringstream out;
  out << "{";
  for (std::size_t i = 0; i < component.size(); ++i) {
    if (i != 0) {
      out << ",";
    }
    out << component[i];
  }
  out << "}";
  return out.str();
}

struct ReferenceGraph {
  std::set<dlks_formal::TransactionId> vertices;
  std::set<dlks_formal::WaitEdge> edges;
  std::map<dlks_formal::TransactionId, dlks_formal::TransactionProfile>
      profiles;
};

inline dlks_formal::TransactionId reference_victim(
    const std::vector<dlks_formal::TransactionId>& component,
    const std::map<dlks_formal::TransactionId,
                   dlks_formal::TransactionProfile>& profiles,
    dlks_formal::Tick now) {
  dlks_formal::TransactionId victim = 0;
  bool have_victim = false;
  dlks_formal::TransactionProfile victim_profile{};
  for (const dlks_formal::TransactionId tx : component) {
    dlks_formal::TransactionProfile profile{};
    const auto it = profiles.find(tx);
    if (it != profiles.end()) {
      profile = it->second;
    }
    const dlks_formal::Tick age =
        now >= profile.born ? now - profile.born : 0;
    const dlks_formal::Tick victim_age =
        now >= victim_profile.born ? now - victim_profile.born : 0;
    const bool better =
        !have_victim || profile.cost < victim_profile.cost ||
        (profile.cost == victim_profile.cost && age > victim_age) ||
        (profile.cost == victim_profile.cost && age == victim_age &&
         tx < victim);
    if (better) {
      victim = tx;
      victim_profile = profile;
      have_victim = true;
    }
  }
  if (!have_victim) {
    throw std::logic_error("victim requested for empty component");
  }
  return victim;
}

// Plain full recomputation. This deliberately shares no incremental state
// with WaitForGraph.
inline dlks_formal::DeadlockAnalysis reference_analyze(
    const ReferenceGraph& graph, dlks_formal::Tick now) {
  std::map<dlks_formal::TransactionId,
           std::vector<dlks_formal::TransactionId>>
      adjacency;
  for (const dlks_formal::TransactionId tx : graph.vertices) {
    adjacency[tx];
  }
  for (const dlks_formal::WaitEdge& edge : graph.edges) {
    adjacency[edge.waiter].push_back(edge.holder);
    adjacency[edge.holder];
  }
  for (auto& [tx, neighbors] : adjacency) {
    (void)tx;
    std::sort(neighbors.begin(), neighbors.end());
    neighbors.erase(std::unique(neighbors.begin(), neighbors.end()),
                    neighbors.end());
  }

  std::map<dlks_formal::TransactionId, std::size_t> index;
  std::map<dlks_formal::TransactionId, std::size_t> low;
  std::set<dlks_formal::TransactionId> on_stack;
  std::vector<dlks_formal::TransactionId> stack;
  std::vector<std::vector<dlks_formal::TransactionId>> components;
  std::size_t next_index = 0;

  std::function<void(dlks_formal::TransactionId)> visit =
      [&](dlks_formal::TransactionId tx) {
        index[tx] = next_index;
        low[tx] = next_index;
        ++next_index;
        stack.push_back(tx);
        on_stack.insert(tx);
        for (const dlks_formal::TransactionId neighbor : adjacency[tx]) {
          if (!index.contains(neighbor)) {
            visit(neighbor);
            low[tx] = std::min(low[tx], low[neighbor]);
          } else if (on_stack.contains(neighbor)) {
            low[tx] = std::min(low[tx], index[neighbor]);
          }
        }
        if (low[tx] == index[tx]) {
          std::vector<dlks_formal::TransactionId> component;
          for (;;) {
            const dlks_formal::TransactionId member = stack.back();
            stack.pop_back();
            on_stack.erase(member);
            component.push_back(member);
            if (member == tx) {
              break;
            }
          }
          std::sort(component.begin(), component.end());
          components.push_back(std::move(component));
        }
      };

  for (const auto& [tx, neighbors] : adjacency) {
    (void)neighbors;
    if (!index.contains(tx)) {
      visit(tx);
    }
  }
  std::sort(components.begin(), components.end());

  dlks_formal::DeadlockAnalysis result;
  result.components = components;
  for (const auto& component : components) {
    bool cyclic = component.size() > 1;
    if (!cyclic && component.size() == 1) {
      const dlks_formal::TransactionId tx = component.front();
      cyclic = adjacency[tx].end() !=
               std::find(adjacency[tx].begin(), adjacency[tx].end(), tx);
    }
    if (cyclic) {
      result.cycles.push_back(dlks_formal::DeadlockCycle{
          component, reference_victim(component, graph.profiles, now)});
    }
  }
  std::sort(result.cycles.begin(), result.cycles.end(),
            [](const dlks_formal::DeadlockCycle& lhs,
               const dlks_formal::DeadlockCycle& rhs) {
              return lhs.members < rhs.members;
            });
  return result;
}

inline ReferenceGraph reference_from_manager(
    const dlks_formal::LockManager& manager) {
  ReferenceGraph graph;
  for (const dlks_formal::TransactionId tx : manager.transactions()) {
    graph.vertices.insert(tx);
    const auto profile = manager.transaction_profile(tx);
    if (profile.has_value()) {
      graph.profiles[tx] = *profile;
    }
  }
  for (const dlks_formal::PendingRequest& request :
       manager.pending_requests()) {
    graph.vertices.insert(request.tx);
    for (const auto& [holder, mode] : manager.holders(request.resource)) {
      if (holder == request.tx) {
        continue;
      }
      const bool conflicts =
          request.mode == dlks_formal::LockMode::exclusive ||
          mode == dlks_formal::LockMode::exclusive;
      if (conflicts) {
        graph.edges.insert(
            dlks_formal::WaitEdge{request.tx, holder, request.resource,
                                  request.id});
      }
    }
  }
  return graph;
}

inline void check_graph(const dlks_formal::WaitForGraph& actual,
                        const ReferenceGraph& reference,
                        dlks_formal::Tick now,
                        const std::string& context) {
  actual.assert_invariants();
  if (actual.edges() != reference.edges) {
    std::ostringstream out;
    out << "edge sets differ; actual=" << actual.edges().size()
        << " reference=" << reference.edges.size();
    for (const auto& edge : actual.edges()) {
      if (!reference.edges.contains(edge)) {
        out << "; unexpected " << edge_text(edge);
      }
    }
    for (const auto& edge : reference.edges) {
      if (!actual.edges().contains(edge)) {
        out << "; missing " << edge_text(edge);
      }
    }
    fail(context, out.str());
  }

  const dlks_formal::DeadlockAnalysis expected =
      reference_analyze(reference, now);
  const dlks_formal::DeadlockAnalysis got = actual.analyze(now);
  if (got.components != expected.components) {
    std::ostringstream out;
    out << "SCC partition differs; got=";
    for (const auto& component : got.components) {
      out << component_text(component) << " ";
    }
    out << " expected=";
    for (const auto& component : expected.components) {
      out << component_text(component) << " ";
    }
    fail(context, out.str());
  }
  if (got.cycles != expected.cycles) {
    std::ostringstream out;
    out << "cycle/victim result differs; got=";
    for (const auto& cycle : got.cycles) {
      out << component_text(cycle.members) << " victim=" << cycle.victim
          << " ";
    }
    out << " expected=";
    for (const auto& cycle : expected.cycles) {
      out << component_text(cycle.members) << " victim=" << cycle.victim
          << " ";
    }
    fail(context, out.str());
  }
}

inline void check_manager(const dlks_formal::LockManager& manager,
                          const std::string& context) {
  manager.assert_invariants();
  const ReferenceGraph reference = reference_from_manager(manager);
  check_graph(manager.graph(), reference, manager.now(), context);

  const dlks_formal::DeadlockAnalysis direct = manager.deadlock_analysis();
  const dlks_formal::DeadlockAnalysis expected =
      reference_analyze(reference, manager.now());
  if (direct != expected) {
    fail(context, "LockManager::deadlock_analysis differs from reference");
  }
}

}  // namespace dlks_test
