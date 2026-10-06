// Single-link scheduling: capacity per tick, ID-ordered byte round robin,
// and next-tick participation of newly added flows.

#include "check.hpp"
#include "simulator.hpp"

using namespace netsim;

static void single_flow_capacity() {
  Simulator sim;
  sim.add_link(0, 3);
  sim.add_flow(1, {0}, 10); // added at t=0 -> eligible at t=1
  sim.run_ticks(5);         // ticks 0..4

  const auto& tx = sim.transmissions();
  CHECK_EQ(tx.size(), 10u);
  // t=0 is silent; bytes 0..2 at t=1, 3..5 at t=2, 6..8 at t=3, 9 at t=4.
  for (std::size_t i = 0; i < tx.size(); ++i) {
    CHECK_EQ(tx[i].tick, 1 + i / 3);
    CHECK_EQ(tx[i].byte_index, i);
    CHECK_EQ(tx[i].flow, 1u);
    CHECK(tx[i].final_hop);
  }
  FlowAccount a = sim.account(1);
  CHECK_EQ(a.delivered, 10u);
  CHECK_EQ(a.in_flight, 0u);
  CHECK_EQ(a.unsent, 0u);
  CHECK_EQ(a.revoked, 0u);
  CHECK(a.conserved());
  CHECK(sim.conserved());
}

static void round_robin_by_flow_id() {
  Simulator sim;
  sim.add_link(0, 4);
  sim.add_flow(1, {0}, 4);
  sim.add_flow(2, {0}, 4);
  sim.run_ticks(3); // ticks 0..2

  const auto& tx = sim.transmissions();
  CHECK_EQ(tx.size(), 8u);
  // Within a tick, rounds alternate flows in ascending ID order.
  const FlowId expected_flows[8] = {1, 2, 1, 2, 1, 2, 1, 2};
  const std::uint64_t expected_bytes[8] = {0, 0, 1, 1, 2, 2, 3, 3};
  for (std::size_t i = 0; i < 8; ++i) {
    CHECK_EQ(tx[i].flow, expected_flows[i]);
    CHECK_EQ(tx[i].byte_index, expected_bytes[i]);
    CHECK_EQ(tx[i].tick, 1 + i / 4);
  }
  CHECK_EQ(sim.account(1).delivered, 4u);
  CHECK_EQ(sim.account(2).delivered, 4u);
  CHECK(sim.conserved());
}

static void late_flow_joins_next_tick() {
  Simulator sim;
  sim.add_link(0, 2);
  sim.add_flow(1, {0}, 6);
  sim.run_ticks(2);          // ticks 0,1 -> flow 1 sent bytes 0,1 at t=1
  sim.add_flow(2, {0}, 4);   // added at t=2 -> eligible at t=3
  sim.run_ticks(1);          // tick 2: flow 2 must not appear yet
  CHECK_EQ(sim.now(), 3u);

  const auto& tx = sim.transmissions();
  CHECK_EQ(tx.size(), 4u); // t1: (1,0),(1,1); t2: (1,2),(1,3)
  for (const Transmission& t : tx)
    CHECK_EQ(t.flow, 1u);

  sim.run_ticks(1); // tick 3: flow 2 joins the round robin
  CHECK_EQ(tx.size(), 6u);
  CHECK_EQ(tx[4].tick, 3u);
  CHECK_EQ(tx[4].flow, 1u); // lower ID first
  CHECK_EQ(tx[4].byte_index, 4u);
  CHECK_EQ(tx[5].tick, 3u);
  CHECK_EQ(tx[5].flow, 2u);
  CHECK_EQ(tx[5].byte_index, 0u);

  sim.run_ticks(10); // drain
  CHECK_EQ(sim.account(1).delivered, 6u);
  CHECK_EQ(sim.account(2).delivered, 4u);
  CHECK(sim.conserved());
}

int main() {
  single_flow_capacity();
  round_robin_by_flow_id();
  late_flow_joins_next_tick();
  return testing::finish();
}
