#pragma once

#include <cstdint>
#include <map>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "curve2d/geometry.hpp"

namespace curve2d {

using EdgeId = uint64_t;

// A distinct intersection point, deduplicated across all edge pairs.
// `edges` lists every edge passing through the point (sorted, unique).
struct PointIntersection {
  Point p;
  std::vector<EdgeId> edges;
  bool operator==(const PointIntersection&) const = default;
};

// A distinct collinear overlap segment [a, b] (a < b), deduplicated across
// all edge pairs. `edges` lists every edge covering it (sorted, unique).
struct OverlapSegment {
  IPoint a;
  IPoint b;
  std::vector<EdgeId> edges;
  bool operator==(const OverlapSegment&) const = default;
};

struct IntersectionSet {
  std::vector<PointIntersection> points;    // sorted by point
  std::vector<OverlapSegment> overlaps;     // sorted by (a, b)
  bool operator==(const IntersectionSet&) const = default;
};

// Maintains a set of polyline edges and their pairwise intersections.
// applyBatch() updates the intersection indices incrementally: only pairs
// touching removed or newly added edges are recomputed, and the result is
// exactly the same as intersecting all current edge pairs from scratch.
class CurveLibrary {
public:
  EdgeId addEdge(IPoint a, IPoint b) {
    applyBatch({Segment{a, b}}, {});
    return nextId_ - 1;
  }

  // Batch update: removals are applied first, then additions.
  // Returns the ids assigned to the added edges (in order).
  std::vector<EdgeId> applyBatch(const std::vector<Segment>& adds,
                                 const std::vector<EdgeId>& removes);

  // Current deduplicated intersections (incrementally maintained).
  IntersectionSet result() const;

  // Recomputes intersections from scratch over all current edges.
  // Guaranteed identical to result(); useful for differential testing.
  IntersectionSet fullRecompute() const;

  const std::map<EdgeId, Segment>& segments() const { return segs_; }
  size_t edgeCount() const { return segs_.size(); }

private:
  struct PairKey {
    EdgeId lo, hi;
    bool operator==(const PairKey&) const = default;
  };
  struct PairKeyHash {
    size_t operator()(const PairKey& k) const {
      return std::hash<EdgeId>{}(k.lo * 0x9E3779B97F4A7C15ull ^ k.hi);
    }
  };

  void addContribution(EdgeId x, EdgeId y, const PairResult& r, int delta);

  std::map<EdgeId, Segment> segs_;
  EdgeId nextId_ = 0;
  std::unordered_map<PairKey, PairResult, PairKeyHash> pairResults_;
  std::unordered_map<EdgeId, std::unordered_set<EdgeId>> adj_; // pairs with results
  std::map<Point, std::map<EdgeId, uint32_t>> pointIdx_;
  std::map<std::pair<IPoint, IPoint>, std::map<EdgeId, uint32_t>> overlapIdx_;
};

} // namespace curve2d
