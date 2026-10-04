#include "curvelib/geometry.hpp"
#include "test_util.hpp"

using namespace curvelib;

static bool isPoint(const PairIntersection& r, std::int64_t xn,
                    std::int64_t xd, std::int64_t yn, std::int64_t yd) {
  return r.kind == IntersectionKind::Point &&
         r.point.x == Rational(xn, xd) && r.point.y == Rational(yn, yd);
}

int main() {
  // Proper crossing at integer point
  CHECK(isPoint(intersect({{0, 0}, {4, 0}}, {{2, -2}, {2, 2}}), 2, 1, 0, 1));

  // Proper crossing at rational point: y=0 vs line (1,1)-(2,-1) -> x = 3/2
  CHECK(isPoint(intersect({{0, 0}, {3, 0}}, {{1, 1}, {2, -1}}), 3, 2, 0, 1));

  // Rational in both coordinates: (0,0)-(4,4) vs (0,3)-(3,0) -> (3/2, 3/2)
  CHECK(isPoint(intersect({{0, 0}, {4, 4}}, {{0, 3}, {3, 0}}), 3, 2, 3, 2));

  // Endpoint touching (T-junction and shared endpoint)
  CHECK(isPoint(intersect({{0, 0}, {4, 0}}, {{2, 0}, {2, 5}}), 2, 1, 0, 1));
  CHECK(isPoint(intersect({{0, 0}, {4, 4}}, {{4, 4}, {8, 0}}), 4, 1, 4, 1));

  // Misses: parallel, collinear disjoint, non-parallel disjoint
  CHECK(intersect({{0, 0}, {4, 0}}, {{0, 1}, {4, 1}}).kind ==
        IntersectionKind::None);
  CHECK(intersect({{0, 0}, {2, 0}}, {{3, 0}, {5, 0}}).kind ==
        IntersectionKind::None);
  CHECK(intersect({{0, 0}, {1, 0}}, {{2, 1}, {2, 2}}).kind ==
        IntersectionKind::None);
  // Extension would cross but segment does not reach
  CHECK(intersect({{0, 0}, {1, 1}}, {{2, 0}, {3, 1}}).kind ==
        IntersectionKind::None);

  // Collinear overlaps
  {
    // Partial overlap [2,4] on the x-axis
    auto r = intersect({{0, 0}, {4, 0}}, {{2, 0}, {6, 0}});
    CHECK(r.kind == IntersectionKind::Overlap);
    CHECK(r.overlap_lo == (RationalPoint{Rational(2), Rational(0)}));
    CHECK(r.overlap_hi == (RationalPoint{Rational(4), Rational(0)}));
  }
  {
    // Containment: overlap is the shorter segment
    auto r = intersect({{0, 0}, {10, 0}}, {{3, 0}, {7, 0}});
    CHECK(r.kind == IntersectionKind::Overlap);
    CHECK(r.overlap_lo == (RationalPoint{Rational(3), Rational(0)}));
    CHECK(r.overlap_hi == (RationalPoint{Rational(7), Rational(0)}));
  }
  {
    // Diagonal collinear overlap, reversed orientations
    auto r = intersect({{0, 0}, {6, 6}}, {{8, 8}, {2, 2}});
    CHECK(r.kind == IntersectionKind::Overlap);
    CHECK(r.overlap_lo == (RationalPoint{Rational(2), Rational(2)}));
    CHECK(r.overlap_hi == (RationalPoint{Rational(6), Rational(6)}));
  }
  {
    // Vertical collinear overlap
    auto r = intersect({{3, 0}, {3, 5}}, {{3, 4}, {3, 9}});
    CHECK(r.kind == IntersectionKind::Overlap);
    CHECK(r.overlap_lo == (RationalPoint{Rational(3), Rational(4)}));
    CHECK(r.overlap_hi == (RationalPoint{Rational(3), Rational(5)}));
  }
  {
    // Collinear touching in a single point -> Point, not Overlap
    CHECK(isPoint(intersect({{0, 0}, {2, 0}}, {{2, 0}, {5, 0}}), 2, 1, 0, 1));
  }

  // Degenerate segments
  CHECK(isPoint(intersect({{2, 2}, {2, 2}}, {{0, 0}, {4, 4}}), 2, 1, 2, 1));
  CHECK(isPoint(intersect({{0, 0}, {4, 4}}, {{3, 3}, {3, 3}}), 3, 1, 3, 1));
  CHECK(isPoint(intersect({{5, 5}, {5, 5}}, {{5, 5}, {5, 5}}), 5, 1, 5, 1));
  CHECK(intersect({{1, 1}, {1, 1}}, {{0, 0}, {4, 0}}).kind ==
        IntersectionKind::None);
  CHECK(intersect({{1, 1}, {1, 1}}, {{2, 2}, {2, 2}}).kind ==
        IntersectionKind::None);

  // Symmetry: swapping the operands must give the same result
  Segment a{{1, 2}, {7, 3}}, b{{2, 0}, {5, 9}};
  CHECK(intersect(a, b).kind == IntersectionKind::Point);
  CHECK(intersect(a, b).point == intersect(b, a).point);

  return testutil::summary("intersection");
}
