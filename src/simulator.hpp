#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace netsim {

using Tick = std::uint64_t;

// One record per byte transmitted on a link.
struct ByteEvent {
    Tick tick = 0;
    int flow_id = 0;
    int link_id = 0;
    std::uint64_t byte_index = 0;  // sequence number of the byte within its flow
    bool operator==(const ByteEvent&) const = default;
};

struct FlowAccounting {
    int flow_id = 0;
    std::uint64_t size = 0;
    std::uint64_t delivered = 0;   // fully traversed the whole path
    std::uint64_t cancelled = 0;   // revoked while still unsent
    std::uint64_t in_flight = 0;   // sent on >=1 link, not yet delivered
    std::uint64_t unsent = 0;      // still at the source, never sent
    bool completed = false;        // delivered + cancelled == size
    Tick completion_tick = 0;
};

// Discrete-time shared-link simulator.
//
// Semantics:
//  - Each tick, every link may transmit up to `bandwidth` bytes.
//  - On a link, ready flows are served round-robin in ascending flow-ID
//    order, one byte per turn, until the tick budget is spent.
//  - A flow added at tick t first competes at tick t+1.
//  - A byte crossing a link at tick t may leave on the next hop at t+1.
//  - Cancelling a flow at tick t (applied before that tick's allocation)
//    revokes only its never-sent bytes; in-flight bytes keep going.
class Simulator {
public:
    // Returns the new link's id (links are numbered 0,1,2,...).
    int add_link(std::uint64_t bytes_per_tick);

    // `path` is a non-empty sequence of link ids. Flow ids must be unique.
    void add_flow(int flow_id, std::vector<int> path, std::uint64_t size, Tick at_tick);
    void cancel_flow(int flow_id, Tick at_tick);

    // Advances up to `num_ticks` ticks, stopping early once every flow is done.
    void run(Tick num_ticks);

    [[nodiscard]] bool finished() const;
    [[nodiscard]] Tick now() const { return now_; }
    [[nodiscard]] const std::vector<ByteEvent>& events() const { return events_; }
    [[nodiscard]] std::vector<FlowAccounting> accounting() const;

    // Verifies per-flow: delivered + cancelled + in_flight + unsent == size.
    [[nodiscard]] bool check_conservation(std::string& error) const;

private:
    struct FlowState {
        int id = 0;
        std::vector<int> path;
        std::uint64_t size = 0;
        Tick added_tick = 0;
        bool has_cancel = false;
        bool cancel_applied = false;
        Tick cancel_tick = 0;
        std::vector<std::uint64_t> pending;      // per hop: bytes sendable now
        std::vector<std::uint64_t> arriving;     // per hop: bytes sendable next tick
        std::vector<std::uint64_t> sent_on_hop;  // per hop: count sent (next byte index)
        std::uint64_t delivered = 0;
        std::uint64_t cancelled = 0;
        bool completed = false;
        Tick completion_tick = 0;
    };

    struct Link {
        std::uint64_t bandwidth = 0;
    };

    std::vector<Link> links_;
    std::vector<FlowState> flows_;  // kept sorted by flow id
    std::vector<ByteEvent> events_;
    Tick now_ = 0;

    void step();
    void update_completion();
};

}  // namespace netsim
