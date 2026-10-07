#include <iostream>
#include <string>

#include "traffic_sim.h"

using namespace trafficsim;

namespace {

// Demo scenario: a 4x4 crossing with converging routes.
//   v1 (normal):    (0,1) -> (1,1) -> (2,1) -> (3,1)
//   v2 (normal):    (1,0) -> (1,1) -> (1,2) -> (1,3)
//   v3 (emergency): (2,0) -> (2,1) -> (2,2) -> (2,3)
// v1 and v2 collide at (1,1); v1 and v3 collide at (2,1).
Simulator build_demo() {
  Simulator sim;
  sim.add_vehicle(Vehicle{.id = 1,
                          .emergency = false,
                          .route = {{0, 1}, {1, 1}, {2, 1}, {3, 1}}});
  sim.add_vehicle(Vehicle{.id = 2,
                          .emergency = false,
                          .route = {{1, 0}, {1, 1}, {1, 2}, {1, 3}}});
  sim.add_vehicle(Vehicle{.id = 3,
                          .emergency = true,
                          .route = {{2, 0}, {2, 1}, {2, 2}, {2, 3}}});
  return sim;
}

void print_tick(const TickResult& r) {
  std::cout << "tick " << r.tick << ":\n";
  std::cout << "  approved:";
  for (int id : r.approved) std::cout << ' ' << id;
  if (r.approved.empty()) std::cout << " (none)";
  std::cout << '\n';
  for (const Rejection& rej : r.rejected) {
    std::cout << "  rejected: " << rej.reason << '\n';
  }
  std::cout << "  occupancy:";
  for (const auto& [cell, id] : r.occupancy) {
    std::cout << ' ' << to_string(cell) << "=v" << id;
  }
  std::cout << '\n';
  std::cout << "  waiting:";
  for (const VehicleTransition& t : r.transitions) {
    std::cout << " v" << t.vehicle_id << "=" << t.waiting_after;
  }
  std::cout << '\n';
}

}  // namespace

int main() {
  Simulator sim = build_demo();
  while (!sim.done()) {
    TickResult r = sim.step();
    print_tick(r);
    std::string err;
    if (!verify_no_collision(r, &err) || !verify_waiting(r, &err)) {
      std::cerr << "verification failed: " << err << '\n';
      return 1;
    }
  }
  std::cout << "all vehicles finished in " << sim.current_tick()
            << " ticks\n";
  return 0;
}
