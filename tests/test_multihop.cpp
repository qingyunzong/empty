// Multi-hop forwarding: a byte crossing a link at tick t becomes sendable on
// the next hop at tick t+1; links pipeline independently.

#include "check.hpp"
#include "simulator.hpp"

using namespace netsim;

static void three_hop_pipeline() {
  Simulator sim;
  sim.add_link(0, 1);
  sim.add_link(1, 1);
  sim.add_link(2, 1);
  sim.add_flow(1, {0, 1, 2}, 3);
  sim.run_ticks(7); // ticks 0..6

  const auto& tx = sim.transmissions();
  CHECK_EQ(tx.size(), 9u);
  // Links are processed in ID order within a tick; a byte moves one hop
  // per tick, so byte k is delivered at tick 4+k... byte 0: hops at t=1,2,3.
  const Tick expected_tick[9] = {1, 2, 2, 3, 3, 3, 4, 4, 5};
  const std::uint64_t expected_byte[9] = {0, 1, 0, 2, 1, 0, 2, 1, 2};
  const LinkId expected_link[9] = {0, 0, 1, 0, 1, 2, 1, 2, 2};
  for (std::size_t i = 0; i < 9; ++i) {
    CHECK_EQ(tx[i].tick, expected_tick[i]);
    CHECK_EQ(tx[i].byte_index, expected_byte[i]);
    CHECK_EQ(tx[i].link, expected_link[i]);
    CHECK_EQ(tx[i].final_hop, expected_link[i] == 2);
  }
  // End-to-end: byte k delivered at tick 3+k (one hop per tick after t=1).
  CHECK_EQ(sim.account(1).delivered, 3u);
  CHECK(sim.conserved());
}

static void two_flows_merge_on_shared_hop() {
  Simulator sim;
  sim.add_link(0, 2);
  sim.add_link(1, 1);
  sim.add_link(2, 2);
  sim.add_flow(1, {0, 2}, 2);
  sim.add_flow(2, {1, 2}, 2);
  sim.run_ticks(6);

  const auto& tx = sim.transmissions();
  CHECK_EQ(tx.size(), 8u);
  // On the shared link 2 (capacity 2), flows interleave by ID each tick:
  // t=2: (f1,b0),(f2,b0); t=3: (f1,b1),(f2,b1).
  std::size_t on_link2 = 0;
  for (const Transmission& t : tx) {
    if (t.link != 2)
      continue;
    const Tick expected_tick = 2 + on_link2 / 2;
    const FlowId expected_flow = 1 + on_link2 % 2;
    const std::uint64_t expected_byte = on_link2 / 2;
    CHECK_EQ(t.tick, expected_tick);
    CHECK_EQ(t.flow, expected_flow);
    CHECK_EQ(t.byte_index, expected_byte);
    CHECK(t.final_hop);
    ++on_link2;
  }
  CHECK_EQ(on_link2, 4u);
  CHECK_EQ(sim.account(1).delivered, 2u);
  CHECK_EQ(sim.account(2).delivered, 2u);
  CHECK(sim.conserved());
}

static void bottleneck_backlogs_upstream() {
  Simulator sim;
  sim.add_link(0, 4); // fast first hop
  sim.add_link(1, 1); // slow second hop
  sim.add_flow(1, {0, 1}, 4);
  sim.run_ticks(3); // t=1: all 4 bytes cross link 0; t=2..: 1 byte/tick

  // After t=2 (3 ticks run: 0,1,2): one byte delivered, three queued at link 1.
  FlowAccount a = sim.account(1);
  CHECK_EQ(a.delivered, 1u);
  CHECK_EQ(a.in_flight, 3u);
  CHECK_EQ(a.unsent, 0u);
  CHECK(a.conserved());

  sim.run_ticks(3); // drain t=3,4,5
  a = sim.account(1);
  CHECK_EQ(a.delivered, 4u);
  CHECK_EQ(a.in_flight, 0u);
  CHECK(a.conserved());
}

int main() {
  three_hop_pipeline();
  two_flows_merge_on_shared_hop();
  bottleneck_backlogs_upstream();
  return testing::finish();
}
