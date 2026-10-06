#pragma once

#include <deque>
#include <vector>

#include "simulator.hpp"

namespace netsim {

// Independent byte-explicit reference model used to cross-check Simulator.
// Every byte is materialized as an entry in a FIFO queue and moved one hop
// at a time; the resulting event stream must match Simulator exactly.
class ReferenceSimulator {
public:
    int add_link(std::uint64_t bytes_per_tick);
    void add_flow(int flow_id, std::vector<int> path, std::uint64_t size, Tick at_tick);
    void cancel_flow(int flow_id, Tick at_tick);

    // Runs until all flows finish or `max_ticks` elapse; returns the event log.
    std::vector<ByteEvent> run(Tick max_ticks);

    struct FlowResult {
        int flow_id = 0;
        std::uint64_t size = 0;
        std::uint64_t delivered = 0;
        std::uint64_t cancelled = 0;
    };
    [[nodiscard]] std::vector<FlowResult> results() const;

private:
    struct RefFlow {
        int id = 0;
        std::vector<int> path;
        std::uint64_t size = 0;
        Tick added_tick = 0;
        bool has_cancel = false;
        bool cancel_applied = false;
        Tick cancel_tick = 0;
        std::vector<std::deque<std::uint64_t>> ready;     // per hop: byte indices
        std::vector<std::deque<std::uint64_t>> arriving;  // per hop: usable next tick
        std::uint64_t delivered = 0;
        std::uint64_t cancelled = 0;
    };

    std::vector<std::uint64_t> bandwidth_;
    std::vector<RefFlow> flows_;  // sorted by flow id
};

}  // namespace netsim
