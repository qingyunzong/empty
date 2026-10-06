#pragma once

#include <cstdint>
#include <deque>
#include <map>
#include <stdexcept>
#include <vector>

namespace netsim {

using Tick = std::uint64_t;
using FlowId = std::uint64_t;
using LinkId = std::uint32_t;

// One byte traversing one hop. Recorded at the tick the byte is sent.
struct Transmission {
  Tick tick;
  FlowId flow;
  std::uint64_t byte_index;
  LinkId link;
  bool final_hop; // true when this hop delivers the byte to the destination
  bool operator==(const Transmission&) const = default;
};

// Unsent bytes of a flow revoked by cancellation.
struct Revocation {
  Tick tick;
  FlowId flow;
  std::uint64_t first_unsent_index;
  std::uint64_t count;
  bool operator==(const Revocation&) const = default;
};

// Byte-conservation account of one flow (or of the whole network when summed).
// Invariant: size == delivered + in_flight + revoked + unsent.
struct FlowAccount {
  std::uint64_t size = 0;
  std::uint64_t delivered = 0;  // bytes that reached the destination
  std::uint64_t in_flight = 0;  // bytes past the first link, not yet delivered
  std::uint64_t revoked = 0;    // unsent bytes cancelled away
  std::uint64_t unsent = 0;     // bytes still at the source (revocable)

  bool conserved() const {
    return size == delivered + in_flight + revoked + unsent;
  }
  FlowAccount& operator+=(const FlowAccount& other) {
    size += other.size;
    delivered += other.delivered;
    in_flight += other.in_flight;
    revoked += other.revoked;
    unsent += other.unsent;
    return *this;
  }
};

// Discrete-time shared-link network simulator.
//
// Semantics:
//  - Time advances in integer ticks; each link forwards up to its capacity in
//    bytes per tick.
//  - On each link, ready flows are served round-robin in ascending flow-ID
//    order, one byte per flow per round, until capacity or data runs out.
//  - A flow added at tick t joins scheduling at tick t+1.
//  - A byte crossing a link at tick t becomes sendable on the next hop at
//    tick t+1.
//  - Cancelling a flow revokes only bytes that never left the source; bytes
//    already in flight keep travelling and are delivered.
class Simulator {
public:
  void add_link(LinkId id, std::uint64_t bytes_per_tick);
  // The flow becomes eligible for scheduling at tick now()+1.
  void add_flow(FlowId id, std::vector<LinkId> path, std::uint64_t size_bytes);
  // Revokes the flow's unsent bytes at the current tick. In-flight bytes are
  // unaffected. Cancelling an unknown flow throws std::invalid_argument.
  void cancel_flow(FlowId id);

  void step();
  void run_ticks(std::uint64_t n) {
    for (std::uint64_t i = 0; i < n; ++i) step();
  }

  Tick now() const { return now_; }

  const std::vector<Transmission>& transmissions() const { return transmissions_; }
  const std::vector<Revocation>& revocations() const { return revocations_; }

  FlowAccount account(FlowId id) const;
  FlowAccount total_account() const;
  bool conserved() const { return total_account().conserved(); }

private:
  struct QueuedByte {
    std::uint64_t index;
    Tick available; // first tick at which the byte may be sent on this link
    std::size_t hop; // position of this link within the flow's path
  };
  struct LinkState {
    std::uint64_t capacity;
    std::map<FlowId, std::deque<QueuedByte>> by_flow; // ascending-ID round robin
  };
  struct FlowState {
    std::vector<LinkId> path;
    std::uint64_t size;
    Tick eligible_tick;
    bool activated = false;
    bool cancelled = false;
    std::uint64_t left_source = 0; // bytes that crossed the first hop
    std::uint64_t delivered = 0;
    std::uint64_t revoked = 0;
  };

  Tick now_ = 0;
  std::map<LinkId, LinkState> links_;
  std::map<FlowId, FlowState> flows_;
  std::map<Tick, std::vector<FlowId>> pending_activation_;
  std::vector<Transmission> transmissions_;
  std::vector<Revocation> revocations_;
};

} // namespace netsim
