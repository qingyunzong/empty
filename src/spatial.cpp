#include "spatial/spatial.hpp"

#include <algorithm>
#include <numeric>
#include <stdexcept>
#include <unordered_map>

namespace spatial {

Rational makeRational(__int128 num, __int128 den) {
    if (den == 0) throw std::invalid_argument("rational with zero denominator");
    if (den < 0) { num = -num; den = -den; }
    return Rational{num, den};
}

int compare(const Rational& a, const Rational& b) {
    __int128 lhs = a.num * b.den;
    __int128 rhs = b.num * a.den;
    if (lhs < rhs) return -1;
    if (lhs > rhs) return 1;
    return 0;
}

RayHit rayAabbIntersect(const Ray& ray, const Aabb& box) {
    const Rational zero{0, 1};
    bool haveMin = false, haveMax = false;
    Rational tmin{}, tmax{};

    for (int axis = 0; axis < 3; ++axis) {
        const std::int64_t o = ray.origin[axis];
        const std::int64_t d = ray.dir[axis];
        if (d == 0) {
            // Ray is parallel to this slab: origin must lie inside (inclusive).
            if (o < box.min[axis] || o > box.max[axis]) return {};
            continue;
        }
        Rational t1 = makeRational(static_cast<__int128>(box.min[axis]) - o, d);
        Rational t2 = makeRational(static_cast<__int128>(box.max[axis]) - o, d);
        if (compare(t1, t2) > 0) std::swap(t1, t2);
        if (!haveMin || compare(t1, tmin) > 0) tmin = t1;
        if (!haveMax || compare(t2, tmax) < 0) tmax = t2;
        haveMin = haveMax = true;
        if (compare(tmin, tmax) > 0) return {}; // slabs disjoint
    }

    if (!haveMin) {
        // Degenerate ray (zero direction): hit iff origin is inside the box.
        return RayHit{true, zero, zero};
    }
    if (compare(tmax, zero) < 0) return {}; // box entirely behind the ray
    RayHit out;
    out.hit = true;
    out.tEnter = compare(tmin, zero) > 0 ? tmin : zero;
    out.tExit = tmax;
    return out;
}

namespace {

Aabb unionOf(const Aabb& a, const Aabb& b) {
    Aabb out;
    for (int i = 0; i < 3; ++i) {
        out.min[i] = std::min(a.min[i], b.min[i]);
        out.max[i] = std::max(a.max[i], b.max[i]);
    }
    return out;
}

std::int64_t centroid(const Aabb& b, int axis) {
    // Sum instead of mean: same ordering, no truncation issues.
    return b.min[axis] + b.max[axis];
}

constexpr std::uint32_t kLeafCapacity = 4;

} // namespace

Snapshot::Snapshot(std::vector<std::pair<ObjectId, Aabb>> objects)
    : objects_(std::move(objects)) {
    if (objects_.empty()) return;
    std::vector<std::uint32_t> order(objects_.size());
    std::iota(order.begin(), order.end(), 0u);
    nodes_.reserve(objects_.size());
    leafObjs_.reserve(objects_.size());
    build(order, 0, static_cast<std::uint32_t>(order.size()));
}

std::uint32_t Snapshot::build(std::vector<std::uint32_t>& order,
                              std::uint32_t begin, std::uint32_t end) {
    const std::uint32_t index = static_cast<std::uint32_t>(nodes_.size());
    nodes_.push_back(Node{});
    Node* node = &nodes_[index];

    Aabb box = objects_[order[begin]].second;
    for (std::uint32_t i = begin + 1; i < end; ++i)
        box = unionOf(box, objects_[order[i]].second);
    node->box = box;

    const std::uint32_t count = end - begin;
    if (count <= kLeafCapacity) {
        node->leaf = true;
        node->objBegin = static_cast<std::uint32_t>(leafObjs_.size());
        node->objCount = count;
        for (std::uint32_t i = begin; i < end; ++i)
            leafObjs_.push_back(order[i]);
        return index;
    }

    // Split along the axis with the largest centroid spread.
    std::array<std::int64_t, 3> cmin{}, cmax{};
    for (int a = 0; a < 3; ++a) {
        cmin[a] = cmax[a] = centroid(objects_[order[begin]].second, a);
    }
    for (std::uint32_t i = begin + 1; i < end; ++i) {
        for (int a = 0; a < 3; ++a) {
            const std::int64_t c = centroid(objects_[order[i]].second, a);
            cmin[a] = std::min(cmin[a], c);
            cmax[a] = std::max(cmax[a], c);
        }
    }
    int axis = 0;
    for (int a = 1; a < 3; ++a)
        if (cmax[a] - cmin[a] > cmax[axis] - cmin[axis]) axis = a;

    const std::uint32_t mid = begin + count / 2;
    std::nth_element(order.begin() + begin, order.begin() + mid, order.begin() + end,
                     [&](std::uint32_t x, std::uint32_t y) {
                         return centroid(objects_[x].second, axis) <
                                centroid(objects_[y].second, axis);
                     });

    // Recursion may reallocate nodes_, so assign children by index afterwards.
    const std::uint32_t left = build(order, begin, mid);
    const std::uint32_t right = build(order, mid, end);
    nodes_[index].left = static_cast<std::int32_t>(left);
    nodes_[index].right = static_cast<std::int32_t>(right);
    return index;
}

QueryResult Snapshot::query(const Ray& ray) const {
    QueryResult result;
    if (nodes_.empty()) return result;

    // Broad phase: walk the tree; every object under a hit leaf becomes a
    // candidate (no per-object test yet).
    std::vector<std::uint32_t> candidateIdx;
    std::vector<std::uint32_t> stack;
    stack.push_back(0); // build() creates the root first, at index 0
    while (!stack.empty()) {
        const std::uint32_t ni = stack.back();
        stack.pop_back();
        const Node& node = nodes_[ni];
        if (!rayAabbIntersect(ray, node.box).hit) continue;
        if (node.leaf) {
            for (std::uint32_t i = 0; i < node.objCount; ++i)
                candidateIdx.push_back(leafObjs_[node.objBegin + i]);
        } else {
            stack.push_back(static_cast<std::uint32_t>(node.left));
            stack.push_back(static_cast<std::uint32_t>(node.right));
        }
    }

    // Narrow phase: exact rational ray-vs-object test on candidates only.
    for (std::uint32_t idx : candidateIdx) {
        const auto& [id, box] = objects_[idx];
        result.candidates.push_back(id);
        if (rayAabbIntersect(ray, box).hit) result.hits.push_back(id);
    }

    std::sort(result.candidates.begin(), result.candidates.end());
    std::sort(result.hits.begin(), result.hits.end());
    return result;
}

SpatialDb::SpatialDb(std::vector<std::pair<ObjectId, Aabb>> initial)
    : objects_(std::move(initial)) {
    published_.store(std::make_shared<const Snapshot>(objects_));
}

std::shared_ptr<const Snapshot> SpatialDb::snapshot() const {
    return published_.load();
}

void SpatialDb::applyBatch(const std::vector<std::pair<ObjectId, Aabb>>& moves) {
    std::lock_guard lock(mutex_);

    std::unordered_map<ObjectId, Aabb> pending;
    pending.reserve(moves.size());
    for (const auto& [id, box] : moves) pending[id] = box;

    std::vector<std::pair<ObjectId, Aabb>> next = objects_;
    for (auto& [id, box] : next) {
        auto it = pending.find(id);
        if (it != pending.end()) box = it->second;
    }

    // Build the new immutable snapshot off to the side, then publish it with
    // a single atomic store. Readers either see the old or the new snapshot.
    auto fresh = std::make_shared<const Snapshot>(next);
    published_.store(std::move(fresh));
    objects_ = std::move(next);
}

std::vector<ObjectId> bruteForceHits(const Snapshot& snap, const Ray& ray) {
    std::vector<ObjectId> hits;
    for (const auto& [id, box] : snap.objects())
        if (rayAabbIntersect(ray, box).hit) hits.push_back(id);
    std::sort(hits.begin(), hits.end());
    return hits;
}

} // namespace spatial
