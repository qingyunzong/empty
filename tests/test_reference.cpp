// Byte-by-byte cross-verification: randomized scenarios are executed on both
// netsim::Simulator and the independent reference model. The full
// transmission/revocation logs must match exactly, and byte conservation
// must hold at every tick.

#include "check.hpp"
#include "reference.hpp"
#include "simulator.hpp"

#include <random>
#include <vector>

using namespace netsim;

namespace {

struct Op {
  Tick tick;
  enum Kind { AddFlow, Cancel } kind;
  FlowId flow;
  std::vector<LinkId> path;
  std::uint64_t size;
};

struct Scenario {
  std::vector<std::pair<LinkId, std::uint64_t>> links;
  std::vector<Op> ops;
  Tick horizon;
};

Scenario make_scenario(std::mt19937_64& rng) {
  Scenario s;
  const int num_links = 1 + (int)(rng() % 3);
  for (int i = 0; i < num_links; ++i)
    s.links.push_back({(LinkId)i, 1 + rng() % 4});

  const int num_flows = 1 + (int)(rng() % 6);
  for (int f = 0; f < num_flows; ++f) {
    Op op;
    op.kind = Op::AddFlow;
    op.tick = rng() % 5;
    op.flow = (FlowId)(f + 1);
    const int hops = 1 + (int)(rng() % 3);
    for (int h = 0; h < hops; ++h)
      op.path.push_back((LinkId)(rng() % num_links));
    op.size = rng() % 13;
    s.ops.push_back(op);
    if (rng() % 10 < 4) { // 40% of flows get cancelled at some point
      Op cancel;
      cancel.kind = Op::Cancel;
      cancel.tick = op.tick + rng() % 9;
      cancel.flow = op.flow;
      s.ops.push_back(cancel);
    }
  }
  s.horizon = 40;
  return s;
}

void run_scenario(const Scenario& s) {
  Simulator sim;
  reference::ReferenceModel ref;
  for (const auto& [id, cap] : s.links) {
    sim.add_link(id, cap);
    ref.add_link(id, cap);
  }

  for (Tick tick = 0; tick < s.horizon; ++tick) {
    for (const Op& op : s.ops) {
      if (op.tick != tick)
        continue;
      if (op.kind == Op::AddFlow) {
        sim.add_flow(op.flow, op.path, op.size);
        ref.add_flow(op.flow, op.path, op.size);
      } else {
        sim.cancel_flow(op.flow);
        ref.cancel_flow(op.flow);
      }
    }
    sim.step();
    ref.step();
    // Byte conservation must hold at every tick, in both models.
    CHECK(sim.conserved());
    CHECK(ref.total_account().conserved());
  }

  // Byte-by-byte equality of the full event logs.
  CHECK(sim.transmissions() == ref.transmissions());
  CHECK(sim.revocations() == ref.revocations());
  // Identical closing accounts.
  FlowAccount a = sim.total_account();
  FlowAccount b = ref.total_account();
  CHECK_EQ(a.size, b.size);
  CHECK_EQ(a.delivered, b.delivered);
  CHECK_EQ(a.in_flight, b.in_flight);
  CHECK_EQ(a.revoked, b.revoked);
  CHECK_EQ(a.unsent, b.unsent);
}

} // namespace

int main() {
  for (std::uint64_t seed = 1; seed <= 200; ++seed) {
    std::mt19937_64 rng(seed);
    run_scenario(make_scenario(rng));
  }
  return testing::finish();
}
