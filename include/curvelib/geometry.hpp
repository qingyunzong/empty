#pragma once

// Exact 2D segment intersection.
//
// Input segments have integer endpoints. A pair of segments either does not
// intersect, intersects in a single point (rational coordinates), or overlaps
// in a collinear segment (whose endpoints are always integer endpoints of the
// inputs). Degenerate (zero-length) segments are supported.

#include "curvelib/rational.hpp"

#include <algorithm>
#include <cstdint>
#include <ostream>

namespace curvelib {

struct Point {
  std::int64_t x = 0;
  std::int64_t y = 0;
  bool operator==(const Point&) const = default;
  auto operator<=>(const Point&) const = default;
};

struct Segment {
  Point a, b;
  bool operator==(const Segment&) const = default;
};

struct RationalPoint {
  Rational x, y;
  bool operator==(const RationalPoint&) const = default;
  bool operator<(const RationalPoint& o) const {
    if (x != o.x) return x < o.x;
    return y < o.y;
  }
};

inline std::ostream& operator<<(std::ostream& os, const RationalPoint& p) {
  return os << "(" << p.x << ", " << p.y << ")";
}

// Exact 2D cross product of integer vectors.
constexpr WideInt cross(Point u, Point v) {
  return static_cast<WideInt>(u.x) * v.y - static_cast<WideInt>(u.y) * v.x;
}

constexpr Point sub(Point u, Point v) { return {u.x - v.x, u.y - v.y}; }

enum class IntersectionKind { None, Point, Overlap };

struct PairIntersection {
  IntersectionKind kind = IntersectionKind::None;
  RationalPoint point;          // valid when kind == Point
  RationalPoint overlap_lo;     // valid when kind == Overlap; lexicographically
  RationalPoint overlap_hi;     // ordered so that lo < hi
};

namespace detail {

inline RationalPoint paramPoint(Point base, Point dir, WideInt t_num,
                                WideInt t_den) {
  // base + (t_num/t_den) * dir, exactly.
  Rational t(t_num, t_den);
  return {Rational(static_cast<WideInt>(base.x)) + t * Rational(static_cast<WideInt>(dir.x)),
          Rational(static_cast<WideInt>(base.y)) + t * Rational(static_cast<WideInt>(dir.y))};
}

// Is integer point p on segment s (exactly)?
inline bool intPointOnSegment(Point p, const Segment& s) {
  if (cross(sub(s.b, s.a), sub(p, s.a)) != 0) return false;
  return std::min(s.a.x, s.b.x) <= p.x && p.x <= std::max(s.a.x, s.b.x) &&
         std::min(s.a.y, s.b.y) <= p.y && p.y <= std::max(s.a.y, s.b.y);
}

} // namespace detail

inline PairIntersection intersect(const Segment& s, const Segment& t) {
  PairIntersection out;

  const bool s_degen = (s.a == s.b);
  const bool t_degen = (t.a == t.b);
  if (s_degen && t_degen) {
    if (s.a == t.a) {
      out.kind = IntersectionKind::Point;
      out.point = {Rational(s.a.x), Rational(s.a.y)};
    }
    return out;
  }
  if (s_degen) {
    if (detail::intPointOnSegment(s.a, t)) {
      out.kind = IntersectionKind::Point;
      out.point = {Rational(s.a.x), Rational(s.a.y)};
    }
    return out;
  }
  if (t_degen) {
    if (detail::intPointOnSegment(t.a, s)) {
      out.kind = IntersectionKind::Point;
      out.point = {Rational(t.a.x), Rational(t.a.y)};
    }
    return out;
  }

  const Point d1 = sub(s.b, s.a);
  const Point d2 = sub(t.b, t.a);
  const WideInt denom = cross(d1, d2);
  const Point ca = sub(t.a, s.a);

  if (denom != 0) {
    // s.a + u*d1 == t.a + v*d2  =>  u = cross(ca,d2)/denom, v = cross(ca,d1)/denom
    WideInt u_num = cross(ca, d2);
    WideInt v_num = cross(ca, d1);
    WideInt den = denom;
    if (den < 0) {
      den = -den;
      u_num = -u_num;
      v_num = -v_num;
    }
    if (u_num < 0 || u_num > den || v_num < 0 || v_num > den) return out;
    out.kind = IntersectionKind::Point;
    out.point = detail::paramPoint(s.a, d1, u_num, den);
    return out;
  }

  // Parallel: collinear?
  if (cross(ca, d1) != 0) return out;

  // Collinear: project onto the dominant axis of d1.
  const bool use_x = (d1.x != 0);
  auto coord = [&](Point p) -> std::int64_t { return use_x ? p.x : p.y; };
  const std::int64_t s_lo = std::min(coord(s.a), coord(s.b));
  const std::int64_t s_hi = std::max(coord(s.a), coord(s.b));
  const std::int64_t t_lo = std::min(coord(t.a), coord(t.b));
  const std::int64_t t_hi = std::max(coord(t.a), coord(t.b));
  const std::int64_t lo = std::max(s_lo, t_lo);
  const std::int64_t hi = std::min(s_hi, t_hi);
  if (lo > hi) return out;

  const WideInt axis = use_x ? d1.x : d1.y;
  auto lift = [&](std::int64_t c) {
    // Parameter along s where the dominant coordinate equals c.
    return detail::paramPoint(s.a, d1, static_cast<WideInt>(c) - coord(s.a),
                              axis);
  };
  if (lo == hi) {
    out.kind = IntersectionKind::Point;
    out.point = lift(lo);
    return out;
  }
  out.kind = IntersectionKind::Overlap;
  RationalPoint p_lo = lift(lo);
  RationalPoint p_hi = lift(hi);
  if (p_hi < p_lo) std::swap(p_lo, p_hi);
  out.overlap_lo = p_lo;
  out.overlap_hi = p_hi;
  return out;
}

} // namespace curvelib
