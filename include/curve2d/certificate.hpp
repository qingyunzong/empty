#pragma once

#include "curve2d/library.hpp"

namespace curve2d {

// Exact verification of an intersection set against a segment set.
// Every check uses exact rational / integer arithmetic (no floating point):
//  - each reported point lies on every edge attributed to it, and at least
//    two distinct edges are attributed;
//  - each reported overlap has distinct endpoints, both lying on every
//    attributed edge (which also forces all those edges to be collinear
//    with the overlap line), with at least two distinct edges attributed.
inline bool verifyIntersections(const std::map<EdgeId, Segment>& segs,
                                const IntersectionSet& r) {
  for (const PointIntersection& pi : r.points) {
    if (pi.edges.size() < 2) return false;
    for (EdgeId e : pi.edges) {
      auto it = segs.find(e);
      if (it == segs.end() || !onSegment(it->second, pi.p)) return false;
    }
  }
  for (const OverlapSegment& ov : r.overlaps) {
    if (!(ov.a < ov.b)) return false;
    if (ov.edges.size() < 2) return false;
    Point pa{Rational(ov.a.x), Rational(ov.a.y)};
    Point pb{Rational(ov.b.x), Rational(ov.b.y)};
    for (EdgeId e : ov.edges) {
      auto it = segs.find(e);
      if (it == segs.end()) return false;
      if (!onSegment(it->second, pa) || !onSegment(it->second, pb)) return false;
    }
  }
  return true;
}

inline bool verifyIntersections(const CurveLibrary& lib, const IntersectionSet& r) {
  return verifyIntersections(lib.segments(), r);
}

} // namespace curve2d
