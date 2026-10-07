// Tests for the skyline library. The reference model is an endpoint-segmented
// full scan: collect every rectangle endpoint, and for each elementary
// interval scan all rectangles for the max height and every id attaining it.
#include "skyline/skyline.hpp"

#include <algorithm>
#include <cstdio>
#include <random>
#include <set>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace {

using skyline::Change;
using skyline::Coord;
using skyline::Height;
using skyline::HeightSpan;
using skyline::Id;
using skyline::Rect;
using skyline::Segment;
using skyline::Skyline;

int g_failures = 0;
int g_checks = 0;

void check(bool ok, const char* expr, const char* file, int line) {
  ++g_checks;
  if (!ok) {
    ++g_failures;
    std::fprintf(stderr, "FAIL %s:%d: %s\n", file, line, expr);
  }
}

#define CHECK(expr) check(static_cast<bool>(expr), #expr, __FILE__, __LINE__)

std::string toString(const std::vector<Segment>& segs) {
  std::string out;
  for (const auto& s : segs) {
    out += "[" + std::to_string(s.x1) + "," + std::to_string(s.x2) + ") h=" +
           std::to_string(s.height) + " src={";
    for (Id id : s.sources) out += std::to_string(id) + ",";
    out += "} ";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reference model: brute-force endpoint-segmented full scan.
// ---------------------------------------------------------------------------
struct Model {
  std::unordered_map<Id, Rect> rects;

  void add(Id id, Coord x1, Coord x2, Height h) {
    Rect r{id, x1, x2, h};
    if (h <= 0 || x1 >= x2)
      rects.erase(id);
    else
      rects[id] = r;
  }

  void remove(Id id) { rects.erase(id); }

  // Max height and all attaining ids on the elementary interval [a, b).
  std::pair<Height, std::vector<Id>> scanAt(Coord a, Coord b) const {
    Height best = 0;
    std::vector<Id> ids;
    for (const auto& [id, r] : rects) {
      if (r.x1 <= a && b <= r.x2) {
        if (r.height > best) {
          best = r.height;
          ids = {r.id};
        } else if (r.height == best) {
          ids.push_back(r.id);
        }
      }
    }
    std::sort(ids.begin(), ids.end());
    return {best, std::move(ids)};
  }

  std::vector<Segment> snapshot() const {
    std::set<Coord> pts;
    for (const auto& [id, r] : rects) {
      pts.insert(r.x1);
      pts.insert(r.x2);
    }
    std::vector<Coord> xs(pts.begin(), pts.end());
    std::vector<Segment> out;
    for (std::size_t k = 0; k + 1 < xs.size(); ++k) {
      auto [h, ids] = scanAt(xs[k], xs[k + 1]);
      if (h == 0) continue;
      if (!out.empty() && out.back().x2 == xs[k] && out.back().height == h &&
          out.back().sources == ids) {
        out.back().x2 = xs[k + 1];
      } else {
        out.push_back(Segment{xs[k], xs[k + 1], h, std::move(ids)});
      }
    }
    return out;
  }
};

// Per-endpoint verification of a reported delta: for every elementary
// interval induced by the two rect sets, the change list must agree with the
// brute-force scan of the before/after states.
void checkDeltaAgainstModel(const Model& before, const Model& after,
                            const std::vector<Change>& changes) {
  std::set<Coord> pts;
  for (const auto* m : {&before, &after})
    for (const auto& [id, r] : m->rects) {
      pts.insert(r.x1);
      pts.insert(r.x2);
    }
  std::vector<Coord> xs(pts.begin(), pts.end());
  std::size_t ci = 0;
  for (std::size_t k = 0; k + 1 < xs.size(); ++k) {
    const Coord a = xs[k], b = xs[k + 1];
    auto [oh, oids] = before.scanAt(a, b);
    auto [nh, nids] = after.scanAt(a, b);
    while (ci < changes.size() && changes[ci].x2 <= a) ++ci;
    const bool covered =
        ci < changes.size() && changes[ci].x1 <= a && b <= changes[ci].x2;
    if (oh == nh && oids == nids) {
      CHECK(!covered);
    } else {
      CHECK(covered);
      if (covered) {
        CHECK(changes[ci].oldHeight == oh);
        CHECK(changes[ci].newHeight == nh);
        CHECK(changes[ci].oldSources == oids);
        CHECK(changes[ci].newSources == nids);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Targeted tests
// ---------------------------------------------------------------------------
void testEmpty() {
  Skyline s;
  CHECK(s.snapshot().empty());
  CHECK(s.skyline().empty());
  CHECK(!s.remove(7));
}

void testSingleRect() {
  Skyline s;
  s.add(1, 0, 10, 5);
  auto snap = s.snapshot();
  CHECK(snap.size() == 1);
  CHECK(snap[0] == (Segment{0, 10, 5, {1}}));
  auto line = s.skyline();
  CHECK(line.size() == 1);
  CHECK(line[0] == (HeightSpan{0, 10, 5}));
}

void testHalfOpenAdjacency() {
  Skyline s;
  s.add(1, 0, 5, 3);
  s.add(2, 5, 10, 3);
  // Same height but different sources: snapshot keeps two segments...
  auto snap = s.snapshot();
  CHECK(snap.size() == 2);
  CHECK(snap[0] == (Segment{0, 5, 3, {1}}));
  CHECK(snap[1] == (Segment{5, 10, 3, {2}}));
  // ...while the height-only skyline merges adjacent equal heights.
  auto line = s.skyline();
  CHECK(line.size() == 1);
  CHECK(line[0] == (HeightSpan{0, 10, 3}));
  // No overlap: point 5 belongs only to rect 2 (half-open).
  s.add(3, 4, 5, 100);  // zero-width? no: [4,5) valid
  snap = s.snapshot();
  CHECK(snap.size() == 3);
  CHECK(snap[1] == (Segment{4, 5, 100, {3}}));
}

void testSameHeightOverlapKeepsAllSources() {
  Skyline s;
  s.add(1, 0, 10, 5);
  s.add(2, 2, 8, 5);
  s.add(3, 4, 6, 5);
  auto snap = s.snapshot();
  CHECK(snap.size() == 5);
  CHECK(snap[0] == (Segment{0, 2, 5, {1}}));
  CHECK(snap[1] == (Segment{2, 4, 5, {1, 2}}));
  CHECK(snap[2] == (Segment{4, 6, 5, {1, 2, 3}}));
  CHECK(snap[3] == (Segment{6, 8, 5, {1, 2}}));
  CHECK(snap[4] == (Segment{8, 10, 5, {1}}));
}

void testRemoveOnlyOwnContribution() {
  Skyline s;
  s.add(1, 0, 10, 5);
  s.add(2, 0, 10, 5);
  CHECK(s.remove(1));
  auto snap = s.snapshot();
  CHECK(snap.size() == 1);
  CHECK(snap[0] == (Segment{0, 10, 5, {2}}));
  CHECK(!s.remove(1));
}

void testHeightZeroIsEmpty() {
  Skyline s;
  s.add(1, 0, 10, 0);
  CHECK(s.snapshot().empty());
  CHECK(!s.contains(1));
  s.add(2, 0, 10, 4);
  s.add(2, 0, 10, 0);  // re-add with zero height clears the contribution
  CHECK(s.snapshot().empty());
  CHECK(!s.contains(2));
}

void testDegenerateIntervalIsEmpty() {
  Skyline s;
  s.add(1, 5, 5, 9);
  s.add(2, 8, 3, 9);
  CHECK(s.snapshot().empty());
  CHECK(s.size() == 0);
}

void testNegativeCoordinates() {
  Skyline s;
  s.add(1, -100, -3, 7);
  s.add(2, -50, 40, 2);
  auto snap = s.snapshot();
  // Adjacent equal (height, sources) runs merge: [-100,-3) is one segment.
  CHECK(snap.size() == 2);
  CHECK(snap[0] == (Segment{-100, -3, 7, {1}}));
  CHECK(snap[1] == (Segment{-3, 40, 2, {2}}));
}

void testReplaceSameId() {
  Skyline s;
  s.add(1, 0, 10, 5);
  s.add(1, 20, 30, 8);
  auto snap = s.snapshot();
  CHECK(snap.size() == 1);
  CHECK(snap[0] == (Segment{20, 30, 8, {1}}));
  CHECK(s.size() == 1);
}

void testDiffNotifiesOnSourceOnlyChange() {
  Skyline s;
  s.add(1, 0, 10, 5);
  auto before = s.snapshot();
  // Swap rect 1 for rect 2: identical height profile, different source.
  auto result = s.applyBatch({Rect{2, 0, 10, 5}}, {1});
  CHECK(result.before == before);
  CHECK(result.after.size() == 1);
  CHECK(result.after[0] == (Segment{0, 10, 5, {2}}));
  CHECK(result.changes.size() == 1);
  const Change& c = result.changes[0];
  CHECK(c.x1 == 0 && c.x2 == 10);
  CHECK(!c.heightChanged());
  CHECK(c.sourcesChanged());
  CHECK(c.oldSources == std::vector<Id>{1});
  CHECK(c.newSources == std::vector<Id>{2});
}

void testDiffPartialSourceChange() {
  Skyline s;
  s.add(1, 0, 10, 5);
  s.add(2, 3, 7, 5);
  auto before = s.snapshot();
  auto result = s.applyBatch({}, {2});
  CHECK(result.changes.size() == 1);
  const Change& c = result.changes[0];
  CHECK(c.x1 == 3 && c.x2 == 7);
  CHECK(!c.heightChanged());
  CHECK(c.oldSources == (std::vector<Id>{1, 2}));
  CHECK(c.newSources == (std::vector<Id>{1}));
  (void)before;
}

void testDiffAgainstSavedSnapshot() {
  Skyline s;
  s.add(1, 0, 10, 5);
  std::vector<Segment> saved = s.snapshot();  // old snapshot kept by caller
  s.add(2, 4, 12, 9);
  s.remove(1);
  auto changes = Skyline::diff(saved, s.snapshot());
  CHECK(changes.size() == 3);
  CHECK(changes[0] == (Change{0, 4, 5, 0, {1}, {}}));
  CHECK(changes[1] == (Change{4, 10, 5, 9, {1}, {2}}));
  CHECK(changes[2] == (Change{10, 12, 0, 9, {}, {2}}));
}

void testBatchOrderRemovalThenAddition() {
  Skyline s;
  s.add(1, 0, 10, 5);
  // Same id in both lists: removal happens first, addition wins.
  auto result = s.applyBatch({Rect{1, 2, 8, 6}}, {1});
  CHECK(result.after.size() == 1);
  CHECK(result.after[0] == (Segment{2, 8, 6, {1}}));
}

void testClear() {
  Skyline s;
  s.add(1, 0, 10, 5);
  s.add(2, -5, 0, 3);
  s.clear();
  CHECK(s.snapshot().empty());
  CHECK(s.size() == 0);
  s.add(3, 0, 4, 2);
  CHECK(s.snapshot().size() == 1);
}

// ---------------------------------------------------------------------------
// Randomized cross-check against the endpoint-segmented full-scan model.
// ---------------------------------------------------------------------------
void testRandomizedAgainstModel() {
  std::mt19937_64 rng(20261007);
  Skyline s;
  Model m;
  auto randCoord = [&] { return static_cast<Coord>(rng() % 121) - 60; };
  auto randId = [&] { return static_cast<Id>(rng() % 24); };

  for (int step = 0; step < 4000; ++step) {
    const int op = static_cast<int>(rng() % 100);
    if (op < 55) {
      Coord a = randCoord(), b = randCoord();
      if (rng() % 4) {  // usually ordered, sometimes degenerate
        if (b < a) std::swap(a, b);
      }
      Height h = static_cast<Height>(rng() % 12) - 1;  // sometimes <= 0
      const Id id = randId();
      s.add(id, a, b, h);
      m.add(id, a, b, h);
    } else if (op < 80) {
      Id id = randId();
      CHECK(s.remove(id) == (m.rects.erase(id) > 0));
    } else {
      // Batch of mixed additions and removals.
      std::vector<Rect> adds;
      std::vector<Id> rems;
      const int n = static_cast<int>(rng() % 6);
      Model beforeModel = m;
      for (int i = 0; i < n; ++i) {
        if (rng() % 2) {
          Coord a = randCoord(), b = randCoord();
          if (b < a) std::swap(a, b);
          adds.push_back(Rect{randId(), a, b,
                              static_cast<Height>(rng() % 12) - 1});
        } else {
          rems.push_back(randId());
        }
      }
      auto result = s.applyBatch(adds, rems);
      for (Id id : rems) m.remove(id);
      for (const Rect& r : adds) m.add(r.id, r.x1, r.x2, r.height);
      CHECK(result.before == beforeModel.snapshot());
      CHECK(result.after == m.snapshot());
      CHECK(result.changes ==
            Skyline::diff(beforeModel.snapshot(), m.snapshot()));
      checkDeltaAgainstModel(beforeModel, m, result.changes);
      continue;
    }
    auto expected = m.snapshot();
    auto actual = s.snapshot();
    if (expected != actual) {
      std::fprintf(stderr, "step %d\nexpected: %s\nactual:   %s\n", step,
                   toString(expected).c_str(), toString(actual).c_str());
    }
    CHECK(actual == expected);
    // Skyline view: height-only merge of the model snapshot.
    std::vector<HeightSpan> merged;
    for (const auto& seg : expected) {
      if (!merged.empty() && merged.back().x2 == seg.x1 &&
          merged.back().height == seg.height)
        merged.back().x2 = seg.x2;
      else
        merged.push_back(HeightSpan{seg.x1, seg.x2, seg.height});
    }
    CHECK(s.skyline() == merged);
  }
}

}  // namespace

int main() {
  testEmpty();
  testSingleRect();
  testHalfOpenAdjacency();
  testSameHeightOverlapKeepsAllSources();
  testRemoveOnlyOwnContribution();
  testHeightZeroIsEmpty();
  testDegenerateIntervalIsEmpty();
  testNegativeCoordinates();
  testReplaceSameId();
  testDiffNotifiesOnSourceOnlyChange();
  testDiffPartialSourceChange();
  testDiffAgainstSavedSnapshot();
  testBatchOrderRemovalThenAddition();
  testClear();
  testRandomizedAgainstModel();

  std::fprintf(stderr, "%d checks, %d failures\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
