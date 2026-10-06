#pragma once

// Independent byte-by-byte reference model used to cross-check netsim::Simulator.
// It is deliberately implemented in a different style: every byte is an
// explicit object with its own stage, and scheduling scans per-byte state
// instead of per-flow queues. Same spec, separate code path.

#include "simulator.hpp"

#include <algorithm>
#include <map>
#include <stdexcept>
#include <vector>

namespace netsim::reference {

class ReferenceModel {
public:
  void add_link(LinkId id, std::uint64_t bytes_per_tick) {
    capacities_[id] = bytes_per_tick;
  }

  void add_flow(FlowId id, std::vector<LinkId> path, std::uint64_t size) {
    flows_[id] = Flow{std::move(path), size, now_ + 1, false, false, 0};
  }

  void cancel_flow(FlowId id) {
    Flow& flow = flows_.at(id);
    if (flow.cancelled)
      return;
    flow.cancelled = true;
    // Revoke bytes that never left the source: not-yet-placed bytes and
    // bytes still waiting at the first hop.
    std::uint64_t count = 0;
    std::uint64_t first = 0;
    if (!flow.activated) {
      count = flow.size; // never entered the network
      flow.revoked_unplaced = count;
    } else {
      for (Byte& byte : bytes_)
        if (byte.flow == id && byte.stage == kAtSource) {
          if (count == 0)
            first = byte.index;
          byte.stage = kRevoked;
          ++count;
        }
    }
    if (count > 0)
      revocations_.push_back(Revocation{now_, id, first, count});
  }

  void step() {
    const Tick tick = now_;

    // Activate flows whose eligibility starts this tick.
    for (auto& [id, flow] : flows_) {
      if (flow.cancelled || flow.activated || flow.eligible_tick != tick)
        continue;
      flow.activated = true;
      for (std::uint64_t i = 0; i < flow.size; ++i)
        bytes_.push_back(Byte{id, i, kAtSource, tick, next_seq_++});
    }

    for (const auto& [link_id, capacity] : capacities_) {
      std::uint64_t remaining = capacity;
      while (remaining > 0) {
        bool progressed = false;
        for (const auto& [flow_id, flow] : flows_) { // ascending flow ID
          if (remaining == 0)
            break;
          // Find this flow's longest-waiting byte at this link (FIFO).
          Byte* candidate = nullptr;
          for (Byte& byte : bytes_) {
            if (byte.flow != flow_id || byte.ready_tick > tick)
              continue;
            const bool waiting_here =
                (byte.stage == kAtSource && flow.path.front() == link_id) ||
                (byte.stage >= 0 && flow.path[byte.stage] == link_id);
            if (waiting_here &&
                (!candidate || byte.queue_seq < candidate->queue_seq))
              candidate = &byte;
          }
          if (!candidate)
            continue;
          // Send the byte across this link.
          const std::size_t hop =
              candidate->stage == kAtSource
                  ? 0
                  : static_cast<std::size_t>(candidate->stage);
          const bool final_hop = (hop + 1 == flow.path.size());
          transmissions_.push_back(Transmission{tick, flow_id,
                                                candidate->index, link_id,
                                                final_hop});
          candidate->stage = final_hop ? kDelivered
                                       : static_cast<std::int32_t>(hop + 1);
          candidate->ready_tick = tick + 1;
          candidate->queue_seq = next_seq_++;
          --remaining;
          progressed = true;
        }
        if (!progressed)
          break;
      }
    }

    ++now_;
  }

  void run_ticks(std::uint64_t n) {
    for (std::uint64_t i = 0; i < n; ++i)
      step();
  }

  Tick now() const { return now_; }
  const std::vector<Transmission>& transmissions() const { return transmissions_; }
  const std::vector<Revocation>& revocations() const { return revocations_; }

  // Byte-conservation account, computed straight from per-byte stages.
  FlowAccount account(FlowId id) const {
    const Flow& flow = flows_.at(id);
    FlowAccount account;
    account.size = flow.size;
    for (const Byte& byte : bytes_) {
      if (byte.flow != id)
        continue;
      if (byte.stage == kDelivered)
        ++account.delivered;
      else if (byte.stage == kRevoked)
        ++account.revoked;
      else if (byte.stage == kAtSource)
        ++account.unsent;
      else
        ++account.in_flight;
    }
    if (!flow.cancelled && !flow.activated)
      account.unsent = flow.size; // not yet placed in the network
    account.revoked += flow.revoked_unplaced;
    return account;
  }

  FlowAccount total_account() const {
    FlowAccount total;
    for (const auto& [id, flow] : flows_)
      total += account(id);
    return total;
  }

private:
  // stage: kAtSource = waiting at first link (revocable), kDelivered,
  // kRevoked, or k in [0, path.size()) = waiting at path[k] (k>0: in flight).
  static constexpr std::int32_t kAtSource = -1;
  static constexpr std::int32_t kDelivered = -2;
  static constexpr std::int32_t kRevoked = -3;

  struct Byte {
    FlowId flow;
    std::uint64_t index;
    std::int32_t stage;
    Tick ready_tick;
    std::uint64_t queue_seq; // FIFO order within (flow, link)
  };
  struct Flow {
    std::vector<LinkId> path;
    std::uint64_t size;
    Tick eligible_tick;
    bool activated;
    bool cancelled;
    std::uint64_t revoked_unplaced;
  };

  Tick now_ = 0;
  std::uint64_t next_seq_ = 0;
  std::map<LinkId, std::uint64_t> capacities_;
  std::map<FlowId, Flow> flows_;
  std::vector<Byte> bytes_;
  std::vector<Transmission> transmissions_;
  std::vector<Revocation> revocations_;
};

} // namespace netsim::reference
