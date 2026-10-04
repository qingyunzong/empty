#include "check.hpp"
#include "curve2d/geometry.hpp"

using namespace curve2d;

static Segment seg(int64_t ax, int64_t ay, int64_t bx, int64_t by) {
  return Segment{IPoint{ax, ay}, IPoint{bx, by}};
}

static bool isPoint(const PairResult& r, int64_t xn, int64_t xd, int64_t yn, int64_t yd) {
  return r.kind == PairKind::Point && r.point.x == Rational(xn, xd) &&
         r.point.y == Rational(yn, yd);
}

static bool isOverlap(const PairResult& r, int64_t ax, int64_t ay, int64_t bx, int64_t by) {
  return r.kind == PairKind::Overlap && r.ovA == IPoint{ax, ay} && r.ovB == IPoint{bx, by};
}

int main() {
  // Proper crossing, integer point
  CHECK(isPoint(intersectPair(seg(0, 0, 4, 4), seg(0, 4, 4, 0)), 2, 1, 2, 1));
  // Proper crossing, rational point (3/2, 1/2)
  CHECK(isPoint(intersectPair(seg(0, 0, 3, 1), seg(0, 1, 3, 0)), 3, 2, 1, 2));
  // Endpoint touch (L shape)
  CHECK(isPoint(intersectPair(seg(0, 0, 2, 0), seg(2, 0, 2, 3)), 2, 1, 0, 1));
  // T-junction
  CHECK(isPoint(intersectPair(seg(0, 0, 4, 0), seg(2, 0, 2, 2)), 2, 1, 0, 1));
  // Crossing lines but disjoint segments
  CHECK(intersectPair(seg(0, 0, 1, 1), seg(5, 0, 6, 1)).kind == PairKind::None);
  // Parallel disjoint
  CHECK(intersectPair(seg(0, 0, 2, 0), seg(0, 1, 2, 1)).kind == PairKind::None);
  // Collinear disjoint
  CHECK(intersectPair(seg(0, 0, 1, 0), seg(2, 0, 3, 0)).kind == PairKind::None);

  // Collinear partial overlap (horizontal)
  CHECK(isOverlap(intersectPair(seg(0, 0, 4, 0), seg(2, 0, 6, 0)), 2, 0, 4, 0));
  // Containment
  CHECK(isOverlap(intersectPair(seg(0, 0, 6, 0), seg(2, 0, 4, 0)), 2, 0, 4, 0));
  CHECK(isOverlap(intersectPair(seg(2, 0, 4, 0), seg(0, 0, 6, 0)), 2, 0, 4, 0));
  // Identical (both directions)
  CHECK(isOverlap(intersectPair(seg(1, 1, 3, 3), seg(1, 1, 3, 3)), 1, 1, 3, 3));
  CHECK(isOverlap(intersectPair(seg(1, 1, 3, 3), seg(3, 3, 1, 1)), 1, 1, 3, 3));
  // Collinear point touch
  CHECK(isPoint(intersectPair(seg(0, 0, 2, 0), seg(2, 0, 4, 0)), 2, 1, 0, 1));
  // Vertical overlap
  CHECK(isOverlap(intersectPair(seg(0, 0, 0, 4), seg(0, 2, 0, 6)), 0, 2, 0, 4));
  // Diagonal overlap
  CHECK(isOverlap(intersectPair(seg(0, 0, 4, 4), seg(2, 2, 6, 6)), 2, 2, 4, 4));
  // Negative-slope diagonal overlap
  CHECK(isOverlap(intersectPair(seg(0, 6, 6, 0), seg(2, 4, 4, 2)), 2, 4, 4, 2));

  // Degenerate segments
  CHECK(isPoint(intersectPair(seg(1, 1, 1, 1), seg(0, 0, 2, 2)), 1, 1, 1, 1));
  CHECK(intersectPair(seg(3, 1, 3, 1), seg(0, 0, 2, 2)).kind == PairKind::None);
  CHECK(isPoint(intersectPair(seg(1, 1, 1, 1), seg(1, 1, 1, 1)), 1, 1, 1, 1));
  CHECK(intersectPair(seg(1, 1, 1, 1), seg(2, 2, 2, 2)).kind == PairKind::None);
  // Degenerate inside a collinear overlap region still reports just the point
  CHECK(isPoint(intersectPair(seg(2, 0, 2, 0), seg(0, 0, 4, 0)), 2, 1, 0, 1));

  // Certificate primitive sanity
  CHECK(onSegment(seg(0, 0, 4, 4), Point{Rational(3, 2), Rational(3, 2)}));
  CHECK(!onSegment(seg(0, 0, 4, 4), Point{Rational(5), Rational(5)}));
  CHECK(!onSegment(seg(0, 0, 4, 4), Point{Rational(2), Rational(3)}));

  return tst::summary("test_intersect");
}
