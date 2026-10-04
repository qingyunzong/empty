// Incremental batch updates must produce results identical to a full
// all-pairs recomputation.

#include "curvelib/curve_library.hpp"
#include "test_util.hpp"

#include <random>
#include <vector>

using namespace curvelib;

static std::vector<Segment> randomSegments(std::mt19937_64& rng, std::size_t n,
                                           std::int64_t lo, std::int64_t hi,
                                           bool allow_degenerate) {
  std::uniform_int_distribution<std::int64_t> coord(lo, hi);
  std::vector<Segment> out;
  while (out.size() < n) {
    Segment s{{coord(rng), coord(rng)}, {coord(rng), coord(rng)}};
    if (!allow_degenerate && s.a == s.b) continue;
    out.push_back(s);
  }
  return out;
}

int main() {
  std::mt19937_64 rng(20261005);

  // 200 trials: random edge count, random batch split, compare incremental
  // results against recomputeAll() and against a from-scratch full build.
  for (int trial = 0; trial < 200; ++trial) {
    const bool allow_degenerate = (trial % 7 == 0);
    std::uniform_int_distribution<std::size_t> countDist(0, 40);
    const std::vector<Segment> edges =
        randomSegments(rng, countDist(rng), -6, 6, allow_degenerate);

    // Random batch partition.
    CurveLibrary incremental;
    std::uniform_int_distribution<int> batchDist(1, 5);
    std::size_t pos = 0;
    while (pos < edges.size()) {
      const std::size_t take =
          std::min<std::size_t>(edges.size() - pos, batchDist(rng));
      incremental.addEdges(
          {edges.begin() + static_cast<std::ptrdiff_t>(pos),
           edges.begin() + static_cast<std::ptrdiff_t>(pos + take)});
      pos += take;
    }

    CurveLibrary full;
    full.addEdges(edges); // single batch == all pairs in one pass

    CurveLibrary rebuilt = incremental;
    rebuilt.recomputeAll();

    CHECK_MSG(incremental.sameResults(full),
              "incremental != full, trial " + std::to_string(trial));
    CHECK_MSG(incremental.sameResults(rebuilt),
              "incremental != recomputed, trial " + std::to_string(trial));
  }

  // Deterministic regression: shared endpoints and collinear chains across
  // batch boundaries.
  CurveLibrary lib;
  lib.addEdges({{{0, 0}, {4, 0}}, {{4, 0}, {4, 4}}});
  lib.addEdges({{{2, -1}, {2, 1}}});          // crosses edge 0 at (2,0)
  lib.addEdges({{{1, 0}, {3, 0}}, {{0, 0}, {4, 0}}}); // overlap + duplicate
  lib.recomputeAll();
  CurveLibrary reference;
  reference.addEdges({{{0, 0}, {4, 0}},
                      {{4, 0}, {4, 4}},
                      {{2, -1}, {2, 1}},
                      {{1, 0}, {3, 0}},
                      {{0, 0}, {4, 0}}});
  CHECK(lib.sameResults(reference));
  // (2,0) lies on edges 0, 2, 3, 4 -> all four must appear as sources.
  const auto& pts = lib.pointIntersections();
  auto it = pts.find(RationalPoint{Rational(2), Rational(0)});
  CHECK(it != pts.end());
  CHECK(it->second == std::set<EdgeId>({0, 2, 3, 4}));
  // Duplicate edge 4 == edge 0 -> full-segment overlap reported once per pair.
  CHECK(lib.overlaps().count(OverlapSegment{{Rational(0), Rational(0)},
                                            {Rational(4), Rational(0)}, 0,
                                            4}) == 1);

  return testutil::summary("incremental");
}
