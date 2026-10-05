#pragma once

#include <array>
#include <cstdint>

#include "spatial/rational.hpp"

namespace spatial {

struct Aabb {
  std::array<std::int64_t, 3> lo{};
  std::array<std::int64_t, 3> hi{};
};

inline Aabb unite(const Aabb& a, const Aabb& b) {
  Aabb out;
  for (int i = 0; i < 3; ++i) {
    out.lo[i] = a.lo[i] < b.lo[i] ? a.lo[i] : b.lo[i];
    out.hi[i] = a.hi[i] > b.hi[i] ? a.hi[i] : b.hi[i];
  }
  return out;
}

struct Ray {
  std::array<std::int64_t, 3> origin{};
  std::array<std::int64_t, 3> dir{};  // not all zero
};

struct RayBoxHit {
  bool hit = false;
  Rational t_enter;
  Rational t_exit;
};

// Exact slab test with rational ray parameter. Boundary contact counts as a
// hit (intervals are compared with strict '>' for the miss case, so a touch
// where enter == exit is included). t is clipped to [0, t_max].
inline RayBoxHit ray_intersect(const Aabb& b, const Ray& r, Rational t_max) {
  Rational t_enter = make_rational(0, 1);
  Rational t_exit = t_max;
  for (int i = 0; i < 3; ++i) {
    const std::int64_t p = r.origin[i];
    const std::int64_t d = r.dir[i];
    if (d == 0) {
      if (p < b.lo[i] || p > b.hi[i]) return {};
      continue;
    }
    Rational t1 = make_rational(b.lo[i] - p, d);
    Rational t2 = make_rational(b.hi[i] - p, d);
    if (t2 < t1) {
      const Rational tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > t_enter) t_enter = t1;
    if (t2 < t_exit) t_exit = t2;
    if (t_enter > t_exit) return {};
  }
  return {true, t_enter, t_exit};
}

}  // namespace spatial
