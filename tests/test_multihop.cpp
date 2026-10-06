// Multi-hop path: a byte crossing a link at tick t may leave on the next
// hop at tick t+1, never earlier.
#include <vector>

#include "check.hpp"
#include "simulator.hpp"

int main() {
    using namespace netsim;

    Simulator sim;
    sim.add_link(1);  // link 0
    sim.add_link(1);  // link 1
    sim.add_flow(1, {0, 1}, 3, 0);
    sim.run(100);
    CHECK(sim.finished());

    const std::vector<ByteEvent> expected = {
        {1, 1, 0, 0},              // byte 0 crosses link 0 at tick 1
        {2, 1, 0, 1},              // byte 1 crosses link 0
        {2, 1, 1, 0},              // byte 0 crosses link 1 one tick after link 0
        {3, 1, 0, 2}, {3, 1, 1, 1},
        {4, 1, 1, 2},
    };
    CHECK(sim.events() == expected);

    // No byte may appear on a later hop in the same tick it crossed an
    // earlier one: per byte index, the tick on link 1 exceeds that on link 0.
    std::vector<Tick> first_link_tick(3, 0);
    for (const auto& e : sim.events()) {
        if (e.link_id == 0) first_link_tick[e.byte_index] = e.tick;
    }
    for (const auto& e : sim.events()) {
        if (e.link_id == 1) CHECK(e.tick > first_link_tick[e.byte_index]);
    }

    const auto acct = sim.accounting();
    CHECK_EQ(acct.size(), 1u);
    CHECK_EQ(acct[0].delivered, 3u);
    CHECK_EQ(acct[0].in_flight, 0u);
    CHECK_EQ(acct[0].completion_tick, 4u);
    std::string err;
    CHECK(sim.check_conservation(err));
    return 0;
}
