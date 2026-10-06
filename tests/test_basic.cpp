// Single link, two flows: round-robin by flow id, one byte per turn,
// and flows added at tick t only compete from tick t+1.
#include <vector>

#include "check.hpp"
#include "simulator.hpp"

int main() {
    using namespace netsim;

    Simulator sim;
    const int link = sim.add_link(3);  // 3 bytes/tick
    sim.add_flow(1, {link}, 5, 0);
    sim.add_flow(2, {link}, 5, 0);
    sim.run(100);
    CHECK(sim.finished());

    const std::vector<ByteEvent> expected = {
        // tick 0: both flows were added at tick 0, so nobody sends yet.
        // tick 1: budget 3 -> f1, f2, f1
        {1, 1, 0, 0}, {1, 2, 0, 0}, {1, 1, 0, 1},
        // tick 2: f1, f2, f1
        {2, 1, 0, 2}, {2, 2, 0, 1}, {2, 1, 0, 3},
        // tick 3: f1 (finishes), f2, then f1 has nothing so f2 takes the rest
        {3, 1, 0, 4}, {3, 2, 0, 2}, {3, 2, 0, 3},
        // tick 4: f2 alone
        {4, 2, 0, 4},
    };
    CHECK(sim.events() == expected);

    const auto acct = sim.accounting();
    CHECK_EQ(acct.size(), 2u);
    for (const auto& a : acct) {
        CHECK_EQ(a.delivered, 5u);
        CHECK_EQ(a.cancelled, 0u);
        CHECK_EQ(a.in_flight, 0u);
        CHECK_EQ(a.unsent, 0u);
        CHECK(a.completed);
    }
    std::string err;
    CHECK(sim.check_conservation(err));

    // A flow added at tick t must not emit events before tick t+1.
    Simulator late;
    late.add_link(1);
    late.add_flow(7, {0}, 3, 5);
    late.run(100);
    CHECK(late.finished());
    CHECK_EQ(late.events().size(), 3u);
    for (const auto& e : late.events()) {
        CHECK(e.tick >= 6);
    }
    return 0;
}
