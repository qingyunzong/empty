#include "simulator.hpp"

#include <algorithm>

namespace netsim {

void Simulator::add_link(LinkId id, std::uint64_t bytes_per_tick) {
  if (!links_.try_emplace(id, LinkState{bytes_per_tick, {}}).second)
    throw std::invalid_argument("duplicate link id");
}

void Simulator::add_flow(FlowId id, std::vector<LinkId> path,
                         std::uint64_t size_bytes) {
  if (path.empty())
    throw std::invalid_argument("flow path must not be empty");
  for (LinkId link : path)
    if (links_.find(link) == links_.end())
      throw std::invalid_argument("flow path references unknown link");
  FlowState state{std::move(path), size_bytes, now_ + 1, false, false, 0, 0};
  if (!flows_.try_emplace(id, std::move(state)).second)
    throw std::invalid_argument("duplicate flow id");
  pending_activation_[now_ + 1].push_back(id);
}

void Simulator::cancel_flow(FlowId id) {
  auto it = flows_.find(id);
  if (it == flows_.end())
    throw std::invalid_argument("cancel of unknown flow");
  FlowState& flow = it->second;
  if (flow.cancelled)
    return;
  flow.cancelled = true;

  std::uint64_t count = 0;
  std::uint64_t first_index = 0;
  if (!flow.activated) {
    count = flow.size; // never entered the network
  } else {
    // Bytes that never crossed the first hop are unsent: revoke exactly those.
    // They sit in the first link's queue tagged hop==0; bytes of this flow
    // queued there on a later hop (repeated link in path) are in flight and
    // must survive the cancellation.
    count = flow.size - flow.left_source;
    first_index = flow.left_source;
    LinkState& first_link = links_.at(flow.path.front());
    auto qit = first_link.by_flow.find(id);
    if (qit != first_link.by_flow.end()) {
      std::deque<QueuedByte>& queue = qit->second;
      queue.erase(std::remove_if(queue.begin(), queue.end(),
                                 [](const QueuedByte& b) { return b.hop == 0; }),
                  queue.end());
      if (queue.empty())
        first_link.by_flow.erase(qit);
    }
  }
  flow.revoked = count;
  if (count > 0)
    revocations_.push_back(Revocation{now_, id, first_index, count});
}

void Simulator::step() {
  const Tick tick = now_;

  // Flows added at tick-1 join this round: their bytes become ready at the
  // head-of-path link.
  if (auto it = pending_activation_.find(tick); it != pending_activation_.end()) {
    for (FlowId id : it->second) {
      FlowState& flow = flows_.at(id);
      if (flow.cancelled)
        continue;
      flow.activated = true;
      std::deque<QueuedByte>& queue =
          links_.at(flow.path.front()).by_flow[id];
      for (std::uint64_t i = 0; i < flow.size; ++i)
        queue.push_back(QueuedByte{i, tick, 0});
    }
    pending_activation_.erase(it);
  }

  // Schedule every link, in link-ID order for determinism. A byte forwarded
  // at this tick is stamped available=tick+1 on the next hop, so the order in
  // which links are processed within the tick cannot change the outcome.
  for (auto& [link_id, link] : links_) {
    std::uint64_t remaining = link.capacity;
    while (remaining > 0) {
      bool progressed = false;
      for (auto fit = link.by_flow.begin();
           fit != link.by_flow.end() && remaining > 0;) {
        std::deque<QueuedByte>& queue = fit->second;
        if (queue.empty() || queue.front().available > tick) {
          ++fit;
          continue;
        }
        const QueuedByte byte = queue.front();
        queue.pop_front();
        --remaining;
        progressed = true;

        FlowState& flow = flows_.at(fit->first);
        if (byte.hop == 0)
          ++flow.left_source;
        const bool final_hop = (byte.hop + 1 == flow.path.size());
        transmissions_.push_back(
            Transmission{tick, fit->first, byte.index, link_id, final_hop});
        if (final_hop) {
          ++flow.delivered;
        } else {
          links_.at(flow.path[byte.hop + 1])
              .by_flow[fit->first]
              .push_back(QueuedByte{byte.index, tick + 1, byte.hop + 1});
        }
        fit = queue.empty() ? link.by_flow.erase(fit) : std::next(fit);
      }
      if (!progressed)
        break;
    }
  }

  ++now_;
}

FlowAccount Simulator::account(FlowId id) const {
  const FlowState& flow = flows_.at(id);
  FlowAccount account;
  account.size = flow.size;
  account.delivered = flow.delivered;
  account.revoked = flow.revoked;
  account.unsent = flow.size - flow.left_source - flow.revoked;
  account.in_flight = flow.left_source - flow.delivered;
  return account;
}

FlowAccount Simulator::total_account() const {
  FlowAccount total;
  for (const auto& [id, flow] : flows_)
    total += account(id);
  return total;
}

} // namespace netsim
