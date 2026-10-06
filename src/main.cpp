#include "simulator.hpp"

#include <cstdio>

using namespace netsim;

static void print_account(const char* name, const FlowAccount& a) {
  std::printf("%-8s size=%-4llu delivered=%-4llu in_flight=%-4llu "
              "unsent=%-4llu revoked=%-4llu conserved=%s\n",
              name, (unsigned long long)a.size, (unsigned long long)a.delivered,
              (unsigned long long)a.in_flight, (unsigned long long)a.unsent,
              (unsigned long long)a.revoked, a.conserved() ? "YES" : "NO");
}

int main() {
  Simulator sim;
  sim.add_link(0, 3); // 3 bytes/tick
  sim.add_link(1, 2); // 2 bytes/tick

  // Added at tick 0 -> eligible at tick 1.
  sim.add_flow(1, {0, 1}, 10);
  sim.add_flow(2, {0}, 6);

  sim.run_ticks(3); // ticks 0,1,2
  sim.add_flow(3, {0, 1}, 4); // added at tick 3 -> eligible at tick 4
  sim.run_ticks(2);           // ticks 3,4
  sim.cancel_flow(1);         // at tick 5: revoke flow 1's unsent bytes
  sim.run_ticks(20);          // drain

  std::printf("== transmissions (tick flow byte link final) ==\n");
  for (const Transmission& t : sim.transmissions())
    std::printf("t=%-3llu flow=%llu byte=%-3llu link=%u%s\n",
                (unsigned long long)t.tick, (unsigned long long)t.flow,
                (unsigned long long)t.byte_index, (unsigned)t.link,
                t.final_hop ? " *delivered" : "");

  std::printf("== revocations ==\n");
  for (const Revocation& r : sim.revocations())
    std::printf("t=%llu flow=%llu first_unsent=%llu count=%llu\n",
                (unsigned long long)r.tick, (unsigned long long)r.flow,
                (unsigned long long)r.first_unsent_index,
                (unsigned long long)r.count);

  std::printf("== byte conservation accounts ==\n");
  for (FlowId id : {1, 2, 3})
    print_account(("flow " + std::to_string(id)).c_str(), sim.account(id));
  print_account("TOTAL", sim.total_account());

  return sim.conserved() ? 0 : 1;
}
