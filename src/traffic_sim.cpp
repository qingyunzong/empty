#include "traffic_sim.h"

#include <algorithm>
#include <sstream>

namespace trafficsim {

std::string to_string(const Cell& c) {
  return "(" + std::to_string(c.x) + "," + std::to_string(c.y) + ")";
}

std::set<Cell> Vehicle::move_footprint() const {
  if (finished()) {
    return {current_cell()};
  }
  return {route[position], route[position + 1]};
}

void Simulator::add_vehicle(Vehicle v) {
  vehicles_.push_back(std::move(v));
}

bool Simulator::done() const {
  return std::all_of(vehicles_.begin(), vehicles_.end(),
                     [](const Vehicle& v) { return v.finished(); });
}

TickResult Simulator::step() {
  TickResult result;
  result.tick = tick_;

  // Arbitration order: emergency first, then longer waiting time,
  // then smaller vehicle id. Emergency status only affects priority.
  std::vector<Vehicle*> order;
  for (auto& v : vehicles_) {
    if (!v.finished()) {
      order.push_back(&v);
    }
  }
  std::sort(order.begin(), order.end(), [](const Vehicle* a, const Vehicle* b) {
    if (a->emergency != b->emergency) return a->emergency > b->emergency;
    if (a->waiting != b->waiting) return a->waiting > b->waiting;
    return a->id < b->id;
  });

  // cell -> id of the approved vehicle occupying it this tick.
  std::map<Cell, int> occupied;

  for (Vehicle* v : order) {
    const std::set<Cell> footprint = v->move_footprint();
    const Cell* conflict = nullptr;
    int blocker = -1;
    for (const Cell& c : footprint) {  // std::set iterates deterministically
      if (auto it = occupied.find(c); it != occupied.end()) {
        conflict = &c;
        blocker = it->second;
        break;
      }
    }

    if (conflict == nullptr) {
      for (const Cell& c : footprint) occupied[c] = v->id;
      result.approved.push_back(v->id);
    } else {
      Rejection rej;
      rej.vehicle_id = v->id;
      rej.conflict_cell = *conflict;
      rej.blocking_vehicle_id = blocker;
      std::ostringstream oss;
      oss << "vehicle " << v->id << " rejected: cell " << to_string(*conflict)
          << " already occupied by vehicle " << blocker << " this tick";
      rej.reason = oss.str();
      result.rejected.push_back(std::move(rej));
    }
  }

  // Execute moves and accumulate waiting time.
  for (Vehicle* v : order) {
    VehicleTransition t;
    t.vehicle_id = v->id;
    t.waiting_before = v->waiting;
    const bool moved =
        std::find(result.approved.begin(), result.approved.end(), v->id) !=
        result.approved.end();
    t.moved = moved;
    if (moved) {
      ++v->position;
      v->waiting = 0;
    } else {
      ++v->waiting;
    }
    t.waiting_after = v->waiting;
    result.transitions.push_back(t);
  }

  result.occupancy = std::move(occupied);
  ++tick_;
  return result;
}

bool verify_no_collision(const TickResult& result, std::string* err) {
  // The occupancy map is keyed by cell, so each cell has at most one vehicle
  // by construction; verify the map references only approved vehicles and
  // that no vehicle is both approved and rejected.
  std::set<int> approved(result.approved.begin(), result.approved.end());
  for (const auto& [cell, id] : result.occupancy) {
    if (!approved.count(id)) {
      if (err) {
        *err = "occupancy map references non-approved vehicle " +
               std::to_string(id) + " at " + to_string(cell);
      }
      return false;
    }
  }
  for (const Rejection& r : result.rejected) {
    if (approved.count(r.vehicle_id)) {
      if (err) {
        *err = "vehicle " + std::to_string(r.vehicle_id) +
               " is both approved and rejected";
      }
      return false;
    }
  }
  return true;
}

bool verify_waiting(const TickResult& result, std::string* err) {
  for (const VehicleTransition& t : result.transitions) {
    const int expected = t.moved ? 0 : t.waiting_before + 1;
    if (t.waiting_after != expected) {
      if (err) {
        *err = "vehicle " + std::to_string(t.vehicle_id) +
               " waiting mismatch: expected " + std::to_string(expected) +
               ", got " + std::to_string(t.waiting_after);
      }
      return false;
    }
  }
  return true;
}

}  // namespace trafficsim
