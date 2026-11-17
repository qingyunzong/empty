#pragma once

// dlks_formal: an embeddable, header-only wait-for graph and the lock-manager
// lifecycle that feeds it.
//
// The component is deliberately single-threaded and allocation-based: callers
// serialize lock-manager events, and every public mutation is one atomic step
// from the caller's point of view (queries cannot observe a half-applied
// grant, cancellation, timeout, or release).

#include <algorithm>
#include <compare>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <iterator>
#include <limits>
#include <map>
#include <optional>
#include <set>
#include <stdexcept>
#include <utility>
#include <vector>

namespace dlks_formal {

using TransactionId = std::uint64_t;
using ResourceId = std::uint64_t;
using RequestId = std::uint64_t;
using Tick = std::uint64_t;

enum class LockMode : std::uint8_t {
  shared = 0,
  exclusive = 1,
};

enum class RequestKind : std::uint8_t {
  regular = 0,
  upgrade = 1,
};

struct TransactionProfile {
  // Victim order is (cost ascending, age descending, transaction id ascending).
  // A lower cost makes a transaction cheaper to abort.
  std::uint64_t cost = 0;
  // Age at tick `now` is `now - born` (zero if the clock moved backwards).
  Tick born = 0;

  friend bool operator==(const TransactionProfile&, const TransactionProfile&) = default;
};

// One logical wait-for edge. Several edges may connect the same pair of
// transactions when different requests/resources block the same waiter.
struct WaitEdge {
  TransactionId waiter = 0;
  TransactionId holder = 0;
  ResourceId resource = 0;
  RequestId request = 0;

  auto operator<=>(const WaitEdge&) const = default;
};

struct PendingRequest {
  RequestId id = 0;
  TransactionId tx = 0;
  ResourceId resource = 0;
  LockMode mode = LockMode::shared;
  RequestKind kind = RequestKind::regular;
  std::optional<Tick> deadline;

  friend bool operator==(const PendingRequest&, const PendingRequest&) = default;
};

struct DeadlockCycle {
  // Sorted strongly-connected component; size > 1 or a self-loop.
  std::vector<TransactionId> members;
  // The one victim selected for this component.
  TransactionId victim = 0;

  friend bool operator==(const DeadlockCycle&, const DeadlockCycle&) = default;
};

struct DeadlockAnalysis {
  // Every SCC, each sorted, and the outer list sorted lexicographically.
  std::vector<std::vector<TransactionId>> components;
  // Cyclic SCCs, sorted by member list.
  std::vector<DeadlockCycle> cycles;

  friend bool operator==(const DeadlockAnalysis&, const DeadlockAnalysis&) = default;
};

class WaitForGraph {
 public:
  using Component = std::vector<TransactionId>;

  bool add_transaction(TransactionId tx, TransactionProfile profile = {}) {
    if (vertices_.contains(tx)) {
      return false;
    }
    VertexState state;
    state.profile = profile;
    vertices_.emplace(tx, std::move(state));
    create_component({tx});
    return true;
  }

  bool remove_transaction(TransactionId tx) {
    auto vertex_it = vertices_.find(tx);
    if (vertex_it == vertices_.end()) {
      return false;
    }

    std::vector<WaitEdge> incident;
    for (const WaitEdge& edge : edges_) {
      if (edge.waiter == tx || edge.holder == tx) {
        incident.push_back(edge);
      }
    }
    for (const WaitEdge& edge : incident) {
      (void)remove_edge(edge);
    }

    const auto component_it = scc_of_.find(tx);
    if (component_it != scc_of_.end()) {
      const SccId component = component_it->second;
      auto& members = scc_members_.at(component);
      members.erase(tx);
      const std::set<TransactionId> remaining = members;
      scc_of_.erase(component_it);
      vertices_.erase(vertex_it);
      if (remaining.empty()) {
        detach_component(component);
      } else {
        // An incident-edge removal normally already splits this component.
        // Recompute the remainder as a defensive measure for malformed or
        // partially-removed input.
        split_component(component, remaining);
      }
      return true;
    }
    vertices_.erase(vertex_it);
    return true;
  }

  bool has_transaction(TransactionId tx) const noexcept {
    return vertices_.contains(tx);
  }

  bool set_profile(TransactionId tx, TransactionProfile profile) {
    auto it = vertices_.find(tx);
    if (it == vertices_.end()) {
      return false;
    }
    it->second.profile = profile;
    return true;
  }

  std::optional<TransactionProfile> profile(TransactionId tx) const {
    const auto it = vertices_.find(tx);
    if (it == vertices_.end()) {
      return std::nullopt;
    }
    return it->second.profile;
  }

  bool add_edge(const WaitEdge& edge) {
    require_vertex(edge.waiter);
    require_vertex(edge.holder);
    if (edges_.contains(edge)) {
      return false;
    }

    insert_raw_edge(edge);
    const SccId waiter_component = scc_of_.at(edge.waiter);
    const SccId holder_component = scc_of_.at(edge.holder);
    if (waiter_component == holder_component) {
      return true;
    }

    add_condensation_edge(waiter_component, holder_component);
    if (!reachable(holder_component, waiter_component)) {
      return true;
    }

    // The new edge closes at least one cycle in the condensation DAG. Every
    // SCC that lies on a path from holder to waiter must be collapsed.
    const std::set<SccId> from_holder = forward_reachable(holder_component);
    const std::set<SccId> to_waiter = backward_reachable(waiter_component);
    std::set<SccId> merged;
    std::set_intersection(from_holder.begin(), from_holder.end(), to_waiter.begin(),
                          to_waiter.end(),
                          std::inserter(merged, merged.end()));
    merged.insert(waiter_component);
    merged.insert(holder_component);
    merge_components(merged);
    return true;
  }

  bool remove_edge(const WaitEdge& edge) {
    const auto edge_it = edges_.find(edge);
    if (edge_it == edges_.end()) {
      return false;
    }

    const SccId waiter_component = scc_of_.at(edge.waiter);
    const SccId holder_component = scc_of_.at(edge.holder);
    const bool intra_component = waiter_component == holder_component;
    std::set<TransactionId> affected_members;
    if (intra_component) {
      affected_members = scc_members_.at(waiter_component);
    }

    erase_raw_edge(edge);
    if (!intra_component) {
      remove_condensation_edge(waiter_component, holder_component);
      return true;
    }

    // Removing any edge inside an SCC can split it. Recomputing just that
    // component keeps the operation incremental without guessing at paths.
    split_component(waiter_component, affected_members);
    return true;
  }

  // Applies a set of edge deletions and insertions as one logical step. All
  // endpoint preconditions are checked before the first mutation. Removal is
  // performed before insertion, so an edge that appears in both lists ends up
  // present exactly once.
  void apply_delta(const std::vector<WaitEdge>& removals,
                   const std::vector<WaitEdge>& additions) {
    for (const WaitEdge& edge : additions) {
      require_vertex(edge.waiter);
      require_vertex(edge.holder);
    }
    for (const WaitEdge& edge : removals) {
      (void)remove_edge(edge);
    }
    for (const WaitEdge& edge : additions) {
      (void)add_edge(edge);
    }
  }

  bool has_edge(const WaitEdge& edge) const noexcept {
    return edges_.contains(edge);
  }

  std::size_t edge_count() const noexcept {
    return edges_.size();
  }

  const std::set<WaitEdge>& edges() const noexcept {
    return edges_;
  }

  std::vector<WaitEdge> edges_for_request(RequestId request) const {
    std::vector<WaitEdge> result;
    const auto it = request_edges_.find(request);
    if (it != request_edges_.end()) {
      result.assign(it->second.begin(), it->second.end());
    }
    return result;
  }

  // Victim order: lower cost, then greater age (older), then lower id.
  static bool victim_before(TransactionId lhs, const TransactionProfile& lhs_profile,
                            TransactionId rhs, const TransactionProfile& rhs_profile,
                            Tick now) noexcept {
    if (lhs_profile.cost != rhs_profile.cost) {
      return lhs_profile.cost < rhs_profile.cost;
    }
    const Tick lhs_age = now >= lhs_profile.born ? now - lhs_profile.born : 0;
    const Tick rhs_age = now >= rhs_profile.born ? now - rhs_profile.born : 0;
    if (lhs_age != rhs_age) {
      return lhs_age > rhs_age;
    }
    return lhs < rhs;
  }

  std::optional<TransactionId> select_victim(const Component& component,
                                             Tick now = 0) const {
    std::optional<TransactionId> victim;
    std::optional<TransactionProfile> victim_profile;
    for (const TransactionId tx : component) {
      const auto it = vertices_.find(tx);
      if (it == vertices_.end()) {
        continue;
      }
      if (!victim.has_value() ||
          victim_before(tx, it->second.profile, *victim, *victim_profile, now)) {
        victim = tx;
        victim_profile = it->second.profile;
      }
    }
    return victim;
  }

  DeadlockAnalysis analyze(Tick now = 0) const {
    DeadlockAnalysis result;
    result.components.reserve(scc_members_.size());
    for (const auto& [component_id, members] : scc_members_) {
      (void)component_id;
      Component component(members.begin(), members.end());
      result.components.push_back(component);

      bool cyclic = component.size() > 1;
      if (!cyclic && component.size() == 1) {
        const auto vertex_it = vertices_.find(component.front());
        cyclic = vertex_it != vertices_.end() &&
                 vertex_it->second.out.contains(component.front());
      }
      if (cyclic) {
        const auto victim = select_victim(component, now);
        if (victim.has_value()) {
          result.cycles.push_back(DeadlockCycle{std::move(component), *victim});
        }
      }
    }

    std::sort(result.components.begin(), result.components.end());
    std::sort(result.cycles.begin(), result.cycles.end(),
              [](const DeadlockCycle& lhs, const DeadlockCycle& rhs) {
                return lhs.members < rhs.members;
              });
    return result;
  }

  // Structural checks useful in tests and debug builds.
  void assert_invariants() const {
    std::set<TransactionId> represented;
    for (const auto& [component_id, members] : scc_members_) {
      if (members.empty()) {
        throw std::logic_error("empty SCC");
      }
      for (const TransactionId tx : members) {
        const auto vertex_it = vertices_.find(tx);
        if (vertex_it == vertices_.end()) {
          throw std::logic_error("SCC contains unknown transaction");
        }
        const auto scc_it = scc_of_.find(tx);
        if (scc_it == scc_of_.end() || scc_it->second != component_id) {
          throw std::logic_error("SCC membership mismatch");
        }
        if (!represented.insert(tx).second) {
          throw std::logic_error("transaction in several SCCs");
        }
      }
    }
    if (represented.size() != vertices_.size()) {
      throw std::logic_error("vertex missing from SCC partition");
    }

    std::map<std::pair<SccId, SccId>, std::size_t> expected_out;
    for (const auto& [tx, vertex] : vertices_) {
      for (const auto& [neighbor, count] : vertex.out) {
        if (count == 0 || !vertices_.contains(neighbor)) {
          throw std::logic_error("invalid outgoing adjacency");
        }
        if (scc_of_.at(tx) != scc_of_.at(neighbor)) {
          expected_out[{scc_of_.at(tx), scc_of_.at(neighbor)}] += count;
        }
      }
      for (const auto& [neighbor, count] : vertex.in) {
        if (count == 0 || !vertices_.contains(neighbor)) {
          throw std::logic_error("invalid incoming adjacency");
        }
      }
    }

    for (const auto& [pair, count] : expected_out) {
      if (pair.first == pair.second) {
        throw std::logic_error("condensation self-edge");
      }
      const auto out_it = condensation_out_.find(pair.first);
      if (out_it == condensation_out_.end() ||
          out_it->second.find(pair.second) == out_it->second.end() ||
          out_it->second.at(pair.second) != count) {
        throw std::logic_error("condensation out-edge mismatch");
      }
    }
    std::size_t actual_condensation_edges = 0;
    for (const auto& [source, targets] : condensation_out_) {
      for (const auto& [target, count] : targets) {
        if (count == 0) {
          throw std::logic_error("zero-weight condensation edge");
        }
        if (source == target) {
          throw std::logic_error("condensation self-edge");
        }
        ++actual_condensation_edges;
        const auto in_it = condensation_in_.find(target);
        if (in_it == condensation_in_.end() ||
            in_it->second.find(source) == in_it->second.end() ||
            in_it->second.at(source) != count) {
          throw std::logic_error("condensation reverse-edge mismatch");
        }
      }
    }
    if (actual_condensation_edges != expected_out.size()) {
      throw std::logic_error("stale condensation edge");
    }

    std::map<RequestId, std::set<WaitEdge>> expected_request_edges;
    for (const WaitEdge& edge : edges_) {
      const auto vertex_it = vertices_.find(edge.waiter);
      if (vertex_it == vertices_.end() ||
          !vertices_.contains(edge.holder)) {
        throw std::logic_error("edge endpoint missing");
      }
      if (vertex_it->second.out.find(edge.holder) ==
          vertex_it->second.out.end()) {
        throw std::logic_error("edge missing from adjacency");
      }
      expected_request_edges[edge.request].insert(edge);
    }
    if (expected_request_edges != request_edges_) {
      throw std::logic_error("request edge index mismatch");
    }
  }

 private:
  using SccId = std::uint64_t;

  struct VertexState {
    TransactionProfile profile;
    std::map<TransactionId, std::size_t> out;
    std::map<TransactionId, std::size_t> in;
  };

  void require_vertex(TransactionId tx) const {
    if (!vertices_.contains(tx)) {
      throw std::out_of_range("unknown transaction");
    }
  }

  void insert_raw_edge(const WaitEdge& edge) {
    if (!edges_.insert(edge).second) {
      return;
    }
    ++vertices_.at(edge.waiter).out[edge.holder];
    ++vertices_.at(edge.holder).in[edge.waiter];
    request_edges_[edge.request].insert(edge);
  }

  void erase_raw_edge(const WaitEdge& edge) {
    if (edges_.erase(edge) == 0) {
      return;
    }
    auto waiter_it = vertices_.find(edge.waiter);
    if (waiter_it != vertices_.end()) {
      auto out_it = waiter_it->second.out.find(edge.holder);
      if (out_it != waiter_it->second.out.end()) {
        if (--out_it->second == 0) {
          waiter_it->second.out.erase(out_it);
        }
      }
    }
    auto holder_it = vertices_.find(edge.holder);
    if (holder_it != vertices_.end()) {
      auto in_it = holder_it->second.in.find(edge.waiter);
      if (in_it != holder_it->second.in.end()) {
        if (--in_it->second == 0) {
          holder_it->second.in.erase(in_it);
        }
      }
    }
    auto request_it = request_edges_.find(edge.request);
    if (request_it != request_edges_.end()) {
      request_it->second.erase(edge);
      if (request_it->second.empty()) {
        request_edges_.erase(request_it);
      }
    }
  }

  SccId create_component(const std::set<TransactionId>& members) {
    const SccId id = next_component_++;
    auto& stored = scc_members_[id];
    stored = members;
    for (const TransactionId tx : members) {
      scc_of_[tx] = id;
    }
    return id;
  }

  void detach_component(SccId component) {
    auto out_it = condensation_out_.find(component);
    if (out_it != condensation_out_.end()) {
      for (const auto& [target, count] : out_it->second) {
        (void)count;
        auto in_it = condensation_in_.find(target);
        if (in_it != condensation_in_.end()) {
          in_it->second.erase(component);
          if (in_it->second.empty()) {
            condensation_in_.erase(in_it);
          }
        }
      }
      condensation_out_.erase(out_it);
    }

    auto in_it = condensation_in_.find(component);
    if (in_it != condensation_in_.end()) {
      for (const auto& [source, count] : in_it->second) {
        (void)count;
        auto source_it = condensation_out_.find(source);
        if (source_it != condensation_out_.end()) {
          source_it->second.erase(component);
          if (source_it->second.empty()) {
            condensation_out_.erase(source_it);
          }
        }
      }
      condensation_in_.erase(in_it);
    }

    auto members_it = scc_members_.find(component);
    if (members_it != scc_members_.end()) {
      for (const TransactionId tx : members_it->second) {
        scc_of_.erase(tx);
      }
      scc_members_.erase(members_it);
    }
  }

  void add_condensation_edge(SccId source, SccId target,
                             std::size_t weight = 1) {
    if (source == target) {
      return;
    }
    condensation_out_[source][target] += weight;
    condensation_in_[target][source] += weight;
  }

  void remove_condensation_edge(SccId source, SccId target) {
    if (source == target) {
      return;
    }
    auto out_it = condensation_out_.find(source);
    if (out_it == condensation_out_.end()) {
      return;
    }
    auto target_it = out_it->second.find(target);
    if (target_it == out_it->second.end()) {
      return;
    }
    if (--target_it->second == 0) {
      out_it->second.erase(target_it);
      if (out_it->second.empty()) {
        condensation_out_.erase(out_it);
      }
    }

    auto in_it = condensation_in_.find(target);
    if (in_it != condensation_in_.end()) {
      auto source_it = in_it->second.find(source);
      if (source_it != in_it->second.end()) {
        if (--source_it->second == 0) {
          in_it->second.erase(source_it);
          if (in_it->second.empty()) {
            condensation_in_.erase(in_it);
          }
        }
      }
    }
  }

  bool reachable(SccId from, SccId to) const {
    if (from == to) {
      return true;
    }
    std::set<SccId> seen;
    std::vector<SccId> pending{from};
    while (!pending.empty()) {
      const SccId current = pending.back();
      pending.pop_back();
      if (current == to) {
        return true;
      }
      if (!seen.insert(current).second) {
        continue;
      }
      const auto it = condensation_out_.find(current);
      if (it == condensation_out_.end()) {
        continue;
      }
      for (const auto& [next, count] : it->second) {
        (void)count;
        if (!seen.contains(next)) {
          pending.push_back(next);
        }
      }
    }
    return false;
  }

  std::set<SccId> forward_reachable(SccId start) const {
    std::set<SccId> seen;
    std::vector<SccId> pending{start};
    while (!pending.empty()) {
      const SccId current = pending.back();
      pending.pop_back();
      if (!seen.insert(current).second) {
        continue;
      }
      const auto it = condensation_out_.find(current);
      if (it == condensation_out_.end()) {
        continue;
      }
      for (const auto& [next, count] : it->second) {
        (void)count;
        if (!seen.contains(next)) {
          pending.push_back(next);
        }
      }
    }
    return seen;
  }

  std::set<SccId> backward_reachable(SccId start) const {
    std::set<SccId> seen;
    std::vector<SccId> pending{start};
    while (!pending.empty()) {
      const SccId current = pending.back();
      pending.pop_back();
      if (!seen.insert(current).second) {
        continue;
      }
      const auto it = condensation_in_.find(current);
      if (it == condensation_in_.end()) {
        continue;
      }
      for (const auto& [previous, count] : it->second) {
        (void)count;
        if (!seen.contains(previous)) {
          pending.push_back(previous);
        }
      }
    }
    return seen;
  }

  void merge_components(const std::set<SccId>& components) {
    std::set<TransactionId> members;
    for (const SccId component : components) {
      const auto it = scc_members_.find(component);
      if (it != scc_members_.end()) {
        members.insert(it->second.begin(), it->second.end());
      }
    }
    if (members.empty()) {
      return;
    }

    for (const SccId component : components) {
      detach_component(component);
    }
    const SccId merged = create_component(members);

    for (const TransactionId tx : members) {
      for (const auto& [neighbor, count] : vertices_.at(tx).out) {
        if (!members.contains(neighbor)) {
          add_condensation_edge(merged, scc_of_.at(neighbor), count);
        }
      }
      for (const auto& [neighbor, count] : vertices_.at(tx).in) {
        if (!members.contains(neighbor)) {
          add_condensation_edge(scc_of_.at(neighbor), merged, count);
        }
      }
    }
  }

  std::vector<std::vector<TransactionId>> tarjan_subset(
      const std::set<TransactionId>& members) const {
    std::map<TransactionId, std::size_t> index;
    std::map<TransactionId, std::size_t> low;
    std::set<TransactionId> on_stack;
    std::vector<TransactionId> stack;
    std::vector<std::vector<TransactionId>> components;
    std::size_t next_index = 0;

    std::function<void(TransactionId)> visit = [&](TransactionId tx) {
      index[tx] = next_index;
      low[tx] = next_index;
      ++next_index;
      stack.push_back(tx);
      on_stack.insert(tx);

      for (const auto& [neighbor, count] : vertices_.at(tx).out) {
        (void)count;
        if (!members.contains(neighbor)) {
          continue;
        }
        if (!index.contains(neighbor)) {
          visit(neighbor);
          low[tx] = std::min(low[tx], low[neighbor]);
        } else if (on_stack.contains(neighbor)) {
          low[tx] = std::min(low[tx], index[neighbor]);
        }
      }

      if (low[tx] == index[tx]) {
        std::vector<TransactionId> component;
        for (;;) {
          const TransactionId member = stack.back();
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

    for (const TransactionId tx : members) {
      if (!index.contains(tx)) {
        visit(tx);
      }
    }
    std::sort(components.begin(), components.end());
    return components;
  }

  void split_component(SccId old_component,
                       const std::set<TransactionId>& members) {
    const auto components = tarjan_subset(members);
    detach_component(old_component);

    std::map<TransactionId, SccId> new_component_of;
    for (const auto& component : components) {
      const std::set<TransactionId> component_set(component.begin(),
                                                  component.end());
      const SccId new_component = create_component(component_set);
      for (const TransactionId tx : component) {
        new_component_of[tx] = new_component;
      }
    }

    // Re-create all outgoing condensation edges from the affected vertices and
    // all incoming edges that originate outside the old component.
    for (const TransactionId tx : members) {
      for (const auto& [neighbor, count] : vertices_.at(tx).out) {
        const SccId source = new_component_of.at(tx);
        const SccId target = scc_of_.at(neighbor);
        if (source != target) {
          add_condensation_edge(source, target, count);
        }
      }
      for (const auto& [neighbor, count] : vertices_.at(tx).in) {
        if (members.contains(neighbor)) {
          continue;
        }
        add_condensation_edge(scc_of_.at(neighbor), new_component_of.at(tx),
                              count);
      }
    }
  }

  std::map<TransactionId, VertexState> vertices_;
  std::set<WaitEdge> edges_;
  std::map<RequestId, std::set<WaitEdge>> request_edges_;

  SccId next_component_ = 1;
  std::map<TransactionId, SccId> scc_of_;
  std::map<SccId, std::set<TransactionId>> scc_members_;
  // Parallel edges are counted so removing one of several edges between the
  // same SCC pair does not remove the condensation edge.
  std::map<SccId, std::map<SccId, std::size_t>> condensation_out_;
  std::map<SccId, std::map<SccId, std::size_t>> condensation_in_;
};

class LockManager {
 public:
  struct AcquireResult {
    RequestId id = 0;
    bool granted = false;
  };

  bool begin(TransactionId tx, std::uint64_t cost = 0) {
    if (transactions_.contains(tx)) {
      return false;
    }
    TxState state;
    state.profile = TransactionProfile{cost, now_};
    transactions_.emplace(tx, state);
    graph_.add_transaction(tx, state.profile);
    return true;
  }

  bool contains(TransactionId tx) const noexcept {
    return transactions_.contains(tx);
  }

  AcquireResult acquire(TransactionId tx, ResourceId resource, LockMode mode,
                        std::optional<Tick> deadline = std::nullopt) {
    const auto tx_it = transactions_.find(tx);
    if (tx_it == transactions_.end()) {
      throw std::invalid_argument("acquire from unknown transaction");
    }
    if (pending_by_tx_.contains(tx)) {
      throw std::logic_error("transaction already has a pending request");
    }
    if (deadline.has_value() && *deadline <= now_) {
      throw std::invalid_argument("request deadline is not in the future");
    }

    const auto held_it = held_.find(tx);
    const bool holds_resource =
        held_it != held_.end() && held_it->second.contains(resource);
    const LockMode held_mode =
        holds_resource ? held_it->second.at(resource) : LockMode::shared;

    // Idempotent re-acquisition does not create a request that could wait.
    if (holds_resource &&
        (held_mode == LockMode::exclusive || mode == LockMode::shared)) {
      return AcquireResult{next_request_++, true};
    }

    const RequestKind kind =
        holds_resource && held_mode == LockMode::shared &&
                mode == LockMode::exclusive
            ? RequestKind::upgrade
            : RequestKind::regular;
    const RequestId id = next_request_++;
    PendingRequest request;
    request.id = id;
    request.tx = tx;
    request.resource = resource;
    request.mode = mode;
    request.kind = kind;
    request.deadline = deadline;

    const auto queue_it = queues_.find(resource);
    const bool queue_empty =
        queue_it == queues_.end() || queue_it->second.empty();
    if (queue_empty && compatible(request)) {
      apply_grant(request);
      return AcquireResult{id, true};
    }

    pending_.emplace(id, request);
    pending_by_tx_.emplace(tx, id);
    queues_[resource].push_back(id);
    dirty_requests_.insert(id);
    commit_edges();
    return AcquireResult{id, false};
  }

  // Grants a compatible pending request. This is an administrative grant and
  // may pick a request behind the FIFO head; release/abort paths always pump
  // the queue head in order.
  bool grant(RequestId id) {
    const auto pending_it = pending_.find(id);
    if (pending_it == pending_.end()) {
      return false;
    }
    const PendingRequest request = pending_it->second;
    if (!compatible(request)) {
      return false;
    }

    detach_request(request);
    apply_grant(request);
    dirty_requests_.insert(id);
    mark_resource(request.resource);
    pump_resource(request.resource);
    commit_edges();
    return true;
  }

  bool grant_pending(TransactionId tx) {
    const auto it = pending_by_tx_.find(tx);
    return it != pending_by_tx_.end() && grant(it->second);
  }

  std::vector<RequestId> grant_ready(ResourceId resource) {
    const std::vector<RequestId> granted = pump_resource(resource);
    mark_resource(resource);
    commit_edges();
    return granted;
  }

  bool cancel(RequestId id) {
    const auto it = pending_.find(id);
    if (it == pending_.end()) {
      return false;
    }
    const PendingRequest request = it->second;
    detach_request(request);
    dirty_requests_.insert(id);
    mark_resource(request.resource);
    pump_resource(request.resource);
    commit_edges();
    return true;
  }

  bool cancel_pending(TransactionId tx) {
    const auto it = pending_by_tx_.find(tx);
    return it != pending_by_tx_.end() && cancel(it->second);
  }

  // Explicit timeout, independent of the request's deadline.
  bool timeout(RequestId id) {
    return cancel(id);
  }

  bool timeout_pending(TransactionId tx) {
    return cancel_pending(tx);
  }

  // Advances the clock and expires every overdue request before granting any
  // newly-unblocked request. The whole expiry wave is applied atomically.
  std::vector<RequestId> advance_time(Tick delta) {
    if (delta > std::numeric_limits<Tick>::max() - now_) {
      throw std::overflow_error("clock overflow");
    }
    now_ += delta;

    std::vector<PendingRequest> expired;
    for (const auto& [id, request] : pending_) {
      (void)id;
      if (request.deadline.has_value() && *request.deadline <= now_) {
        expired.push_back(request);
      }
    }
    std::sort(expired.begin(), expired.end(),
              [](const PendingRequest& lhs, const PendingRequest& rhs) {
                return lhs.id < rhs.id;
              });

    std::set<ResourceId> affected;
    std::vector<RequestId> expired_ids;
    for (const PendingRequest& request : expired) {
      detach_request(request);
      dirty_requests_.insert(request.id);
      affected.insert(request.resource);
      expired_ids.push_back(request.id);
    }
    for (const ResourceId resource : affected) {
      mark_resource(resource);
      pump_resource(resource);
    }
    commit_edges();
    return expired_ids;
  }

  std::vector<RequestId> advance_to(Tick target) {
    if (target < now_) {
      throw std::invalid_argument("clock cannot move backwards");
    }
    return advance_time(target - now_);
  }

  bool release(TransactionId tx, ResourceId resource) {
    const auto held_it = held_.find(tx);
    if (held_it == held_.end() || !held_it->second.contains(resource)) {
      return false;
    }
    held_it->second.erase(resource);
    if (held_it->second.empty()) {
      held_.erase(held_it);
    }
    auto holders_it = holders_.find(resource);
    if (holders_it != holders_.end()) {
      holders_it->second.erase(tx);
      if (holders_it->second.empty()) {
        holders_.erase(holders_it);
      }
    }

    mark_resource(resource);
    pump_resource(resource);
    commit_edges();
    return true;
  }

  bool release_all(TransactionId tx) {
    const auto held_it = held_.find(tx);
    if (held_it == held_.end()) {
      return transactions_.contains(tx);
    }
    const std::map<ResourceId, LockMode> held = held_it->second;
    for (const auto& [resource, mode] : held) {
      (void)mode;
      auto holders_it = holders_.find(resource);
      if (holders_it != holders_.end()) {
        holders_it->second.erase(tx);
        if (holders_it->second.empty()) {
          holders_.erase(holders_it);
        }
      }
      mark_resource(resource);
    }
    held_.erase(held_it);
    for (const auto& [resource, mode] : held) {
      (void)mode;
      pump_resource(resource);
    }
    commit_edges();
    return true;
  }

  bool end_transaction(TransactionId tx) {
    const auto tx_it = transactions_.find(tx);
    if (tx_it == transactions_.end()) {
      return false;
    }

    std::set<ResourceId> affected;
    const auto pending_it = pending_by_tx_.find(tx);
    if (pending_it != pending_by_tx_.end()) {
      const auto request_it = pending_.find(pending_it->second);
      if (request_it != pending_.end()) {
        const PendingRequest request = request_it->second;
        detach_request(request);
        dirty_requests_.insert(request.id);
        affected.insert(request.resource);
        mark_resource(request.resource);
      }
    }

    const auto held_it = held_.find(tx);
    if (held_it != held_.end()) {
      const std::map<ResourceId, LockMode> held = held_it->second;
      for (const auto& [resource, mode] : held) {
        (void)mode;
        auto holders_it = holders_.find(resource);
        if (holders_it != holders_.end()) {
          holders_it->second.erase(tx);
          if (holders_it->second.empty()) {
            holders_.erase(holders_it);
          }
        }
        affected.insert(resource);
        mark_resource(resource);
      }
      held_.erase(held_it);
    }

    for (const ResourceId resource : affected) {
      pump_resource(resource);
    }
    commit_edges();
    graph_.remove_transaction(tx);
    transactions_.erase(tx_it);
    return true;
  }

  bool abort_transaction(TransactionId tx) {
    return end_transaction(tx);
  }

  DeadlockAnalysis deadlock_analysis() const {
    return graph_.analyze(now_);
  }

  // Aborts one selected victim per cyclic SCC, then re-analyzes because a
  // grant triggered by the abort can add new holder edges. Every iteration
  // removes at least one transaction, so this terminates.
  std::vector<TransactionId> resolve_deadlocks() {
    std::vector<TransactionId> aborted;
    for (;;) {
      const DeadlockAnalysis analysis = graph_.analyze(now_);
      if (analysis.cycles.empty()) {
        break;
      }

      std::set<TransactionId> victims;
      for (const DeadlockCycle& cycle : analysis.cycles) {
        if (transactions_.contains(cycle.victim)) {
          victims.insert(cycle.victim);
        }
      }
      if (victims.empty()) {
        break;
      }
      for (const TransactionId victim : victims) {
        if (end_transaction(victim)) {
          aborted.push_back(victim);
        }
      }
    }
    return aborted;
  }

  const WaitForGraph& graph() const noexcept {
    return graph_;
  }

  Tick now() const noexcept {
    return now_;
  }

  std::vector<TransactionId> transactions() const {
    std::vector<TransactionId> result;
    result.reserve(transactions_.size());
    for (const auto& [tx, state] : transactions_) {
      (void)state;
      result.push_back(tx);
    }
    return result;
  }

  std::optional<TransactionProfile> transaction_profile(
      TransactionId tx) const {
    const auto it = transactions_.find(tx);
    if (it == transactions_.end()) {
      return std::nullopt;
    }
    return it->second.profile;
  }

  std::vector<ResourceId> resources() const {
    std::set<ResourceId> result;
    for (const auto& [resource, holders] : holders_) {
      (void)holders;
      result.insert(resource);
    }
    for (const auto& [resource, queue] : queues_) {
      if (!queue.empty()) {
        result.insert(resource);
      }
    }
    return std::vector<ResourceId>(result.begin(), result.end());
  }

  std::map<TransactionId, LockMode> holders(ResourceId resource) const {
    const auto it = holders_.find(resource);
    if (it == holders_.end()) {
      return {};
    }
    return it->second;
  }

  std::vector<std::pair<ResourceId, LockMode>> held_locks(
      TransactionId tx) const {
    std::vector<std::pair<ResourceId, LockMode>> result;
    const auto it = held_.find(tx);
    if (it == held_.end()) {
      return result;
    }
    result.assign(it->second.begin(), it->second.end());
    return result;
  }

  std::vector<PendingRequest> pending_requests() const {
    std::vector<PendingRequest> result;
    result.reserve(pending_.size());
    for (const auto& [id, request] : pending_) {
      (void)id;
      result.push_back(request);
    }
    return result;
  }

  std::optional<PendingRequest> pending_for(TransactionId tx) const {
    const auto it = pending_by_tx_.find(tx);
    if (it == pending_by_tx_.end()) {
      return std::nullopt;
    }
    return pending_.at(it->second);
  }

  std::optional<PendingRequest> pending(RequestId id) const {
    const auto it = pending_.find(id);
    if (it == pending_.end()) {
      return std::nullopt;
    }
    return it->second;
  }

  std::vector<RequestId> queue(ResourceId resource) const {
    const auto it = queues_.find(resource);
    if (it == queues_.end()) {
      return {};
    }
    return std::vector<RequestId>(it->second.begin(), it->second.end());
  }

  void assert_invariants() const {
    for (const auto& [tx, held] : held_) {
      if (!transactions_.contains(tx)) {
        throw std::logic_error("held lock for unknown transaction");
      }
      for (const auto& [resource, mode] : held) {
        const auto holders_it = holders_.find(resource);
        if (holders_it == holders_.end() ||
            !holders_it->second.contains(tx) ||
            holders_it->second.at(tx) != mode) {
          throw std::logic_error("holder index mismatch");
        }
      }
    }
    for (const auto& [resource, holders] : holders_) {
      for (const auto& [tx, mode] : holders) {
        const auto held_it = held_.find(tx);
        if (held_it == held_.end() ||
            !held_it->second.contains(resource) ||
            held_it->second.at(resource) != mode) {
          throw std::logic_error("lock ownership mismatch");
        }
      }
    }

    std::set<RequestId> queued;
    for (const auto& [resource, queue] : queues_) {
      for (const RequestId id : queue) {
        if (!queued.insert(id).second) {
          throw std::logic_error("request queued twice");
        }
        const auto pending_it = pending_.find(id);
        if (pending_it == pending_.end() ||
            pending_it->second.resource != resource) {
          throw std::logic_error("queue contains unknown request");
        }
      }
    }
    if (queued.size() != pending_.size()) {
      throw std::logic_error("pending request missing from queue");
    }

    for (const auto& [id, request] : pending_) {
      if (!transactions_.contains(request.tx)) {
        throw std::logic_error("pending request for unknown transaction");
      }
      const auto tx_it = pending_by_tx_.find(request.tx);
      if (tx_it == pending_by_tx_.end() || tx_it->second != id) {
        throw std::logic_error("pending request index mismatch");
      }
      if (request.deadline.has_value() && *request.deadline <= now_) {
        throw std::logic_error("overdue request was not expired");
      }

      std::set<WaitEdge> expected;
      const auto holders_it = holders_.find(request.resource);
      if (holders_it != holders_.end()) {
        for (const auto& [holder, mode] : holders_it->second) {
          if (holder != request.tx && conflicts(request.mode, mode)) {
            expected.insert(
                WaitEdge{request.tx, holder, request.resource, id});
          }
        }
      }
      const std::vector<WaitEdge> actual = graph_.edges_for_request(id);
      if (std::set<WaitEdge>(actual.begin(), actual.end()) != expected) {
        throw std::logic_error("wait-for edges do not match lock tables");
      }
    }
    graph_.assert_invariants();
  }

 private:
  struct TxState {
    TransactionProfile profile;
  };

  static bool conflicts(LockMode requested, LockMode holder) noexcept {
    return requested == LockMode::exclusive || holder == LockMode::exclusive;
  }

  bool compatible(const PendingRequest& request) const {
    const auto it = holders_.find(request.resource);
    if (it == holders_.end()) {
      return true;
    }
    for (const auto& [holder, mode] : it->second) {
      if (holder != request.tx && conflicts(request.mode, mode)) {
        return false;
      }
    }
    return true;
  }

  std::set<WaitEdge> blockers(const PendingRequest& request) const {
    std::set<WaitEdge> result;
    const auto it = holders_.find(request.resource);
    if (it == holders_.end()) {
      return result;
    }
    for (const auto& [holder, mode] : it->second) {
      if (holder != request.tx && conflicts(request.mode, mode)) {
        result.insert(
            WaitEdge{request.tx, holder, request.resource, request.id});
      }
    }
    return result;
  }

  void apply_grant(const PendingRequest& request) {
    holders_[request.resource][request.tx] = request.mode;
    held_[request.tx][request.resource] = request.mode;
  }

  void detach_request(const PendingRequest& request) {
    pending_.erase(request.id);
    pending_by_tx_.erase(request.tx);
    auto queue_it = queues_.find(request.resource);
    if (queue_it != queues_.end()) {
      auto& queue = queue_it->second;
      const auto request_it = std::find(queue.begin(), queue.end(), request.id);
      if (request_it != queue.end()) {
        queue.erase(request_it);
      }
      if (queue.empty()) {
        queues_.erase(queue_it);
      }
    }
  }

  std::vector<RequestId> pump_resource(ResourceId resource) {
    std::vector<RequestId> granted;
    auto queue_it = queues_.find(resource);
    if (queue_it == queues_.end()) {
      return granted;
    }

    while (!queue_it->second.empty()) {
      const RequestId id = queue_it->second.front();
      const auto pending_it = pending_.find(id);
      if (pending_it == pending_.end()) {
        queue_it->second.pop_front();
        continue;
      }
      const PendingRequest request = pending_it->second;
      if (!compatible(request)) {
        break;
      }

      queue_it->second.pop_front();
      pending_.erase(id);
      pending_by_tx_.erase(request.tx);
      apply_grant(request);
      dirty_requests_.insert(id);
      granted.push_back(id);
    }
    if (queue_it->second.empty()) {
      queues_.erase(queue_it);
    }
    return granted;
  }

  void mark_resource(ResourceId resource) {
    const auto it = queues_.find(resource);
    if (it == queues_.end()) {
      return;
    }
    for (const RequestId id : it->second) {
      dirty_requests_.insert(id);
    }
  }

  void commit_edges() {
    std::vector<WaitEdge> removals;
    std::vector<WaitEdge> additions;
    for (const RequestId id : dirty_requests_) {
      std::set<WaitEdge> desired;
      const auto pending_it = pending_.find(id);
      if (pending_it != pending_.end()) {
        desired = blockers(pending_it->second);
      }

      std::set<WaitEdge> current;
      for (const WaitEdge& edge : graph_.edges_for_request(id)) {
        current.insert(edge);
      }
      for (const WaitEdge& edge : current) {
        if (!desired.contains(edge)) {
          removals.push_back(edge);
        }
      }
      for (const WaitEdge& edge : desired) {
        if (!current.contains(edge)) {
          additions.push_back(edge);
        }
      }
    }
    dirty_requests_.clear();
    graph_.apply_delta(removals, additions);
  }

  WaitForGraph graph_;
  Tick now_ = 0;
  RequestId next_request_ = 1;
  std::map<TransactionId, TxState> transactions_;
  std::map<ResourceId, std::map<TransactionId, LockMode>> holders_;
  std::map<TransactionId, std::map<ResourceId, LockMode>> held_;
  std::map<RequestId, PendingRequest> pending_;
  std::map<TransactionId, RequestId> pending_by_tx_;
  std::map<ResourceId, std::deque<RequestId>> queues_;
  std::set<RequestId> dirty_requests_;
};

}  // namespace dlks_formal
