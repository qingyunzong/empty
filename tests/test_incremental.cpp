#include <random>
#include <vector>

#include "check.hpp"
#include "curve2d/certificate.hpp"
#include "curve2d/library.hpp"

using namespace curve2d;

int main() {
  std::mt19937_64 rng(20261005);
  auto coord = [&]() { return static_cast<int64_t>(rng() % 2001) - 1000; };
  auto randSeg = [&]() {
    return Segment{IPoint{coord(), coord()}, IPoint{coord(), coord()}};
  };

  CurveLibrary lib;
  std::vector<EdgeId> live;

  // Initial batch
  std::vector<Segment> initial;
  for (int i = 0; i < 200; ++i) initial.push_back(randSeg());
  live = lib.applyBatch(initial, {});
  CHECK(lib.result() == lib.fullRecompute());

  // 60 rounds of mixed batch updates
  for (int round = 0; round < 60; ++round) {
    std::vector<EdgeId> removes;
    std::vector<Segment> adds;
    int nRem = static_cast<int>(rng() % 9);
    int nAdd = static_cast<int>(rng() % 13);
    for (int k = 0; k < nRem && !live.empty(); ++k) {
      size_t idx = rng() % live.size();
      removes.push_back(live[idx]);
      live.erase(live.begin() + static_cast<long>(idx));
    }
    for (int k = 0; k < nAdd; ++k) adds.push_back(randSeg());
    auto ids = lib.applyBatch(adds, removes);
    live.insert(live.end(), ids.begin(), ids.end());

    IntersectionSet inc = lib.result();
    IntersectionSet full = lib.fullRecompute();
    CHECK(inc == full);
    CHECK(verifyIntersections(lib, inc));

    // Cross-check against a fresh library holding the same edges (edge ids
    // are renumbered there, so compare geometry only).
    CurveLibrary fresh;
    std::vector<Segment> all;
    for (const auto& [id, s] : lib.segments()) all.push_back(s);
    fresh.applyBatch(all, {});
    IntersectionSet fr = fresh.result();
    CHECK(fr == fresh.fullRecompute());
    std::vector<Point> incPts, frPts;
    std::vector<std::pair<IPoint, IPoint>> incOv, frOv;
    for (const auto& pi : inc.points) incPts.push_back(pi.p);
    for (const auto& pi : fr.points) frPts.push_back(pi.p);
    for (const auto& ov : inc.overlaps) incOv.push_back({ov.a, ov.b});
    for (const auto& ov : fr.overlaps) frOv.push_back({ov.a, ov.b});
    CHECK(incPts == frPts && incOv == frOv);
  }

  // Remove everything; result must be empty.
  lib.applyBatch({}, live);
  CHECK(lib.result().points.empty() && lib.result().overlaps.empty());
  CHECK(lib.edgeCount() == 0);

  // Targeted dedup scenario: 4 edges through one rational point (1/2, 1/2)
  // plus a shared collinear overlap; dedup must keep all source edges.
  CurveLibrary d;
  auto ids = d.applyBatch({Segment{IPoint{0, 0}, IPoint{1, 1}},
                           Segment{IPoint{0, 1}, IPoint{1, 0}},
                           Segment{IPoint{-2, 0}, IPoint{3, 0}},
                           Segment{IPoint{0, 0}, IPoint{3, 0}},
                           Segment{IPoint{1, 0}, IPoint{2, 0}}},
                          {});
  IntersectionSet r = d.result();
  CHECK(r == d.fullRecompute());
  CHECK(verifyIntersections(d, r));
  // Point (1/2, 1/2) from edges 0 and 1
  bool foundHalf = false;
  for (const auto& pi : r.points) {
    if (pi.p == Point{Rational(1, 2), Rational(1, 2)}) {
      foundHalf = true;
      CHECK(pi.edges == std::vector<EdgeId>({ids[0], ids[1]}));
    }
  }
  CHECK(foundHalf);
  // Overlap [ (0,0), (3,0) ] covered by edges 2 and 3
  bool foundOv = false;
  for (const auto& ov : r.overlaps) {
    if (ov.a == IPoint{0, 0} && ov.b == IPoint{3, 0}) {
      foundOv = true;
      CHECK(ov.edges == std::vector<EdgeId>({ids[2], ids[3]}));
    }
  }
  CHECK(foundOv);
  // Overlap [ (1,0), (2,0) ] covered by edges 2, 3 and 4
  bool foundInner = false;
  for (const auto& ov : r.overlaps) {
    if (ov.a == IPoint{1, 0} && ov.b == IPoint{2, 0}) {
      foundInner = true;
      CHECK(ov.edges == std::vector<EdgeId>({ids[2], ids[3], ids[4]}));
    }
  }
  CHECK(foundInner);
  // Remove edge 3: big overlap gone, inner overlap keeps edges 2 and 4.
  d.applyBatch({}, {ids[3]});
  r = d.result();
  CHECK(r == d.fullRecompute());
  foundOv = false;
  foundInner = false;
  for (const auto& ov : r.overlaps) {
    if (ov.a == IPoint{0, 0} && ov.b == IPoint{3, 0}) foundOv = true;
    if (ov.a == IPoint{1, 0} && ov.b == IPoint{2, 0}) {
      foundInner = true;
      CHECK(ov.edges == std::vector<EdgeId>({ids[2], ids[4]}));
    }
  }
  CHECK(!foundOv);
  CHECK(foundInner);

  return tst::summary("test_incremental");
}
