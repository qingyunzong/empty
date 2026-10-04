// Acceptance by exhaustive enumeration over small coordinates.
//
// Every segment pair with endpoints in {-2..2}^2 (including degenerate
// segments) is checked against an independent reference implementation that
// uses the determinant line-intersection formula and endpoint-containment
// overlap extraction (a different formulation from the library's parametric
// approach). The aggregated CurveLibrary results (built from random batches)
// are then compared against the reference-derived expected maps and certified
// exactly.

#include "curvelib/certificate.hpp"
#include "curvelib/curve_library.hpp"
#include "test_util.hpp"

#include <algorithm>
#include <cstdio>
#include <map>
#include <random>
#include <set>
#include <vector>

using namespace curvelib;

namespace reference {

struct Result {
  IntersectionKind kind = IntersectionKind::None;
  RationalPoint point, lo, hi;
};

bool intPointOnSeg(Point p, const Segment& s) {
  if (cross(sub(s.b, s.a), sub(p, s.a)) != 0) return false;
  return std::min(s.a.x, s.b.x) <= p.x && p.x <= std::max(s.a.x, s.b.x) &&
         std::min(s.a.y, s.b.y) <= p.y && p.y <= std::max(s.a.y, s.b.y);
}

bool rationalPointOnSeg(const RationalPoint& p, const Segment& s) {
  const Rational ax(s.a.x), ay(s.a.y), bx(s.b.x), by(s.b.y);
  const Rational cr = (bx - ax) * (p.y - ay) - (by - ay) * (p.x - ax);
  if (!cr.isZero()) return false;
  const Rational dot = (p.x - ax) * (p.x - bx) + (p.y - ay) * (p.y - by);
  return dot.sign() <= 0;
}

Result intersect(const Segment& s, const Segment& t) {
  Result out;
  const bool sd = (s.a == s.b), td = (t.a == t.b);
  if (sd || td) {
    if (sd && td) {
      if (s.a == t.a) {
        out.kind = IntersectionKind::Point;
        out.point = {Rational(s.a.x), Rational(s.a.y)};
      }
    } else if (sd ? intPointOnSeg(s.a, t) : intPointOnSeg(t.a, s)) {
      const Point p = sd ? s.a : t.a;
      out.kind = IntersectionKind::Point;
      out.point = {Rational(p.x), Rational(p.y)};
    }
    return out;
  }

  // Determinant (Cramer) line intersection - independent formulation.
  const WideInt x1 = s.a.x, y1 = s.a.y, x2 = s.b.x, y2 = s.b.y;
  const WideInt x3 = t.a.x, y3 = t.a.y, x4 = t.b.x, y4 = t.b.y;
  const WideInt den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (den != 0) {
    const WideInt d1 = x1 * y2 - y1 * x2;
    const WideInt d2 = x3 * y4 - y3 * x4;
    RationalPoint p{Rational(d1 * (x3 - x4) - (x1 - x2) * d2, den),
                    Rational(d1 * (y3 - y4) - (y1 - y2) * d2, den)};
    if (rationalPointOnSeg(p, s) && rationalPointOnSeg(p, t)) {
      out.kind = IntersectionKind::Point;
      out.point = p;
    }
    return out;
  }
  // Parallel: collinear iff an endpoint of t lies on the line of s.
  if (cross(sub(s.b, s.a), sub(t.a, s.a)) != 0) return out;
  // Overlap endpoints = endpoints lying on both segments.
  std::set<RationalPoint> shared;
  for (Point p : {s.a, s.b})
    if (intPointOnSeg(p, t)) shared.insert({Rational(p.x), Rational(p.y)});
  for (Point p : {t.a, t.b})
    if (intPointOnSeg(p, s)) shared.insert({Rational(p.x), Rational(p.y)});
  if (shared.empty()) return out;
  if (shared.size() == 1) {
    out.kind = IntersectionKind::Point;
    out.point = *shared.begin();
    return out;
  }
  out.kind = IntersectionKind::Overlap;
  out.lo = *shared.begin();
  out.hi = *shared.rbegin();
  return out;
}

} // namespace reference

int main() {
  // All points and all undirected segments on the grid {-2..2}^2.
  std::vector<Point> grid;
  for (std::int64_t x = -2; x <= 2; ++x)
    for (std::int64_t y = -2; y <= 2; ++y) grid.push_back({x, y});
  std::vector<Segment> segs;
  for (std::size_t i = 0; i < grid.size(); ++i)
    for (std::size_t j = i; j < grid.size(); ++j)
      segs.push_back({grid[i], grid[j]});

  std::size_t n_none = 0, n_point = 0, n_overlap = 0;
  std::int64_t max_den = 1;
  std::set<RationalPoint> distinct_points;

  // Expected aggregated results, derived from the reference implementation.
  std::map<RationalPoint, std::set<EdgeId>> exp_points;
  std::set<OverlapSegment> exp_overlaps;

  bool ok = true;
  for (std::size_t i = 0; i < segs.size() && ok; ++i) {
    for (std::size_t j = 0; j < i; ++j) {
      const PairIntersection got = intersect(segs[i], segs[j]);
      const reference::Result want = reference::intersect(segs[i], segs[j]);
      // Also check operand-order symmetry of the library.
      const PairIntersection got_swapped = intersect(segs[j], segs[i]);

      bool match = got.kind == want.kind;
      if (match && want.kind == IntersectionKind::Point)
        match = got.point == want.point;
      if (match && want.kind == IntersectionKind::Overlap)
        match = got.overlap_lo == want.lo && got.overlap_hi == want.hi;
      bool symmetric =
          got_swapped.kind == got.kind &&
          (got.kind != IntersectionKind::Point ||
           got_swapped.point == got.point) &&
          (got.kind != IntersectionKind::Overlap ||
           (got_swapped.overlap_lo == got.overlap_lo &&
            got_swapped.overlap_hi == got.overlap_hi));
      if (!match || !symmetric) {
        ok = false;
        std::fprintf(stderr,
                     "MISMATCH pair (%zu,%zu) kind lib=%d ref=%d sym=%d\n", i,
                     j, static_cast<int>(got.kind), static_cast<int>(want.kind),
                     static_cast<int>(symmetric));
        break;
      }
      switch (want.kind) {
      case IntersectionKind::None: ++n_none; break;
      case IntersectionKind::Point:
        ++n_point;
        distinct_points.insert(want.point);
        max_den = std::max(max_den, want.point.x.den());
        max_den = std::max(max_den, want.point.y.den());
        exp_points[want.point].insert(j);
        exp_points[want.point].insert(i);
        break;
      case IntersectionKind::Overlap:
        ++n_overlap;
        exp_overlaps.insert(OverlapSegment{want.lo, want.hi, j, i});
        break;
      }
    }
  }
  CHECK_MSG(ok, "per-pair enumeration mismatch");
  std::printf(
      "enumeration: %zu segments, %zu pairs: none=%zu point=%zu overlap=%zu, "
      "%zu distinct points, max denominator=%lld\n",
      segs.size(), segs.size() * (segs.size() - 1) / 2, n_none, n_point,
      n_overlap, distinct_points.size(), static_cast<long long>(max_den));

  // Aggregate through the library in random batches; must equal the
  // reference-derived expectation and certify exactly.
  std::mt19937_64 rng(7);
  std::vector<Segment> shuffled = segs;
  std::shuffle(shuffled.begin(), shuffled.end(), rng);
  CurveLibrary lib;
  std::size_t pos = 0;
  while (pos < shuffled.size()) {
    const std::size_t take = std::min<std::size_t>(shuffled.size() - pos, 37);
    lib.addEdges({shuffled.begin() + static_cast<std::ptrdiff_t>(pos),
                  shuffled.begin() + static_cast<std::ptrdiff_t>(pos + take)});
    pos += take;
  }
  // Edge order in the library differs from `segs`; rebuild expectations in
  // the library's edge id space.
  std::map<std::pair<Point, Point>, std::vector<EdgeId>> canon;
  for (EdgeId e = 0; e < lib.edges().size(); ++e) {
    Segment s = lib.edges()[e];
    if (s.b.x < s.a.x || (s.b.x == s.a.x && s.b.y < s.a.y))
      std::swap(s.a, s.b);
    canon[{s.a, s.b}].push_back(e);
  }
  std::map<RationalPoint, std::set<EdgeId>> exp_points_lib;
  std::set<OverlapSegment> exp_overlaps_lib;
  for (std::size_t i = 0; i < segs.size(); ++i)
    for (std::size_t j = 0; j < i; ++j) {
      const reference::Result r = reference::intersect(segs[i], segs[j]);
      if (r.kind == IntersectionKind::None) continue;
      Segment ci = segs[i], cj = segs[j];
      if (ci.b.x < ci.a.x || (ci.b.x == ci.a.x && ci.b.y < ci.a.y))
        std::swap(ci.a, ci.b);
      if (cj.b.x < cj.a.x || (cj.b.x == cj.a.x && cj.b.y < cj.a.y))
        std::swap(cj.a, cj.b);
      const auto& ids_i = canon[{ci.a, ci.b}];
      const auto& ids_j = canon[{cj.a, cj.b}];
      for (EdgeId ei : ids_i)
        for (EdgeId ej : ids_j) {
          if (ei == ej) continue;
          if (r.kind == IntersectionKind::Point) {
            exp_points_lib[r.point].insert(ei);
            exp_points_lib[r.point].insert(ej);
          } else {
            exp_overlaps_lib.insert(OverlapSegment{
                r.lo, r.hi, std::min(ei, ej), std::max(ei, ej)});
          }
        }
    }
  CHECK(lib.pointIntersections() == exp_points_lib);
  CHECK(lib.overlaps() == exp_overlaps_lib);

  // Incremental == full recomputation on the whole grid.
  CurveLibrary rebuilt = lib;
  rebuilt.recomputeAll();
  CHECK(lib.sameResults(rebuilt));

  // Exact certificates for every reported item.
  CertificateReport cert = certifyAll(lib, /*strict_sources=*/true);
  CHECK_MSG(cert.ok, cert.message);

  std::printf("library: %zu edges, %zu intersection points, %zu overlaps, "
              "certificates: %s\n",
              lib.edges().size(), lib.pointIntersections().size(),
              lib.overlaps().size(), cert.ok ? "OK" : "FAILED");

  return testutil::summary("enumeration");
}
