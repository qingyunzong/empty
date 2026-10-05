#pragma once

#include <algorithm>
#include <cstdint>
#include <utility>
#include <vector>

#include "spatial/aabb.hpp"

namespace spatial {

using ObjectId = std::uint64_t;

struct Entry {
  ObjectId id;
  Aabb box;
};

struct Hit {
  ObjectId id;
  Rational t_enter;
  Rational t_exit;
};

inline bool hit_less(const Hit& a, const Hit& b) {
  if (a.t_enter != b.t_enter) return a.t_enter < b.t_enter;
  return a.id < b.id;
}

struct QueryResult {
  std::vector<ObjectId> candidates;  // broad phase: leaves under hit nodes
  std::vector<Hit> hits;             // narrow phase: exact rational test
};

// Immutable snapshot of all objects plus a BVH over their AABBs. Built once,
// published atomically by Space, and kept alive by readers via shared_ptr.
class Snapshot {
 public:
  explicit Snapshot(std::vector<Entry> entries) : entries_(std::move(entries)) {
    if (entries_.empty()) return;
    std::vector<std::int32_t> order(entries_.size());
    for (std::size_t i = 0; i < order.size(); ++i) order[i] = (std::int32_t)i;
    root_ = build(order, 0, (std::int32_t)order.size());
  }

  std::size_t size() const { return entries_.size(); }
  const std::vector<Entry>& entries() const { return entries_; }

  // Broad phase: traverse internal nodes with the exact test; every leaf
  // reached becomes a candidate. Narrow phase: exact test on each
  // candidate's own box. Hits are sorted by (t_enter, id).
  QueryResult query_ray(const Ray& ray, Rational t_max) const {
    QueryResult out;
    if (root_ < 0) return out;
    if (!ray_intersect(nodes_[root_].box, ray, t_max).hit) return out;

    std::vector<std::int32_t> stack{root_};
    std::vector<std::int32_t> candidate_entries;
    while (!stack.empty()) {
      const std::int32_t ni = stack.back();
      stack.pop_back();
      const Node& n = nodes_[ni];
      if (n.object >= 0) {
        candidate_entries.push_back(n.object);
        continue;
      }
      for (std::int32_t child : {n.left, n.right}) {
        const Node& c = nodes_[child];
        if (c.object >= 0) {
          stack.push_back(child);  // leaf: untested, broad-phase candidate
        } else if (ray_intersect(c.box, ray, t_max).hit) {
          stack.push_back(child);
        }
      }
    }

    out.candidates.reserve(candidate_entries.size());
    for (std::int32_t ei : candidate_entries) {
      const Entry& e = entries_[ei];
      out.candidates.push_back(e.id);
      RayBoxHit h = ray_intersect(e.box, ray, t_max);
      if (h.hit) out.hits.push_back({e.id, h.t_enter, h.t_exit});
    }
    std::sort(out.candidates.begin(), out.candidates.end());
    std::sort(out.hits.begin(), out.hits.end(), hit_less);
    return out;
  }

  // Reference brute-force scan over every object (ground truth for tests).
  std::vector<Hit> scan_ray(const Ray& ray, Rational t_max) const {
    std::vector<Hit> out;
    for (const Entry& e : entries_) {
      RayBoxHit h = ray_intersect(e.box, ray, t_max);
      if (h.hit) out.push_back({e.id, h.t_enter, h.t_exit});
    }
    std::sort(out.begin(), out.end(), hit_less);
    return out;
  }

 private:
  struct Node {
    Aabb box;
    std::int32_t left = -1;
    std::int32_t right = -1;
    std::int32_t object = -1;  // entry index when this is a leaf
  };

  static std::int64_t centroid(const Aabb& b, int axis) {
    // Sum fits: coordinates are expected well below 2^62.
    return b.lo[axis] + b.hi[axis];
  }

  std::int32_t build(std::vector<std::int32_t>& order, std::int32_t lo,
                     std::int32_t hi) {
    Node node;
    node.box = entries_[order[lo]].box;
    for (std::int32_t i = lo + 1; i < hi; ++i)
      node.box = unite(node.box, entries_[order[i]].box);

    const std::int32_t index = (std::int32_t)nodes_.size();
    nodes_.push_back(node);
    if (hi - lo == 1) {
      nodes_[index].object = order[lo];
      return index;
    }

    int axis = 0;
    std::int64_t best_span = -1;
    for (int a = 0; a < 3; ++a) {
      std::int64_t cmin = centroid(entries_[order[lo]].box, a);
      std::int64_t cmax = cmin;
      for (std::int32_t i = lo + 1; i < hi; ++i) {
        const std::int64_t c = centroid(entries_[order[i]].box, a);
        cmin = c < cmin ? c : cmin;
        cmax = c > cmax ? c : cmax;
      }
      if (cmax - cmin > best_span) {
        best_span = cmax - cmin;
        axis = a;
      }
    }
    const std::int32_t mid = lo + (hi - lo) / 2;
    std::nth_element(order.begin() + lo, order.begin() + mid,
                     order.begin() + hi, [&](std::int32_t x, std::int32_t y) {
                       return centroid(entries_[x].box, axis) <
                              centroid(entries_[y].box, axis);
                     });
    nodes_[index].left = build(order, lo, mid);
    nodes_[index].right = build(order, mid, hi);
    return index;
  }

  std::vector<Entry> entries_;
  std::vector<Node> nodes_;
  std::int32_t root_ = -1;
};

}  // namespace spatial
