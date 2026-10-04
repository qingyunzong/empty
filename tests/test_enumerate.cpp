// Acceptance by exhaustive enumeration over small coordinates.
//
// For every segment pair (and selected triples) drawn from small integer
// grids we:
//   1. cross-check the library's exact pair intersection against an
//      independent naive implementation (different formulation);
//   2. verify exact certificates for every reported item;
//   3. check dedup: each reported point/overlap carries exactly the edges
//      that pass through it;
//   4. check incremental == full-pairwise results.
#include <algorithm>
#include <cstdio>
#include <set>
#include <vector>

#include "check.hpp"
#include "curve2d/certificate.hpp"
#include "curve2d/library.hpp"

using namespace curve2d;

namespace {

// Independent reference implementation: witness-endpoint formulation.
//  - Non-parallel lines: unique crossing via Cramer's rule in Rational,
//    accepted iff it lies on both closed segments.
//  - Parallel lines: collinear case reduces to collecting the distinct
//    original endpoints that lie on the other segment (0/1/2 of them).
PairResult naivePair(const Segment& s, const Segment& t) {
  i128 rx = static_cast<i128>(s.b.x) - s.a.x;
  i128 ry = static_cast<i128>(s.b.y) - s.a.y;
  i128 sx = static_cast<i128>(t.b.x) - t.a.x;
  i128 sy = static_cast<i128>(t.b.y) - t.a.y;
  i128 det = rx * sy - ry * sx;

  if (det != 0) {
    // Solve s.a + u*(r) = t.a + v*(s) by Cramer.
    i128 ex = static_cast<i128>(t.a.x) - s.a.x;
    i128 ey = static_cast<i128>(t.a.y) - s.a.y;
    Rational u(ex * sy - ey * sx, det);
    Point p{Rational(s.a.x) + Rational(rx) * u, Rational(s.a.y) + Rational(ry) * u};
    if (onSegment(s, p) && onSegment(t, p)) {
      PairResult r;
      r.kind = PairKind::Point;
      r.point = p;
      return r;
    }
    return {};
  }

  // Parallel (or degenerate): collect witness endpoints on the other segment.
  std::set<IPoint> wit;
  auto addIfOn = [&](const Segment& seg, IPoint p) {
    if (onSegment(seg, Point{Rational(p.x), Rational(p.y)})) wit.insert(p);
  };
  addIfOn(t, s.a);
  addIfOn(t, s.b);
  addIfOn(s, t.a);
  addIfOn(s, t.b);

  if (wit.empty()) return {};
  if (wit.size() == 1) {
    PairResult r;
    r.kind = PairKind::Point;
    IPoint p = *wit.begin();
    r.point = Point{Rational(p.x), Rational(p.y)};
    return r;
  }
  PairResult r;
  r.kind = PairKind::Overlap;
  r.ovA = *wit.begin();
  r.ovB = *wit.rbegin();
  return r;
}

std::vector<Segment> gridSegments(int lo, int hi, bool allowDegenerate) {
  std::vector<IPoint> pts;
  for (int x = lo; x <= hi; ++x)
    for (int y = lo; y <= hi; ++y) pts.push_back(IPoint{x, y});
  std::vector<Segment> segs;
  for (size_t i = 0; i < pts.size(); ++i)
    for (size_t j = i + (allowDegenerate ? 0 : 1); j < pts.size(); ++j)
      segs.push_back(Segment{pts[i], pts[j]});
  return segs;
}

// Every reported item's edge set must equal exactly the edges passing
// through it (soundness + completeness of dedup).
void checkEdgeSetsExact(const std::vector<Segment>& segs, const IntersectionSet& r) {
  for (const auto& pi : r.points) {
    std::vector<EdgeId> expect;
    for (EdgeId e = 0; e < segs.size(); ++e)
      if (onSegment(segs[e], pi.p)) expect.push_back(e);
    CHECK(pi.edges == expect);
  }
  for (const auto& ov : r.overlaps) {
    std::vector<EdgeId> expect;
    Point pa{Rational(ov.a.x), Rational(ov.a.y)};
    Point pb{Rational(ov.b.x), Rational(ov.b.y)};
    for (EdgeId e = 0; e < segs.size(); ++e)
      if (onSegment(segs[e], pa) && onSegment(segs[e], pb)) expect.push_back(e);
    CHECK(ov.edges == expect);
  }
}

struct Stats {
  long pairs = 0, pairPoints = 0, pairOverlaps = 0;
  long triples = 0;
};
Stats g_stats;

void checkLibraryFor(const std::vector<Segment>& segs) {
  CurveLibrary oneShot, stepwise;
  std::vector<EdgeId> ids;
  for (const auto& s : segs) {
    auto got = stepwise.applyBatch({s}, {});
    ids.insert(ids.end(), got.begin(), got.end());
  }
  oneShot.applyBatch(segs, {});
  IntersectionSet r = oneShot.result();
  CHECK(r == oneShot.fullRecompute());
  CHECK(r == stepwise.result());
  CHECK(verifyIntersections(oneShot, r));
  checkEdgeSetsExact(segs, r);
}

} // namespace

int main() {
  // 1. All segment pairs on the 5x5 grid {-2..2}^2 (300 segments).
  {
    std::vector<Segment> segs = gridSegments(-2, 2, false);
    std::printf("5x5 grid: %zu segments\n", segs.size());
    for (size_t i = 0; i < segs.size(); ++i) {
      for (size_t j = i + 1; j < segs.size(); ++j) {
        PairResult a = intersectPair(segs[i], segs[j]);
        PairResult b = naivePair(segs[i], segs[j]);
        CHECK(a == b);
        ++g_stats.pairs;
        if (a.kind == PairKind::Point) ++g_stats.pairPoints;
        if (a.kind == PairKind::Overlap) ++g_stats.pairOverlaps;
      }
    }
    // Global library over all 300 edges: certificates + exact dedup.
    checkLibraryFor(segs);
  }

  // 2. All segment triples on the 3x3 grid {-1..1}^2 (36 segments).
  {
    std::vector<Segment> segs = gridSegments(-1, 1, false);
    for (size_t i = 0; i < segs.size(); ++i)
      for (size_t j = i + 1; j < segs.size(); ++j)
        for (size_t k = j + 1; k < segs.size(); ++k) {
          checkLibraryFor({segs[i], segs[j], segs[k]});
          ++g_stats.triples;
        }
  }

  // 3. Degenerate-inclusive: all segments (incl. zero-length) on {0,1}^2.
  {
    std::vector<Segment> segs = gridSegments(0, 1, true);
    for (size_t i = 0; i < segs.size(); ++i)
      for (size_t j = i + 1; j < segs.size(); ++j) {
        CHECK(intersectPair(segs[i], segs[j]) == naivePair(segs[i], segs[j]));
        ++g_stats.pairs;
      }
    for (size_t i = 0; i < segs.size(); ++i)
      for (size_t j = i + 1; j < segs.size(); ++j)
        for (size_t k = j + 1; k < segs.size(); ++k) {
          checkLibraryFor({segs[i], segs[j], segs[k]});
          ++g_stats.triples;
        }
  }

  std::printf("enumerated: %ld pairs (%ld point, %ld overlap), %ld triples\n",
              g_stats.pairs, g_stats.pairPoints, g_stats.pairOverlaps, g_stats.triples);
  return tst::summary("test_enumerate");
}
