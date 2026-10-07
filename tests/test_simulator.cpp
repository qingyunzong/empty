#include <cstddef>
#include <vector>

#include "check.hpp"
#include "motion/simulator.hpp"

using motion::Event;
using motion::Particle;
using motion::Rational;
using motion::Simulator;
using motion::SnapshotEntry;

static Particle P(std::size_t id, std::int64_t x, std::int64_t vn,
                  std::int64_t vd = 1) {
  return Particle{id, x, Rational(vn, vd)};
}

static std::vector<Rational> velocities_at(const Simulator& sim,
                                           const Rational& t) {
  std::vector<Rational> out;
  for (const SnapshotEntry& e : sim.snapshot(t)) out.push_back(e.velocity);
  return out;
}

static std::vector<Rational> positions_at(const Simulator& sim,
                                          const Rational& t) {
  std::vector<Rational> out;
  for (const SnapshotEntry& e : sim.snapshot(t)) out.push_back(e.position);
  return out;
}

static void two_particle_exchange() {
  Simulator sim({P(0, 0, 1), P(1, 5, 0)});
  CHECK(sim.next_event_time() == Rational(5));
  CHECK(sim.run(10) == 1);
  const std::vector<Event>& evs = sim.events();
  CHECK(evs.size() == 1);
  CHECK(evs[0].time == Rational(5));
  CHECK(evs[0].groups.size() == 1);
  CHECK(evs[0].groups[0] == (std::vector<std::size_t>{0, 1}));
  CHECK(velocities_at(sim, Rational(5)) ==
        (std::vector<Rational>{Rational(0), Rational(1)}));
  CHECK(positions_at(sim, Rational(5)) ==
        (std::vector<Rational>{Rational(5), Rational(5)}));
  CHECK(!sim.next_event_time().has_value());
}

static void exact_rational_event_time() {
  // gap 1, closing speed 1/2 + 1/3 = 5/6  =>  contact at t = 6/5, x = 3/5.
  Simulator sim({P(0, 0, 1, 2), P(1, 1, -1, 3)});
  CHECK(sim.run(10) == 1);
  CHECK_RAT_EQ(sim.events()[0].time, Rational(6, 5));
  const std::vector<Rational> pos = positions_at(sim, Rational(6, 5));
  CHECK_RAT_EQ(pos[0], Rational(3, 5));
  CHECK_RAT_EQ(pos[1], Rational(3, 5));
  CHECK(velocities_at(sim, Rational(6, 5)) ==
        (std::vector<Rational>{Rational(-1, 3), Rational(1, 2)}));
}

static void triple_simultaneous_reversal() {
  // All three meet at x = 2 when t = 1: velocities (2,1,0) -> (0,1,2).
  Simulator sim({P(0, 0, 2), P(1, 1, 1), P(2, 2, 0)});
  CHECK(sim.run(10) == 1);
  const Event& ev = sim.events()[0];
  CHECK(ev.time == Rational(1));
  CHECK(ev.groups.size() == 1);
  CHECK(ev.groups[0] == (std::vector<std::size_t>{0, 1, 2}));
  CHECK(velocities_at(sim, Rational(1)) ==
        (std::vector<Rational>{Rational(0), Rational(1), Rational(2)}));
  CHECK(positions_at(sim, Rational(1)) ==
        (std::vector<Rational>{Rational(2), Rational(2), Rational(2)}));
}

static void group_of_four_reversal() {
  // All four meet at x = 3 when t = 1: velocities (3,2,1,0) -> (0,1,2,3).
  Simulator sim({P(0, 0, 3), P(1, 1, 2), P(2, 2, 1), P(3, 3, 0)});
  CHECK(sim.run(10) == 1);
  const Event& ev = sim.events()[0];
  CHECK(ev.time == Rational(1));
  CHECK(ev.groups.size() == 1);
  CHECK(ev.groups[0].size() == 4);
  CHECK(velocities_at(sim, Rational(1)) ==
        (std::vector<Rational>{Rational(0), Rational(1), Rational(2),
                               Rational(3)}));
}

static void disjoint_groups_same_instant() {
  // Two independent pairs collide at t = 1; final velocities separate.
  Simulator sim({P(0, 0, 2), P(1, 1, 1), P(2, 5, 5), P(3, 7, 3)});
  CHECK(sim.run(10) == 1);
  const Event& ev = sim.events()[0];
  CHECK(ev.time == Rational(1));
  CHECK(ev.groups.size() == 2);
  CHECK(ev.groups[0] == (std::vector<std::size_t>{0, 1}));
  CHECK(ev.groups[1] == (std::vector<std::size_t>{2, 3}));
  CHECK(velocities_at(sim, Rational(1)) ==
        (std::vector<Rational>{Rational(1), Rational(2), Rational(3),
                               Rational(5)}));
}

static void zero_distance_initial_state_first() {
  // Coincident particles are a contact at t = 0, processed before anything.
  Simulator sim({P(0, 0, 1), P(1, 0, -1)});
  CHECK(sim.next_event_time() == Rational(0));
  CHECK(sim.run(10) == 1);
  CHECK(sim.events()[0].time == Rational(0));
  CHECK(velocities_at(sim, Rational(0)) ==
        (std::vector<Rational>{Rational(-1), Rational(1)}));
}

static void zero_distance_cascade() {
  // Velocities (2,0,1) at one point: two resolution rounds at t = 0.
  Simulator sim({P(0, 0, 2), P(1, 0, 0), P(2, 0, 1)});
  CHECK(sim.run(10) == 2);
  CHECK(sim.events()[0].time == Rational(0));
  CHECK(sim.events()[1].time == Rational(0));
  CHECK(velocities_at(sim, Rational(0)) ==
        (std::vector<Rational>{Rational(0), Rational(1), Rational(2)}));
}

static void chained_events_and_run_until() {
  // Events at t = 3/2, 2 and 3.
  Simulator sim({P(0, 0, 2), P(1, 3, 0), P(2, 6, -1)});
  CHECK(sim.run_until(Rational(1)) == 0);
  CHECK(sim.events().empty());
  CHECK(sim.run_until(Rational(3, 2)) == 1);
  CHECK(sim.run_until(Rational(2)) == 1);
  CHECK(sim.events().size() == 2);
  CHECK_RAT_EQ(sim.events()[0].time, Rational(3, 2));
  CHECK_RAT_EQ(sim.events()[1].time, Rational(2));
  // Mid-flight snapshot interpolated exactly between events.
  const std::vector<Rational> pos = positions_at(sim, Rational(2));
  CHECK(pos == (std::vector<Rational>{Rational(3), Rational(4), Rational(4)}));
  CHECK(velocities_at(sim, Rational(2)) ==
        (std::vector<Rational>{Rational(0), Rational(-1), Rational(2)}));
  CHECK(sim.run_until(Rational(3)) == 1);
  CHECK_RAT_EQ(sim.events()[2].time, Rational(3));
  CHECK(!sim.next_event_time().has_value());
  CHECK(velocities_at(sim, Rational(3)) ==
        (std::vector<Rational>{Rational(-1), Rational(0), Rational(2)}));
}

static void no_collision_when_separating() {
  Simulator sim({P(0, 0, -1), P(1, 5, 1)});
  CHECK(sim.run(10) == 0);
  CHECK(sim.events().empty());
}

int main() {
  two_particle_exchange();
  exact_rational_event_time();
  triple_simultaneous_reversal();
  group_of_four_reversal();
  disjoint_groups_same_instant();
  zero_distance_initial_state_first();
  zero_distance_cascade();
  chained_events_and_run_until();
  no_collision_when_separating();
  return 0;
}
