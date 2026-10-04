#include "curve2d/library.hpp"

#include <algorithm>

namespace curve2d {

namespace {

template <typename Map>
void bump(Map& m, EdgeId e, int delta) {
  auto it = m.find(e);
  if (delta > 0) {
    ++m[e];
  } else if (it != m.end() && --it->second == 0) {
    m.erase(it);
  }
}

template <typename Map>
std::vector<EdgeId> edgeList(const Map& m) {
  std::vector<EdgeId> out;
  out.reserve(m.size());
  for (const auto& [e, count] : m) out.push_back(e);
  return out;
}

bool onSegInt(IPoint a, IPoint b, IPoint p) {
  if (orient(a, b, p) != 0) return false;
  return std::min(a.x, b.x) <= p.x && p.x <= std::max(a.x, b.x) &&
         std::min(a.y, b.y) <= p.y && p.y <= std::max(a.y, b.y);
}

using PointMap = std::map<Point, std::map<EdgeId, uint32_t>>;
using OverlapMap = std::map<std::pair<IPoint, IPoint>, std::map<EdgeId, uint32_t>>;
using PairList = std::vector<std::pair<std::pair<EdgeId, EdgeId>, PairResult>>;

// Source-edge completion: an edge is a source of a reported point iff the
// point lies on it, and a source of a reported overlap iff it covers the
// whole overlap. Any such edge is witnessed by some overlap pair record
// (otherwise the pair itself would have produced the item), so scanning
// overlap pair records completes every edge set exactly.
IntersectionSet finalize(PointMap points, OverlapMap overlaps, const PairList& pairs) {
  for (const auto& [xy, r] : pairs) {
    if (r.kind != PairKind::Overlap) continue;
    EdgeId x = xy.first, y = xy.second;
    Segment ovSeg{r.ovA, r.ovB};
    for (auto& [p, em] : points) {
      if (onSegment(ovSeg, p)) {
        em[x] = 1;
        em[y] = 1;
      }
    }
    for (auto& [ab, em] : overlaps) {
      if (onSegInt(r.ovA, r.ovB, ab.first) && onSegInt(r.ovA, r.ovB, ab.second)) {
        em[x] = 1;
        em[y] = 1;
      }
    }
  }
  IntersectionSet out;
  for (const auto& [p, em] : points)
    out.points.push_back(PointIntersection{p, edgeList(em)});
  for (const auto& [ab, em] : overlaps)
    out.overlaps.push_back(OverlapSegment{ab.first, ab.second, edgeList(em)});
  return out;
}

} // namespace

void CurveLibrary::addContribution(EdgeId x, EdgeId y, const PairResult& r, int delta) {
  if (r.kind == PairKind::Point) {
    auto& em = pointIdx_[r.point];
    bump(em, x, delta);
    bump(em, y, delta);
    if (em.empty()) pointIdx_.erase(r.point);
  } else if (r.kind == PairKind::Overlap) {
    auto& em = overlapIdx_[{r.ovA, r.ovB}];
    bump(em, x, delta);
    bump(em, y, delta);
    if (em.empty()) overlapIdx_.erase({r.ovA, r.ovB});
  }
}

std::vector<EdgeId> CurveLibrary::applyBatch(const std::vector<Segment>& adds,
                                             const std::vector<EdgeId>& removes) {
  // 1. Removals: drop every recorded pair touching a removed edge.
  for (EdgeId id : removes) {
    if (segs_.find(id) == segs_.end()) continue;
    auto ait = adj_.find(id);
    if (ait != adj_.end()) {
      std::vector<EdgeId> partners(ait->second.begin(), ait->second.end());
      for (EdgeId j : partners) {
        PairKey key{std::min(id, j), std::max(id, j)};
        auto pit = pairResults_.find(key);
        if (pit != pairResults_.end()) {
          addContribution(id, j, pit->second, -1);
          pairResults_.erase(pit);
        }
        auto jt = adj_.find(j);
        if (jt != adj_.end()) {
          jt->second.erase(id);
          if (jt->second.empty()) adj_.erase(jt);
        }
      }
      adj_.erase(ait);
    }
    segs_.erase(id);
  }

  // 2. Additions: insert edges, then intersect each new edge against all
  //    lower-id edges (covers old edges and earlier edges of this batch).
  std::vector<EdgeId> newIds;
  newIds.reserve(adds.size());
  for (const Segment& s : adds) {
    EdgeId id = nextId_++;
    segs_.emplace(id, s);
    newIds.push_back(id);
  }
  for (EdgeId i : newIds) {
    for (const auto& [j, sj] : segs_) {
      if (j >= i) break;
      PairResult r = intersectPair(segs_[i], sj);
      if (r.kind == PairKind::None) continue;
      pairResults_.emplace(PairKey{j, i}, r);
      adj_[i].insert(j);
      adj_[j].insert(i);
      addContribution(i, j, r, +1);
    }
  }
  return newIds;
}

IntersectionSet CurveLibrary::result() const {
  PairList pairs;
  pairs.reserve(pairResults_.size());
  for (const auto& [key, r] : pairResults_) pairs.push_back({{key.lo, key.hi}, r});
  return finalize(pointIdx_, overlapIdx_, pairs);
}

IntersectionSet CurveLibrary::fullRecompute() const {
  PointMap points;
  OverlapMap overlaps;
  PairList pairs;
  for (auto i = segs_.begin(); i != segs_.end(); ++i) {
    for (auto j = std::next(i); j != segs_.end(); ++j) {
      PairResult r = intersectPair(i->second, j->second);
      if (r.kind == PairKind::None) continue;
      pairs.push_back({{i->first, j->first}, r});
      if (r.kind == PairKind::Point) {
        ++points[r.point][i->first];
        ++points[r.point][j->first];
      } else {
        auto key = std::make_pair(r.ovA, r.ovB);
        ++overlaps[key][i->first];
        ++overlaps[key][j->first];
      }
    }
  }
  return finalize(points, overlaps, pairs);
}

} // namespace curve2d
