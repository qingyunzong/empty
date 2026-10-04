#pragma once

// Exact certificates for curve-library results.
//
// Every check uses exact rational arithmetic only:
//   * a reported point must lie on every claimed source edge, and (in strict
//     mode) on no other edge;
//   * a reported overlap must have distinct endpoints, both lying on both
//     source edges, the two edges must be collinear, and each overlap
//     endpoint must coincide with an endpoint of one of the source edges
//     (maximality of the shared sub-segment).

#include "curvelib/curve_library.hpp"

#include <string>

namespace curvelib {

// Exact point-on-segment test for rational points: collinearity via cross
// product and containment via non-positive dot product (p-a)·(p-b) <= 0.
inline bool pointOnSegment(const RationalPoint& p, const Segment& s) {
  const Rational ax(s.a.x), ay(s.a.y), bx(s.b.x), by(s.b.y);
  const Rational cross = (bx - ax) * (p.y - ay) - (by - ay) * (p.x - ax);
  if (!cross.isZero()) return false;
  const Rational dot = (p.x - ax) * (p.x - bx) + (p.y - ay) * (p.y - by);
  return dot.sign() <= 0;
}

struct CertificateReport {
  bool ok = true;
  std::string message;
};

inline CertificateReport certifyPointIntersection(
    const RationalPoint& p, const std::set<EdgeId>& sources,
    const std::vector<Segment>& edges, bool strict_sources) {
  if (sources.size() < 2)
    return {false, "point " + std::string("has fewer than 2 source edges")};
  for (EdgeId e : sources) {
    if (e >= edges.size()) return {false, "source edge id out of range"};
    if (!pointOnSegment(p, edges[e]))
      return {false, "point does not lie on a claimed source edge"};
  }
  if (strict_sources)
    for (EdgeId e = 0; e < edges.size(); ++e)
      if (!sources.count(e) && pointOnSegment(p, edges[e]))
        return {false, "point lies on an edge missing from the source set"};
  return {true, {}};
}

inline CertificateReport certifyOverlap(const OverlapSegment& o,
                                        const std::vector<Segment>& edges) {
  if (o.lo == o.hi) return {false, "overlap endpoints coincide"};
  if (o.e1 == o.e2 || o.e2 >= edges.size())
    return {false, "invalid overlap source edges"};
  const Segment& s1 = edges[o.e1];
  const Segment& s2 = edges[o.e2];
  for (const RationalPoint* p : {&o.lo, &o.hi})
    for (const Segment* s : {&s1, &s2})
      if (!pointOnSegment(*p, *s))
        return {false, "overlap endpoint not on a source edge"};
  // Edges must be collinear.
  if (cross(sub(s1.b, s1.a), sub(s2.b, s2.a)) != 0 ||
      cross(sub(s1.b, s1.a), sub(s2.a, s1.a)) != 0)
    return {false, "overlap source edges are not collinear"};
  // Maximality: each overlap endpoint is an endpoint of a source edge.
  auto is_endpoint_of = [](const RationalPoint& p, const Segment& s) {
    const RationalPoint a{Rational(s.a.x), Rational(s.a.y)};
    const RationalPoint b{Rational(s.b.x), Rational(s.b.y)};
    return p == a || p == b;
  };
  for (const RationalPoint* p : {&o.lo, &o.hi})
    if (!is_endpoint_of(*p, s1) && !is_endpoint_of(*p, s2))
      return {false, "overlap endpoint is not maximal"};
  return {true, {}};
}

// Certify every reported item. With strict_sources, point source sets must be
// exactly the set of edges passing through the point.
inline CertificateReport certifyAll(const CurveLibrary& lib,
                                    bool strict_sources = true) {
  for (const auto& [p, sources] : lib.pointIntersections()) {
    CertificateReport r =
        certifyPointIntersection(p, sources, lib.edges(), strict_sources);
    if (!r.ok) return {false, "point " + p.x.toString() + "," + p.y.toString() +
                                  ": " + r.message};
  }
  for (const OverlapSegment& o : lib.overlaps()) {
    CertificateReport r = certifyOverlap(o, lib.edges());
    if (!r.ok) return {false, "overlap: " + r.message};
  }
  return {true, {}};
}

} // namespace curvelib
