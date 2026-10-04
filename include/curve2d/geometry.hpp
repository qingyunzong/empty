#pragma once

#include <cstdint>
#include <ostream>
#include <utility>

#include "curve2d/rational.hpp"

namespace curve2d {

// Integer endpoint of a polyline segment.
struct IPoint {
  int64_t x = 0;
  int64_t y = 0;
  bool operator==(const IPoint&) const = default;
  bool operator<(const IPoint& o) const { return x < o.x || (x == o.x && y < o.y); }
};

// Exact point with rational coordinates (intersection points live here).
struct Point {
  Rational x;
  Rational y;
  bool operator==(const Point&) const = default;
  bool operator<(const Point& o) const { return x < o.x || (x == o.x && y < o.y); }
};

struct Segment {
  IPoint a;
  IPoint b;
  bool operator==(const Segment&) const = default;
};

inline std::ostream& operator<<(std::ostream& os, const IPoint& p) {
  return os << "(" << p.x << "," << p.y << ")";
}
inline std::ostream& operator<<(std::ostream& os, const Point& p) {
  return os << "(" << p.x << "," << p.y << ")";
}



// Exact orientation predicate: sign of cross(b - a, c - a).
i128 orient(IPoint a, IPoint b, IPoint c);

enum class PairKind { None, Point, Overlap };

// Result of intersecting two segments.
//  - None:    disjoint.
//  - Point:   single common point (proper crossing or endpoint touch); `point` set.
//  - Overlap: collinear segments sharing a nontrivial segment; `ovA`/`ovB` are its
//             endpoints (always original integer endpoints, ovA < ovB lexicographic).
struct PairResult {
  PairKind kind = PairKind::None;
  Point point{};
  IPoint ovA{};
  IPoint ovB{};
  bool operator==(const PairResult&) const = default;
};

PairResult intersectPair(const Segment& s, const Segment& t);

// Exact certificate primitive: does p lie on segment s (closed)?
bool onSegment(const Segment& s, const Point& p);

} // namespace curve2d
