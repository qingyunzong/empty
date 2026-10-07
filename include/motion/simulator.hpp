#pragma once

// Event-driven simulation of 1D point particles.
//
// Model:
//   * Particles start at integer positions with rational velocities.
//   * When two adjacent particles touch they exchange velocities
//     (equal-mass elastic collision), so the left-to-right order of the
//     particles is an invariant of the system.
//   * When several particles are in contact at the same instant, the
//     colliding adjacent pairs are chained into contiguous contact groups
//     and the velocity sequence of each group is reversed as a whole.
//   * Zero-distance initial configurations are contacts at t = 0 and are
//     therefore processed before any later event.
//
// All event times and positions are exact rational numbers.

#include "motion/rational.hpp"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <queue>
#include <set>
#include <utility>
#include <vector>

namespace motion {

struct Particle {
  std::size_t id;
  std::int64_t position;
  Rational velocity;
};

// One resolution round: every contact group whose velocity sequence was
// reversed at `time`. Each group holds the particle ids in left-to-right
// order. Several events may share the same time stamp when resolving one
// instant requires multiple rounds.
struct Event {
  Rational time;
  std::vector<std::vector<std::size_t>> groups;
};

struct SnapshotEntry {
  std::size_t id;
  Rational position;
  Rational velocity;
};

class Simulator {
public:
  explicit Simulator(std::vector<Particle> particles) {
    std::sort(particles.begin(), particles.end(),
              [](const Particle& a, const Particle& b) {
                if (a.position != b.position) return a.position < b.position;
                return a.id < b.id;
              });
    nodes_.reserve(particles.size());
    for (const Particle& p : particles)
      nodes_.push_back(Node{p.id, Rational(p.position), Rational(0), p.velocity, 0});
    for (std::size_t i = 0; i + 1 < nodes_.size(); ++i) schedule(i);
  }

  // Time of the most recently processed event (0 before the first one).
  [[nodiscard]] const Rational& time() const { return t_; }
  [[nodiscard]] std::size_t particle_count() const { return nodes_.size(); }
  [[nodiscard]] const std::vector<Event>& events() const { return events_; }

  // Time of the next pending event, if any.
  std::optional<Rational> next_event_time() {
    discard_stale();
    if (heap_.empty()) return std::nullopt;
    return heap_.top().time;
  }

  // Processes the next resolution round. Returns std::nullopt when no
  // further collisions can happen.
  std::optional<Event> step() {
    discard_stale();
    if (heap_.empty()) return std::nullopt;

    const Rational t = heap_.top().time;
    std::vector<std::size_t> pairs;
    while (!heap_.empty() && heap_.top().time == t) {
      const QEntry e = heap_.top();
      heap_.pop();
      if (valid(e)) pairs.push_back(e.pair);
    }
    t_ = t;

    std::sort(pairs.begin(), pairs.end());
    pairs.erase(std::unique(pairs.begin(), pairs.end()), pairs.end());

    // Chain colliding adjacent pairs into contiguous contact groups.
    // Group [l, r] denotes the inclusive particle index range.
    std::vector<std::pair<std::size_t, std::size_t>> ranges;
    for (std::size_t k = 0; k < pairs.size();) {
      std::size_t j = k;
      while (j + 1 < pairs.size() && pairs[j + 1] == pairs[j] + 1) ++j;
      ranges.emplace_back(pairs[k], pairs[j] + 1);
      k = j + 1;
    }

    Event ev;
    ev.time = t;
    for (const auto& [l, r] : ranges) {
      std::vector<Rational> vels;
      vels.reserve(r - l + 1);
      for (std::size_t i = l; i <= r; ++i) vels.push_back(nodes_[i].vel);
      std::vector<std::size_t> ids;
      for (std::size_t i = l; i <= r; ++i) {
        Node& n = nodes_[i];
        const Rational p = position_at(n, t);
        n.anchor_pos = p;
        n.anchor_time = t;
        n.vel = vels[r - i]; // reversed velocity order within the group
        ++n.ver;
        ids.push_back(n.id);
      }
      ev.groups.push_back(std::move(ids));
    }

    // Reschedule every pair whose collision time may have changed.
    std::set<std::size_t> dirty;
    for (const auto& [l, r] : ranges) {
      const std::size_t first = (l > 0) ? l - 1 : 0;
      const std::size_t last = std::min(r, nodes_.size() - 1 > 0 ? nodes_.size() - 2 : 0);
      for (std::size_t i = first; i <= last && i + 1 < nodes_.size(); ++i)
        dirty.insert(i);
    }
    for (const std::size_t i : dirty) schedule(i);

    events_.push_back(ev);
    return ev;
  }

  // Processes at most `max_rounds` rounds; returns how many were processed.
  std::size_t run(std::size_t max_rounds) {
    std::size_t done = 0;
    while (done < max_rounds && step()) ++done;
    return done;
  }

  // Processes every event with time <= `t`.
  std::size_t run_until(const Rational& t) {
    std::size_t done = 0;
    while (true) {
      const std::optional<Rational> nt = next_event_time();
      if (!nt || *nt > t) break;
      step();
      ++done;
    }
    return done;
  }

  // Positions and velocities at time `t` (requires t >= time()), in
  // left-to-right particle order.
  [[nodiscard]] std::vector<SnapshotEntry> snapshot(const Rational& t) const {
    std::vector<SnapshotEntry> out;
    out.reserve(nodes_.size());
    for (const Node& n : nodes_)
      out.push_back(SnapshotEntry{n.id, position_at(n, t), n.vel});
    return out;
  }

private:
  struct Node {
    std::size_t id;
    Rational anchor_pos;
    Rational anchor_time;
    Rational vel;
    std::uint64_t ver;
  };

  struct QEntry {
    Rational time;
    std::size_t pair;
    std::uint64_t left_ver;
    std::uint64_t right_ver;
  };

  struct QLater {
    bool operator()(const QEntry& a, const QEntry& b) const {
      if (a.time != b.time) return b.time < a.time;
      return a.pair > b.pair;
    }
  };

  static Rational position_at(const Node& n, const Rational& t) {
    return n.anchor_pos + n.vel * (t - n.anchor_time);
  }

  bool valid(const QEntry& e) const {
    return nodes_[e.pair].ver == e.left_ver && nodes_[e.pair + 1].ver == e.right_ver;
  }

  void discard_stale() {
    while (!heap_.empty() && !valid(heap_.top())) heap_.pop();
  }

  void schedule(std::size_t i) {
    const Node& left = nodes_[i];
    const Node& right = nodes_[i + 1];
    const Rational dv = left.vel - right.vel;
    if (dv > Rational(0)) {
      const Rational gap = position_at(right, t_) - position_at(left, t_);
      heap_.push(QEntry{t_ + gap / dv, i, left.ver, right.ver});
    }
  }

  std::vector<Node> nodes_;
  std::priority_queue<QEntry, std::vector<QEntry>, QLater> heap_;
  Rational t_{0};
  std::vector<Event> events_;
};

} // namespace motion
