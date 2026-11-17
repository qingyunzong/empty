#include "test_support.hpp"

#include <cstddef>
#include <cstdint>
#include <functional>
#include <iostream>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <vector>

namespace {

using dlks_formal::DeadlockAnalysis;
using dlks_formal::LockManager;
using dlks_formal::LockMode;
using dlks_formal::RequestId;
using dlks_formal::ResourceId;
using dlks_formal::Tick;
using dlks_formal::TransactionId;
using dlks_formal::TransactionProfile;
using dlks_formal::WaitEdge;
using dlks_formal::WaitForGraph;
using dlks_test::check_graph;
using dlks_test::check_manager;
using dlks_test::ReferenceGraph;
using dlks_test::require;

constexpr ResourceId kR0 = 10;
constexpr ResourceId kR1 = 20;

std::string graph_key(const WaitForGraph& graph) {
  std::ostringstream out;
  for (const WaitEdge& edge : graph.edges()) {
    out << edge.waiter << ":" << edge.holder << ":" << edge.resource << ":"
        << edge.request << ";";
  }
  return out.str();
}

void test_edge_space_exhaustive() {
  const std::map<TransactionId, TransactionProfile> profiles{
      {1, {3, 0}}, {2, {1, 4}}, {3, {2, 0}}};
  WaitForGraph root;
  ReferenceGraph reference;
  for (const auto& [tx, profile] : profiles) {
    root.add_transaction(tx, profile);
    reference.vertices.insert(tx);
    reference.profiles[tx] = profile;
  }

  std::vector<WaitEdge> alphabet;
  for (TransactionId waiter = 1; waiter <= 3; ++waiter) {
    for (TransactionId holder = 1; holder <= 3; ++holder) {
      alphabet.push_back(WaitEdge{
          waiter, holder, 100 + waiter * 10 + holder,
          1000 + waiter * 10 + holder});
    }
  }

  std::map<std::string, int> best_depth;
  std::size_t transitions = 0;
  std::size_t cyclic_states = 0;
  std::size_t self_loop_states = 0;
  constexpr int kMaxDepth = 9;

  std::function<void(const WaitForGraph&, const ReferenceGraph&, int,
                     const std::string&)>
      explore = [&](const WaitForGraph& graph, const ReferenceGraph& ref,
                    int depth, const std::string& context) {
        const std::string key = graph_key(graph);
        const auto seen = best_depth.find(key);
        if (seen != best_depth.end() && seen->second <= depth) {
          return;
        }
        best_depth[key] = depth;
        check_graph(graph, ref, 10, context);
        const DeadlockAnalysis analysis = graph.analyze(10);
        if (!analysis.cycles.empty()) {
          ++cyclic_states;
          for (const auto& cycle : analysis.cycles) {
            if (cycle.members.size() == 1) {
              ++self_loop_states;
            }
          }
        }
        if (depth >= kMaxDepth) {
          return;
        }
        for (const WaitEdge& edge : alphabet) {
          WaitForGraph child = graph;
          ReferenceGraph child_ref = ref;
          std::ostringstream child_context;
          child_context << context << " / " << (graph.has_edge(edge) ? "-" : "+")
                        << edge.waiter << "->" << edge.holder;
          if (graph.has_edge(edge)) {
            require(child.remove_edge(edge), child_context.str(),
                    "remove edge");
            child_ref.edges.erase(edge);
          } else {
            require(child.add_edge(edge), child_context.str(), "add edge");
            child_ref.edges.insert(edge);
          }
          ++transitions;
          explore(child, child_ref, depth + 1, child_context.str());
        }
      };

  explore(root, reference, 0, "edge-space root");
  require(best_depth.size() == 512, "edge-space",
          "explored the complete 3-vertex edge space");
  require(cyclic_states > 100, "edge-space", "explored cyclic states");
  require(self_loop_states > 0, "edge-space", "explored a self-loop state");
  std::cout << "edge-space exhaustive: " << best_depth.size() << " states, "
            << transitions << " transitions, " << cyclic_states
            << " cyclic states\n";
}

void test_larger_graph_differential_stress() {
  constexpr TransactionId kVertices = 8;
  WaitForGraph graph;
  ReferenceGraph reference;
  for (TransactionId tx = 1; tx <= kVertices; ++tx) {
    const TransactionProfile profile{(tx * 7) % 5, (tx * 3) % 11};
    graph.add_transaction(tx, profile);
    reference.vertices.insert(tx);
    reference.profiles[tx] = profile;
  }

  std::uint64_t random = 0x9e3779b97f4a7c15ULL;
  auto next = [&]() {
    random ^= random << 13;
    random ^= random >> 7;
    random ^= random << 17;
    return random;
  };

  constexpr std::size_t kOperations = 30000;
  std::size_t cyclic_observations = 0;
  for (std::size_t operation = 0; operation < kOperations; ++operation) {
    const TransactionId waiter = 1 + next() % kVertices;
    const TransactionId holder = 1 + next() % kVertices;
    const std::uint64_t variant = next() % 2;
    const WaitEdge edge{waiter, holder, 500 + variant,
                        1000 + waiter * 100 + holder * 10 + variant};
    if (graph.has_edge(edge)) {
      require(graph.remove_edge(edge), "graph stress", "remove");
      reference.edges.erase(edge);
    } else {
      require(graph.add_edge(edge), "graph stress", "add");
      reference.edges.insert(edge);
    }

    if (operation % 500 == 499) {
      const TransactionId retired = 1 + next() % kVertices;
      const TransactionProfile profile = reference.profiles.at(retired);
      require(graph.remove_transaction(retired), "graph stress",
              "remove transaction");
      reference.vertices.erase(retired);
      reference.profiles.erase(retired);
      for (auto it = reference.edges.begin(); it != reference.edges.end();) {
        if (it->waiter == retired || it->holder == retired) {
          it = reference.edges.erase(it);
        } else {
          ++it;
        }
      }
      require(graph.add_transaction(retired, profile), "graph stress",
              "re-add transaction");
      reference.vertices.insert(retired);
      reference.profiles[retired] = profile;
    }

    check_graph(graph, reference, 20, "graph stress");
    if (!reference_analyze(reference, 20).cycles.empty()) {
      ++cyclic_observations;
    }
  }
  check_graph(graph, reference, 20, "graph stress final");
  require(cyclic_observations > 0, "graph stress", "observed cycles");
  std::cout << "graph differential stress: " << kOperations
            << " operations, " << graph.edge_count() << " final edges\n";
}

struct Event {
  enum class Kind {
    begin,
    acquire,
    acquire_deadline,
    grant,
    cancel,
    timeout,
    release,
    end,
    advance,
    resolve,
  };

  Kind kind = Kind::begin;
  TransactionId tx = 0;
  ResourceId resource = 0;
  LockMode mode = LockMode::shared;

  std::string label() const {
    std::ostringstream out;
    switch (kind) {
      case Kind::begin:
        return "begin(" + std::to_string(tx) + ")";
      case Kind::acquire:
        return "acquire(" + std::to_string(tx) + ",r" +
               std::to_string(resource) +
               (mode == LockMode::exclusive ? ",X)" : ",S)");
      case Kind::acquire_deadline:
        return "acquire_deadline(" + std::to_string(tx) + ",r" +
               std::to_string(resource) +
               (mode == LockMode::exclusive ? ",X,+2)" : ",S,+2)");
      case Kind::grant:
        return "grant(" + std::to_string(tx) + ")";
      case Kind::cancel:
        return "cancel(" + std::to_string(tx) + ")";
      case Kind::timeout:
        return "timeout(" + std::to_string(tx) + ")";
      case Kind::release:
        return "release(" + std::to_string(tx) + ",r" +
               std::to_string(resource) + ")";
      case Kind::end:
        return "end(" + std::to_string(tx) + ")";
      case Kind::advance:
        return "advance(+1)";
      case Kind::resolve:
        return "resolve()";
    }
    return "?";
  }
};

std::vector<Event> valid_events(
    const LockManager& manager,
    const std::vector<TransactionId>& transaction_domain,
    const std::vector<ResourceId>& resource_domain) {
  std::vector<Event> events;
  for (const TransactionId tx : transaction_domain) {
    if (!manager.contains(tx)) {
      events.push_back(Event{Event::Kind::begin, tx, 0, LockMode::shared});
      continue;
    }

    const auto pending = manager.pending_for(tx);
    if (pending.has_value()) {
      events.push_back(Event{Event::Kind::grant, tx, 0, LockMode::shared});
      events.push_back(Event{Event::Kind::cancel, tx, 0, LockMode::shared});
      events.push_back(Event{Event::Kind::timeout, tx, 0, LockMode::shared});
    }

    std::map<ResourceId, LockMode> held;
    for (const auto& [resource, mode] : manager.held_locks(tx)) {
      held[resource] = mode;
    }
    if (!pending.has_value()) {
      for (const ResourceId resource : resource_domain) {
        for (const LockMode mode : {LockMode::shared, LockMode::exclusive}) {
          const auto it = held.find(resource);
          const bool already_held =
              it != held.end() &&
              (it->second == LockMode::exclusive ||
               mode == LockMode::shared);
          if (!already_held) {
            events.push_back(Event{Event::Kind::acquire, tx, resource, mode});
            events.push_back(
                Event{Event::Kind::acquire_deadline, tx, resource, mode});
          }
        }
      }
    }
    for (const auto& [resource, mode] : held) {
      (void)mode;
      events.push_back(
          Event{Event::Kind::release, tx, resource, LockMode::shared});
    }
    events.push_back(Event{Event::Kind::end, tx, 0, LockMode::shared});
  }
  events.push_back(Event{Event::Kind::advance, 0, 0, LockMode::shared});
  if (!manager.deadlock_analysis().cycles.empty()) {
    events.push_back(Event{Event::Kind::resolve, 0, 0, LockMode::shared});
  }
  return events;
}

std::string manager_key(
    const LockManager& manager,
    const std::vector<TransactionId>& transaction_domain,
    const std::vector<ResourceId>& resource_domain) {
  std::ostringstream out;
  out << "now=" << manager.now() << ";";
  for (const TransactionId tx : transaction_domain) {
    out << "T" << tx << "[";
    if (manager.contains(tx)) {
      const auto profile = manager.transaction_profile(tx);
      out << "c" << profile->cost << ",b" << profile->born << ";";
      for (const auto& [resource, mode] : manager.held_locks(tx)) {
        out << "h" << resource << ":" << static_cast<int>(mode) << ";";
      }
      const auto pending = manager.pending_for(tx);
      if (pending.has_value()) {
        out << "p" << pending->resource << ":"
            << static_cast<int>(pending->mode) << ":"
            << static_cast<int>(pending->kind) << ":";
        if (pending->deadline.has_value()) {
          out << *pending->deadline;
        } else {
          out << "-";
        }
        out << ";";
      }
    }
    out << "]";
  }
  for (const ResourceId resource : resource_domain) {
    out << "Q" << resource << "[";
    for (const RequestId id : manager.queue(resource)) {
      const auto request = manager.pending(id);
      if (request.has_value()) {
        out << request->tx << ",";
      }
    }
    out << "]";
  }
  return out.str();
}

void apply_event(const Event& event, LockManager& manager) {
  switch (event.kind) {
    case Event::Kind::begin: {
      const std::uint64_t cost = event.tx == 1 ? 2 : 1;
      require(manager.begin(event.tx, cost), event.label(), "begin");
      break;
    }
    case Event::Kind::acquire:
      (void)manager.acquire(event.tx, event.resource, event.mode);
      break;
    case Event::Kind::acquire_deadline:
      (void)manager.acquire(event.tx, event.resource, event.mode,
                            manager.now() + 2);
      break;
    case Event::Kind::grant:
      (void)manager.grant_pending(event.tx);
      break;
    case Event::Kind::cancel:
      require(manager.cancel_pending(event.tx), event.label(), "cancel");
      break;
    case Event::Kind::timeout:
      require(manager.timeout_pending(event.tx), event.label(), "timeout");
      break;
    case Event::Kind::release:
      require(manager.release(event.tx, event.resource), event.label(),
              "release");
      break;
    case Event::Kind::end:
      require(manager.end_transaction(event.tx), event.label(), "end");
      break;
    case Event::Kind::advance:
      (void)manager.advance_time(1);
      break;
    case Event::Kind::resolve: {
      const auto aborted = manager.resolve_deadlocks();
      require(!aborted.empty(), event.label(), "resolved a cycle");
      break;
    }
  }
}

struct LockSpaceStats {
  std::size_t states = 0;
  std::size_t transitions = 0;
  std::size_t cyclic_states = 0;
  std::size_t multi_node_cycles = 0;
  std::size_t max_cycle_size = 0;
  std::size_t resolved_states = 0;
};

LockSpaceStats run_lock_space(
    const std::vector<TransactionId>& transaction_domain,
    const std::vector<ResourceId>& resource_domain, int max_depth,
    const std::string& name) {
  LockManager root;
  std::map<std::string, int> best_depth;
  LockSpaceStats stats;

  std::function<void(const LockManager&, int, const std::string&)> explore =
      [&](const LockManager& manager, int depth, const std::string& context) {
        const std::string key =
            manager_key(manager, transaction_domain, resource_domain);
        const auto seen = best_depth.find(key);
        if (seen != best_depth.end() && seen->second <= depth) {
          return;
        }
        best_depth[key] = depth;
        check_manager(manager, context);
        const DeadlockAnalysis analysis = manager.deadlock_analysis();
        if (!analysis.cycles.empty()) {
          ++stats.cyclic_states;
          for (const auto& cycle : analysis.cycles) {
            stats.max_cycle_size =
                std::max(stats.max_cycle_size, cycle.members.size());
            if (cycle.members.size() > 1) {
              ++stats.multi_node_cycles;
            }
          }
        }
        if (depth >= max_depth) {
          return;
        }
        for (const Event& event :
             valid_events(manager, transaction_domain, resource_domain)) {
          LockManager child = manager;
          apply_event(event, child);
          if (event.kind == Event::Kind::resolve) {
            ++stats.resolved_states;
          }
          ++stats.transitions;
          explore(child, depth + 1, context + " / " + event.label());
        }
      };

  explore(root, 0, name + " root");
  stats.states = best_depth.size();
  std::cout << name << ": " << stats.states << " states, "
            << stats.transitions << " transitions, " << stats.cyclic_states
            << " cyclic states, max cycle " << stats.max_cycle_size << "\n";
  return stats;
}

void test_lock_event_space_exhaustive() {
  const std::vector<TransactionId> two_txs{1, 2};
  const std::vector<ResourceId> two_resources{kR0, kR1};
  const LockSpaceStats two = run_lock_space(two_txs, two_resources, 10,
                                            "lock-space 2x2");
  require(two.states > 1000, "lock-space 2x2", "explored enough states");
  require(two.cyclic_states > 100, "lock-space 2x2",
          "explored cyclic states");
  require(two.multi_node_cycles > 100, "lock-space 2x2",
          "explored multi-transaction cycles");
  require(two.max_cycle_size >= 2, "lock-space 2x2",
          "reached a real deadlock");
  require(two.resolved_states > 0, "lock-space 2x2",
          "exercised victim resolution");
}

void test_three_way_event_space_exhaustive() {
  const std::vector<TransactionId> three_txs{1, 2, 3};
  const std::vector<ResourceId> one_resource{kR0};
  const LockSpaceStats three = run_lock_space(three_txs, one_resource, 10,
                                              "lock-space 3x1");
  require(three.states > 1000, "lock-space 3x1", "explored enough states");
  require(three.cyclic_states > 100, "lock-space 3x1",
          "explored cyclic states");
  require(three.max_cycle_size == 3, "lock-space 3x1",
          "reached a three-transaction upgrade cycle");
  require(three.resolved_states > 0, "lock-space 3x1",
          "exercised three-way victim resolution");
}

}  // namespace

int main() {
  try {
    test_edge_space_exhaustive();
    test_larger_graph_differential_stress();
    test_lock_event_space_exhaustive();
    test_three_way_event_space_exhaustive();
  } catch (const std::exception& error) {
    std::cerr << "FAILED: " << error.what() << "\n";
    return 1;
  }
  std::cout << "exhaustive tests passed\n";
  return 0;
}
