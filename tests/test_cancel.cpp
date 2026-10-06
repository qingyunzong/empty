// Cancellation revokes only never-sent bytes; in-flight bytes keep going.
#include "check.hpp"
#include "simulator.hpp"

int main() {
    using namespace netsim;

    {  // single hop: unsent remainder is revoked at the cancel tick
        Simulator sim;
        sim.add_link(2);
        sim.add_flow(1, {0}, 10, 0);
        sim.cancel_flow(1, 3);
        sim.run(100);
        CHECK(sim.finished());
        const auto acct = sim.accounting();
        CHECK_EQ(acct[0].delivered, 4u);   // 2 bytes at tick 1, 2 at tick 2
        CHECK_EQ(acct[0].cancelled, 6u);
        CHECK_EQ(acct[0].unsent, 0u);
        CHECK_EQ(acct[0].in_flight, 0u);
        CHECK_EQ(sim.events().size(), 4u);
        std::string err;
        CHECK(sim.check_conservation(err));
    }

    {  // multi hop: the byte already on the wire is still delivered
        Simulator sim;
        sim.add_link(1);
        sim.add_link(1);
        sim.add_flow(1, {0, 1}, 5, 0);
        sim.cancel_flow(1, 3);
        sim.run(100);
        CHECK(sim.finished());
        const auto acct = sim.accounting();
        // tick 1: b0 -> link0; tick 2: b0 delivered, b1 -> link0;
        // tick 3: cancel revokes 3 unsent, b1 is delivered anyway.
        CHECK_EQ(acct[0].delivered, 2u);
        CHECK_EQ(acct[0].cancelled, 3u);
        CHECK_EQ(acct[0].in_flight, 0u);
        std::string err;
        CHECK(sim.check_conservation(err));
    }

    {  // cancelling an already-finished flow is a no-op
        Simulator sim;
        sim.add_link(10);
        sim.add_flow(1, {0}, 2, 0);
        sim.cancel_flow(1, 50);
        sim.run(100);
        const auto acct = sim.accounting();
        CHECK_EQ(acct[0].delivered, 2u);
        CHECK_EQ(acct[0].cancelled, 0u);
    }
    return 0;
}
