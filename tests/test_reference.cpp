// Cross-checks the event-driven simulator against an independent,
// fine-grained reference that resolves collisions one pair swap at a time,
// plus per-event invariants, over many random small systems.

#include <algorithm>
#include <optional>
#include <random>
#include <utility>
#include <vector>

#include "check.hpp"
#include "motion/simulator.hpp"

using motion::Event;
using motion::Particle;
using motion::Rational;
using motion::Simulator;
using motion::SnapshotEntry;

namespace {

// Fine-grained reference: advances to the next collision and swaps exactly
// one adjacent pair per round, recomputing everything from scratch.
struct PairwiseReference {
  std::vector<Rational> pos; // left-to-right order (an invariant)
  std::vector<Rational> vel;
  Rational t{0};

  std::optional<Rational> next_time() const {
    std::optional<Rational> best;
    for (std::size_t i = 0; i + 1 < pos.size(); ++i) {
      if (vel[i] > vel[i + 1]) {
        const Rational dt = (pos[i + 1] - pos[i]) / (vel[i] - vel[i + 1]);
        if (!best || dt < *best) best = dt;
      }
    }
    if (!best) return std::nullopt;
    return t + *best;
  }

  void apply_one() {
    const std::optional<Rational> nt = next_time();
    CHECK(nt.has_value());
    const Rational dt = *nt - t;
    for (std::size_t i = 0; i < pos.size(); ++i) pos[i] += vel[i] * dt;
    t = *nt;
    for (std::size_t i = 0; i + 1 < pos.size(); ++i) {
      if (vel[i] > vel[i + 1] && pos[i + 1] - pos[i] == Rational(0)) {
        std::swap(vel[i], vel[i + 1]);
        return;
      }
    }
    CHECK(false); // unreachable: a pending event implies a touching pair
  }
};

struct Trial {
  std::vector<Particle> particles;
  std::vector<Rational> sorted_pos;
  std::vector<Rational> sorted_vel;
};

Trial make_trial(std::mt19937_64& rng) {
  const std::size_t n = 2 + rng() % 6;
  Trial trial;
  std::vector<std::int64_t> xs(n);
  for (auto& x : xs) x = static_cast<std::int64_t>(rng() % 5) - 2; // duplicates likely
  std::sort(xs.begin(), xs.end());
  for (std::size_t i = 0; i < n; ++i) {
    const std::int64_t vn = static_cast<std::int64_t>(rng() % 11) - 5;
    const std::int64_t vd = 1 + static_cast<std::int64_t>(rng() % 3);
    trial.particles.push_back(Particle{i, xs[i], Rational(vn, vd)});
    trial.sorted_pos.push_back(Rational(xs[i]));
    trial.sorted_vel.emplace_back(vn, vd);
  }
  return trial; // ids 0..n-1 already satisfy the (position, id) sort order
}

void check_instant_resolved(const Simulator& sim, const Rational& t) {
  // Once an instant is fully resolved, coincident particles must have
  // non-decreasing velocities (no pending zero-distance collisions).
  const std::vector<SnapshotEntry> snap = sim.snapshot(t);
  for (std::size_t i = 0; i + 1 < snap.size(); ++i)
    if (snap[i].position == snap[i + 1].position)
      CHECK(snap[i].velocity <= snap[i + 1].velocity);
}

void run_trial(const Trial& trial) {
  Simulator sim(trial.particles);
  PairwiseReference ref{trial.sorted_pos, trial.sorted_vel, Rational(0)};

  std::vector<Rational> sim_times;
  std::vector<Rational> ref_times;

  constexpr std::size_t kMaxRounds = 1000;
  std::size_t rounds = 0;
  while (rounds < kMaxRounds) {
    const std::optional<Event> ev = sim.step();
    if (!ev) break;
    ++rounds;
    sim_times.push_back(ev->time);

    const bool instant_resolved =
        !sim.next_event_time() || *sim.next_event_time() != ev->time;
    if (!instant_resolved) continue; // more rounds at the same instant pending

    // Drain every reference round happening at the same instant.
    while (ref.next_time() && *ref.next_time() == ev->time) {
      ref.apply_one();
      ref_times.push_back(ev->time);
    }

    const std::vector<SnapshotEntry> snap = sim.snapshot(ev->time);
    for (std::size_t i = 0; i < snap.size(); ++i) {
      CHECK_RAT_EQ(snap[i].position, ref.pos[i]);
      CHECK_RAT_EQ(snap[i].velocity, ref.vel[i]);
    }
    check_instant_resolved(sim, ev->time);
  }
  CHECK(rounds < kMaxRounds); // the system must terminate
  CHECK(!ref.next_time().has_value()); // reference agrees: nothing left

  // Distinct event times must coincide exactly.
  std::vector<Rational> sim_distinct = sim_times;
  sim_distinct.erase(std::unique(sim_distinct.begin(), sim_distinct.end()),
                     sim_distinct.end());
  std::vector<Rational> ref_distinct = ref_times;
  ref_distinct.erase(std::unique(ref_distinct.begin(), ref_distinct.end()),
                     ref_distinct.end());
  CHECK(sim_distinct == ref_distinct);

  // Free flight after the last event: compare at a later rational time.
  const Rational horizon = sim.time() + Rational(5, 2);
  const std::vector<SnapshotEntry> snap = sim.snapshot(horizon);
  for (std::size_t i = 0; i < snap.size(); ++i) {
    CHECK_RAT_EQ(snap[i].position, ref.pos[i] + ref.vel[i] * (horizon - ref.t));
    CHECK_RAT_EQ(snap[i].velocity, ref.vel[i]);
  }
}

} // namespace

int main() {
  for (std::uint64_t seed = 0; seed < 500; ++seed) {
    std::mt19937_64 rng(seed * 7919 + 13);
    run_trial(make_trial(rng));
  }
  return 0;
}
