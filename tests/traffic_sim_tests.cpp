#include <algorithm>
#include <iostream>
#include <map>
#include <string>
#include <vector>

#include "traffic_sim.h"

using namespace trafficsim;

namespace {

int failures = 0;
std::string current_check_file;
int current_check_line = 0;

#define CHECK(cond)                                            \
  do {                                                         \
    if (!(cond)) {                                             \
      std::cerr << "FAIL " << __FILE__ << ':' << __LINE__      \
                << ": CHECK(" #cond ")\n";                     \
      ++failures;                                              \
    }                                                          \
  } while (0)

bool contains(const std::vector<int>& v, int x) {
  return std::find(v.begin(), v.end(), x) != v.end();
}

const Rejection* find_rejection(const TickResult& r, int id) {
  for (const auto& rej : r.rejected) {
    if (rej.vehicle_id == id) return &rej;
  }
  return nullptr;
}

// Two vehicles on disjoint routes both proceed.
void test_no_conflict_both_pass() {
  Simulator sim;
  sim.add_vehicle(Vehicle{.id = 1, .route = {{0, 0}, {1, 0}, {2, 0}}});
  sim.add_vehicle(Vehicle{.id = 2, .route = {{0, 5}, {1, 5}, {2, 5}}});
  TickResult r = sim.step();
  CHECK(r.approved.size() == 2);
  CHECK(r.rejected.empty());
  CHECK(r.occupancy.size() == 4);
  std::string err;
  CHECK(verify_no_collision(r, &err));
  CHECK(verify_waiting(r, &err));
}

// Equal waiting time: smaller id wins the contested cell; loser gets a
// reason naming the cell and the blocking vehicle.
void test_id_tiebreak_and_reason() {
  Simulator sim;
  sim.add_vehicle(Vehicle{.id = 7, .route = {{0, 0}, {1, 1}}});
  sim.add_vehicle(Vehicle{.id = 3, .route = {{2, 2}, {1, 1}}});
  TickResult r = sim.step();
  CHECK(contains(r.approved, 3));
  CHECK(!contains(r.approved, 7));
  const Rejection* rej = find_rejection(r, 7);
  CHECK(rej != nullptr);
  if (rej) {
    CHECK(rej->conflict_cell == (Cell{1, 1}));
    CHECK(rej->blocking_vehicle_id == 3);
    CHECK(!rej->reason.empty());
  }
}

// Longer waiting time beats smaller id.
void test_waiting_time_priority() {
  Simulator sim;
  sim.add_vehicle(Vehicle{.id = 1, .route = {{0, 0}, {1, 1}}, .waiting = 0});
  sim.add_vehicle(Vehicle{.id = 2, .route = {{2, 2}, {1, 1}}, .waiting = 5});
  TickResult r = sim.step();
  CHECK(contains(r.approved, 2));
  CHECK(!contains(r.approved, 1));
}

// Emergency status only raises priority: it wins arbitration but follows
// the same occupancy rules.
void test_emergency_priority_only() {
  Simulator sim;
  sim.add_vehicle(Vehicle{
      .id = 1, .emergency = false, .route = {{0, 0}, {1, 1}}, .waiting = 9});
  sim.add_vehicle(Vehicle{
      .id = 2, .emergency = true, .route = {{2, 2}, {1, 1}}, .waiting = 0});
  TickResult r = sim.step();
  CHECK(contains(r.approved, 2));
  CHECK(!contains(r.approved, 1));
  const Rejection* rej = find_rejection(r, 1);
  CHECK(rej != nullptr);
}

// Two vehicles swapping adjacent cells conflict on both cells; the
// higher-priority one moves, the other is rejected.
void test_swap_conflict() {
  Simulator sim;
  sim.add_vehicle(Vehicle{.id = 1, .route = {{0, 0}, {1, 0}, {2, 0}}});
  sim.add_vehicle(Vehicle{.id = 2, .route = {{1, 0}, {0, 0}}});
  TickResult r = sim.step();
  CHECK(contains(r.approved, 1));
  CHECK(!contains(r.approved, 2));
  const Rejection* rej = find_rejection(r, 2);
  CHECK(rej != nullptr);
  if (rej) CHECK(rej->blocking_vehicle_id == 1);
}

// A follower cannot enter the cell the leader is leaving this tick,
// because the leader's footprint still covers its current cell.
void test_follow_conflict() {
  Simulator sim;
  sim.add_vehicle(Vehicle{.id = 1, .route = {{0, 0}, {1, 0}, {2, 0}}});
  sim.add_vehicle(Vehicle{.id = 2, .route = {{1, 0}, {2, 0}, {3, 0}}});
  // Tick 0: the follower wants the leader's current cell; rejected.
  TickResult r = sim.step();
  CHECK(contains(r.approved, 1));
  CHECK(!contains(r.approved, 2));
  const Rejection* rej = find_rejection(r, 2);
  CHECK(rej != nullptr);
  if (rej) CHECK(rej->conflict_cell == (Cell{1, 0}));
  // The corridor is one cell wide, so the two vehicles keep conflicting
  // and alternate by waiting-time priority; both still finish collision-free.
  int ticks = 1;
  while (!sim.done() && ticks < 20) {
    TickResult t = sim.step();
    std::string err;
    CHECK(verify_no_collision(t, &err));
    CHECK(verify_waiting(t, &err));
    ++ticks;
  }
  CHECK(sim.done());
}

// Waiting time accumulates by one per rejected tick and resets on moving.
// Vehicle 3 loses the contested cell (1,0) twice in a row: first to the
// lower-id vehicle 1, then to vehicle 2 whose waiting time broke the tie.
void test_waiting_accumulates_and_resets() {
  Simulator sim;
  sim.add_vehicle(Vehicle{.id = 1, .route = {{0, 0}, {1, 0}, {2, 0}, {3, 0}}});
  sim.add_vehicle(Vehicle{.id = 2, .route = {{5, 5}, {1, 0}, {9, 9}}});
  sim.add_vehicle(Vehicle{.id = 3, .route = {{6, 6}, {1, 0}, {8, 8}}});
  const Vehicle& v2 = sim.vehicles()[1];
  const Vehicle& v3 = sim.vehicles()[2];

  TickResult r1 = sim.step();
  CHECK(contains(r1.approved, 1));
  CHECK(!contains(r1.approved, 2));
  CHECK(!contains(r1.approved, 3));
  CHECK(v2.waiting == 1);
  CHECK(v3.waiting == 1);

  // Vehicle 2 now has the highest waiting time among the contenders and
  // wins the cell; vehicle 3 is rejected a second time.
  TickResult r2 = sim.step();
  CHECK(contains(r2.approved, 2));
  CHECK(v2.waiting == 0);
  CHECK(v3.waiting == 2);

  // Vehicle 3 has waited longest; it proceeds and its waiting resets.
  TickResult r3 = sim.step();
  CHECK(contains(r3.approved, 3));
  CHECK(v3.waiting == 0);

  std::string err;
  CHECK(verify_waiting(r1, &err));
  CHECK(verify_waiting(r2, &err));
  CHECK(verify_waiting(r3, &err));
}

// Reference verification helpers accept valid results and reject
// tampered ones.
void test_verify_helpers() {
  Simulator sim;
  sim.add_vehicle(Vehicle{.id = 1, .route = {{0, 0}, {1, 0}}});
  TickResult r = sim.step();
  std::string err;
  CHECK(verify_no_collision(r, &err));
  CHECK(verify_waiting(r, &err));

  TickResult bad = r;
  bad.occupancy[Cell{9, 9}] = 42;  // not an approved vehicle
  CHECK(!verify_no_collision(bad, &err));

  bad = r;
  bad.transitions[0].waiting_after = 7;
  CHECK(!verify_waiting(bad, &err));
}

// Full run of a crossing scenario: every tick passes the per-cell
// occupancy reference check and waiting-time bookkeeping, and all
// vehicles eventually finish.
void test_full_run_reference() {
  Simulator sim;
  sim.add_vehicle(Vehicle{.id = 1, .route = {{0, 1}, {1, 1}, {2, 1}, {3, 1}}});
  sim.add_vehicle(Vehicle{.id = 2, .route = {{1, 0}, {1, 1}, {1, 2}, {1, 3}}});
  sim.add_vehicle(Vehicle{.id = 3,
                          .emergency = true,
                          .route = {{2, 0}, {2, 1}, {2, 2}, {2, 3}}});
  int ticks = 0;
  while (!sim.done() && ticks < 100) {
    TickResult r = sim.step();
    std::string err;
    CHECK(verify_no_collision(r, &err));
    CHECK(verify_waiting(r, &err));
    ++ticks;
  }
  CHECK(sim.done());
  // Straight-line routes need at least 3 moves each; conflicts add waits.
  CHECK(ticks >= 3);
}

const std::map<std::string, void (*)()> kTests = {
    {"no_conflict_both_pass", test_no_conflict_both_pass},
    {"id_tiebreak_and_reason", test_id_tiebreak_and_reason},
    {"waiting_time_priority", test_waiting_time_priority},
    {"emergency_priority_only", test_emergency_priority_only},
    {"swap_conflict", test_swap_conflict},
    {"follow_conflict", test_follow_conflict},
    {"waiting_accumulates_and_resets", test_waiting_accumulates_and_resets},
    {"verify_helpers", test_verify_helpers},
    {"full_run_reference", test_full_run_reference},
};

}  // namespace

int main(int argc, char** argv) {
  if (argc != 2) {
    std::cerr << "usage: " << argv[0] << " <test_name>\navailable tests:\n";
    for (const auto& [name, fn] : kTests) std::cerr << "  " << name << '\n';
    return 2;
  }
  auto it = kTests.find(argv[1]);
  if (it == kTests.end()) {
    std::cerr << "unknown test: " << argv[1] << '\n';
    return 2;
  }
  it->second();
  if (failures > 0) {
    std::cerr << failures << " check(s) failed\n";
    return 1;
  }
  std::cout << argv[1] << ": OK\n";
  return 0;
}
