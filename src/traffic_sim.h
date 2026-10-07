#pragma once

#include <compare>
#include <cstddef>
#include <map>
#include <set>
#include <string>
#include <vector>

namespace trafficsim {

// A grid cell in the road network.
struct Cell {
  int x = 0;
  int y = 0;
  auto operator<=>(const Cell&) const = default;
  bool operator==(const Cell&) const = default;
};

std::string to_string(const Cell& c);

// A vehicle travelling along a fixed route of cells.
struct Vehicle {
  int id = 0;
  bool emergency = false;        // only raises arbitration priority
  std::vector<Cell> route;       // cells to traverse, in order
  std::size_t position = 0;      // index into route (current cell)
  int waiting = 0;               // consecutive ticks spent not moving

  bool finished() const { return position + 1 >= route.size(); }
  Cell current_cell() const { return route[position]; }
  // Cells this vehicle would occupy during a move this tick:
  // its current cell plus the next cell (prevents swaps / tailgating).
  std::set<Cell> move_footprint() const;
};

// Why a vehicle was denied passage in a tick.
struct Rejection {
  int vehicle_id = 0;
  Cell conflict_cell{};          // first conflicting cell (deterministic order)
  int blocking_vehicle_id = 0;   // approved vehicle already holding that cell
  std::string reason;            // human-readable explanation
};

// Per-vehicle state transition recorded for reference verification.
struct VehicleTransition {
  int vehicle_id = 0;
  int waiting_before = 0;
  int waiting_after = 0;
  bool moved = false;
};

struct TickResult {
  int tick = 0;
  std::vector<int> approved;                 // vehicle ids allowed to move
  std::vector<Rejection> rejected;           // denied vehicles with reasons
  std::map<Cell, int> occupancy;             // reference map: cell -> vehicle id
  std::vector<VehicleTransition> transitions;  // waiting-time bookkeeping
};

class Simulator {
 public:
  void add_vehicle(Vehicle v);
  // Arbitrate and execute one tick. Returns pairings, rejections and the
  // per-cell occupancy reference map.
  TickResult step();
  bool done() const;
  int current_tick() const { return tick_; }
  const std::vector<Vehicle>& vehicles() const { return vehicles_; }

 private:
  std::vector<Vehicle> vehicles_;
  int tick_ = 0;
};

// Reference verification helpers (used by tests and available to users).

// Every cell in the occupancy map belongs to exactly one vehicle, and the
// union of approved footprints equals the occupancy map.
bool verify_no_collision(const TickResult& result, std::string* err);

// Waiting time accumulates by exactly 1 for rejected vehicles and resets to
// 0 for approved ones.
bool verify_waiting(const TickResult& result, std::string* err);

}  // namespace trafficsim
