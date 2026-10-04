#pragma once

// Incremental curve library.
//
// Stores polyline edges (2D segments) and maintains, after every batch
// update, the exact set of:
//   * point intersections  - rational points, deduplicated, each carrying the
//                            set of source edge ids passing through it;
//   * collinear overlaps   - maximal shared sub-segments, each carrying its
//                            source edge pair.
//
// Only pairs involving newly added edges are examined on update, so results
// are incremental; recomputeAll() rebuilds from the full all-pairs scan and
// must yield identical results.

#include "curvelib/geometry.hpp"

#include <cstddef>
#include <map>
#include <set>
#include <vector>

namespace curvelib {

using EdgeId = std::size_t;

struct OverlapSegment {
  RationalPoint lo, hi; // canonical order: lo < hi
  EdgeId e1 = 0, e2 = 0; // source edges, e1 < e2

  bool operator<(const OverlapSegment& o) const {
    if (lo != o.lo) return lo < o.lo;
    if (hi != o.hi) return hi < o.hi;
    if (e1 != o.e1) return e1 < o.e1;
    return e2 < o.e2;
  }
  bool operator==(const OverlapSegment&) const = default;
};

class CurveLibrary {
public:
  using PointMap = std::map<RationalPoint, std::set<EdgeId>>;
  using OverlapSet = std::set<OverlapSegment>;

  EdgeId addEdge(const Segment& s) { return addEdges({s}).front(); }

  // Append a batch of edges; only pairs touching the new edges are tested.
  std::vector<EdgeId> addEdges(const std::vector<Segment>& batch) {
    const EdgeId old_count = edges_.size();
    std::vector<EdgeId> ids;
    ids.reserve(batch.size());
    for (const Segment& s : batch) {
      ids.push_back(edges_.size());
      edges_.push_back(s);
    }
    for (EdgeId i = old_count; i < edges_.size(); ++i)
      for (EdgeId j = 0; j < i; ++j) processPair(j, i);
    // Pairs within the batch are covered above (j runs over all earlier ids,
    // including earlier edges of the same batch).
    return ids;
  }

  // Full all-pairs rebuild from scratch (reference for the incremental path).
  void recomputeAll() {
    points_.clear();
    overlaps_.clear();
    for (EdgeId i = 0; i < edges_.size(); ++i)
      for (EdgeId j = 0; j < i; ++j) processPair(j, i);
  }

  const std::vector<Segment>& edges() const { return edges_; }
  const PointMap& pointIntersections() const { return points_; }
  const OverlapSet& overlaps() const { return overlaps_; }

  // Result equality (edge list plus both result sets).
  bool sameResults(const CurveLibrary& o) const {
    return edges_ == o.edges_ && points_ == o.points_ &&
           overlaps_ == o.overlaps_;
  }

private:
  void processPair(EdgeId i, EdgeId j) {
    const PairIntersection hit = intersect(edges_[i], edges_[j]);
    switch (hit.kind) {
    case IntersectionKind::None:
      break;
    case IntersectionKind::Point: {
      auto& sources = points_[hit.point];
      sources.insert(i);
      sources.insert(j);
      break;
    }
    case IntersectionKind::Overlap:
      overlaps_.insert(
          OverlapSegment{hit.overlap_lo, hit.overlap_hi, i, j});
      break;
    }
  }

  std::vector<Segment> edges_;
  PointMap points_;
  OverlapSet overlaps_;
};

} // namespace curvelib
