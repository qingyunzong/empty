// Exact certificate checks: valid libraries must certify, tampered results
// must be rejected.

#include "curvelib/certificate.hpp"
#include "test_util.hpp"

#include <random>

using namespace curvelib;

int main() {
  // Positive: random libraries always certify (strict source completeness).
  std::mt19937_64 rng(424242);
  for (int trial = 0; trial < 100; ++trial) {
    std::uniform_int_distribution<std::int64_t> coord(-5, 5);
    std::uniform_int_distribution<std::size_t> countDist(1, 25);
    CurveLibrary lib;
    std::vector<Segment> batch;
    for (std::size_t i = 0, n = countDist(rng); i < n; ++i)
      batch.push_back({{coord(rng), coord(rng)}, {coord(rng), coord(rng)}});
    lib.addEdges(batch);
    CertificateReport r = certifyAll(lib);
    CHECK_MSG(r.ok, "trial " + std::to_string(trial) + ": " + r.message);
  }

  // Hand-built library with known content.
  CurveLibrary lib;
  lib.addEdges({{{0, 0}, {4, 0}},
                {{2, -2}, {2, 2}},
                {{1, 0}, {3, 0}},
                {{0, 1}, {4, 1}}});
  CHECK(certifyAll(lib).ok);

  // Negative: point shifted off its edges is rejected.
  {
    const RationalPoint bad{Rational(2, 1), Rational(1, 7)};
    CHECK(!certifyPointIntersection(bad, {0, 1}, lib.edges(), false).ok);
  }
  // Negative: claimed source edge that does not pass through the point.
  {
    const RationalPoint p{Rational(2), Rational(0)}; // on edges 0,1,2
    CHECK(!certifyPointIntersection(p, {0, 3}, lib.edges(), false).ok);
  }
  // Negative: strict mode catches a missing source edge.
  {
    const RationalPoint p{Rational(2), Rational(0)};
    CHECK(certifyPointIntersection(p, {0, 1, 2}, lib.edges(), true).ok);
    CHECK(!certifyPointIntersection(p, {0, 1}, lib.edges(), true).ok);
  }
  // Negative: fewer than two sources.
  CHECK(!certifyPointIntersection({Rational(2), Rational(0)}, {0}, lib.edges(),
                                  false)
             .ok);

  // Negative overlap certificates.
  {
    // Endpoints not on source edges.
    OverlapSegment bad{{Rational(1), Rational(0)},
                       {Rational(5), Rational(0)}, 0, 2};
    CHECK(!certifyOverlap(bad, lib.edges()).ok);
    // Degenerate overlap.
    OverlapSegment degen{{Rational(1), Rational(0)},
                         {Rational(1), Rational(0)}, 0, 2};
    CHECK(!certifyOverlap(degen, lib.edges()).ok);
    // Non-collinear sources.
    OverlapSegment skew{{Rational(2), Rational(0)},
                        {Rational(2), Rational(1)}, 0, 1};
    CHECK(!certifyOverlap(skew, lib.edges()).ok);
    // Non-maximal: (3/2,0) is not an endpoint of either source edge.
    OverlapSegment shorty{{Rational(3, 2), Rational(0)},
                          {Rational(3), Rational(0)}, 0, 2};
    CHECK(!certifyOverlap(shorty, lib.edges()).ok);
    // Valid overlap of edges 0 and 2: [1,3] on y=0.
    OverlapSegment good{{Rational(1), Rational(0)},
                        {Rational(3), Rational(0)}, 0, 2};
    CHECK(certifyOverlap(good, lib.edges()).ok);
  }

  return testutil::summary("certificate");
}
