#include "check.hpp"
#include "curve2d/certificate.hpp"

using namespace curve2d;

static Segment seg(int64_t ax, int64_t ay, int64_t bx, int64_t by) {
  return Segment{IPoint{ax, ay}, IPoint{bx, by}};
}

int main() {
  CurveLibrary lib;
  auto ids = lib.applyBatch({seg(0, 0, 3, 1),   // 0
                             seg(0, 1, 3, 0),   // 1  crosses 0 at (3/2, 1/2)
                             seg(0, 0, 4, 0),   // 2
                             seg(2, 0, 6, 0)},  // 3  overlaps 2 on [2,0]-[4,0]
                            {});
  IntersectionSet good = lib.result();
  CHECK(verifyIntersections(lib, good));

  // Tampered point: shifted off one of the edges.
  {
    IntersectionSet bad = good;
    bad.points.push_back(PointIntersection{Point{Rational(3, 2), Rational(1, 3)},
                                           {ids[0], ids[1]}});
    CHECK(!verifyIntersections(lib, bad));
  }
  // Tampered edge set: point attributed to an edge not through it.
  {
    IntersectionSet bad = good;
    for (auto& pi : bad.points)
      if (pi.p == Point{Rational(3, 2), Rational(1, 2)}) pi.edges.push_back(ids[2]);
    CHECK(!verifyIntersections(lib, bad));
  }
  // Tampered overlap endpoint.
  {
    IntersectionSet bad = good;
    for (auto& ov : bad.overlaps) ov.b = IPoint{5, 0};
    CHECK(!verifyIntersections(lib, bad));
  }
  // Degenerate overlap (a == b) is not a valid overlap certificate.
  {
    IntersectionSet bad = good;
    bad.overlaps.push_back(OverlapSegment{IPoint{2, 0}, IPoint{2, 0}, {ids[2], ids[3]}});
    CHECK(!verifyIntersections(lib, bad));
  }
  // Unknown edge id rejected.
  {
    IntersectionSet bad = good;
    bad.points.push_back(PointIntersection{Point{Rational(0), Rational(0)}, {ids[0], 999}});
    CHECK(!verifyIntersections(lib, bad));
  }
  // Single-edge "intersection" rejected.
  {
    IntersectionSet bad = good;
    bad.points.push_back(PointIntersection{Point{Rational(0), Rational(0)}, {ids[0]}});
    CHECK(!verifyIntersections(lib, bad));
  }

  return tst::summary("test_certificate");
}
