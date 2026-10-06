// Cancellation semantics: only unsent bytes are revoked; in-flight bytes
// keep travelling and are delivered.

#include "check.hpp"
#include "simulator.hpp"

using namespace netsim;

static void cancel_revokes_unsent_tail() {
  Simulator sim;
  sim.add_link(0, 3);
  sim.add_flow(1, {0}, 10);
  sim.run_ticks(3); // ticks 0..2: bytes 0..5 sent, 6..9 still at source
  sim.cancel_flow(1);
  sim.run_ticks(5); // nothing left to send

  CHECK_EQ(sim.transmissions().size(), 6u);
  const auto& rev = sim.revocations();
  CHECK_EQ(rev.size(), 1u);
  CHECK_EQ(rev[0].tick, 3u);
  CHECK_EQ(rev[0].flow, 1u);
  CHECK_EQ(rev[0].first_unsent_index, 6u);
  CHECK_EQ(rev[0].count, 4u);

  FlowAccount a = sim.account(1);
  CHECK_EQ(a.delivered, 6u);
  CHECK_EQ(a.revoked, 4u);
  CHECK_EQ(a.unsent, 0u);
  CHECK_EQ(a.in_flight, 0u);
  CHECK(a.conserved());
}

static void cancel_keeps_in_flight_bytes() {
  Simulator sim;
  sim.add_link(0, 10);
  sim.add_link(1, 1);
  sim.add_flow(1, {0, 1}, 5);
  sim.run_ticks(2); // t=1: all 5 bytes cross link 0; t=2 not yet run
  sim.cancel_flow(1); // at t=2: nothing unsent, all 5 bytes are in flight
  CHECK(sim.revocations().empty());
  sim.run_ticks(10);

  // Link-1 transmissions: one byte per tick, t=2..6.
  const auto& tx = sim.transmissions();
  CHECK_EQ(tx.size(), 10u);
  std::size_t delivered = 0;
  for (const Transmission& t : tx)
    if (t.final_hop) {
      CHECK_EQ(t.link, 1u);
      CHECK_EQ(t.tick, 2 + delivered);
      ++delivered;
    }
  CHECK_EQ(delivered, 5u);

  FlowAccount a = sim.account(1);
  CHECK_EQ(a.delivered, 5u);
  CHECK_EQ(a.revoked, 0u);
  CHECK(a.conserved());
}

static void cancel_before_eligibility() {
  Simulator sim;
  sim.add_link(0, 2);
  sim.add_flow(1, {0}, 7);
  sim.cancel_flow(1); // same tick as the add: flow never participates
  sim.run_ticks(5);

  CHECK(sim.transmissions().empty());
  const auto& rev = sim.revocations();
  CHECK_EQ(rev.size(), 1u);
  CHECK_EQ(rev[0].count, 7u);
  CHECK_EQ(rev[0].first_unsent_index, 0u);

  FlowAccount a = sim.account(1);
  CHECK_EQ(a.size, 7u);
  CHECK_EQ(a.revoked, 7u);
  CHECK_EQ(a.delivered, 0u);
  CHECK(a.conserved());
}

static void cancel_is_idempotent_and_validated() {
  Simulator sim;
  sim.add_link(0, 1);
  sim.add_flow(1, {0}, 3);
  sim.cancel_flow(1);
  sim.cancel_flow(1); // second cancel is a no-op
  CHECK_EQ(sim.revocations().size(), 1u);

  bool threw = false;
  try {
    sim.cancel_flow(99);
  } catch (const std::invalid_argument&) {
    threw = true;
  }
  CHECK(threw);
  CHECK(sim.conserved());
}

int main() {
  cancel_revokes_unsent_tail();
  cancel_keeps_in_flight_bytes();
  cancel_before_eligibility();
  cancel_is_idempotent_and_validated();
  return testing::finish();
}
