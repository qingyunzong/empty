#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <vector>

namespace spatial {

using ObjectId = std::uint32_t;

// Exact rational number num/den with den > 0. Arithmetic is exact because
// all inputs derive from int64 coordinates, and products fit in __int128.
struct Rational {
    __int128 num = 0;
    __int128 den = 1;
};

// Returns -1, 0, +1. Exact via cross-multiplication in __int128.
int compare(const Rational& a, const Rational& b);
Rational makeRational(__int128 num, __int128 den); // normalizes sign, den > 0

struct Aabb {
    std::array<std::int64_t, 3> min{};
    std::array<std::int64_t, 3> max{};
};

struct Ray {
    std::array<std::int64_t, 3> origin{};
    std::array<std::int64_t, 3> dir{}; // components may be zero
};

struct RayHit {
    bool hit = false;
    Rational tEnter{}; // valid when hit; clamped to >= 0
    Rational tExit{};  // valid when hit
};

// Exact slab test with inclusive boundaries: a ray merely touching a face,
// edge, or corner counts as a hit. Only t >= 0 is considered.
RayHit rayAabbIntersect(const Ray& ray, const Aabb& box);

struct QueryResult {
    std::vector<ObjectId> candidates; // broad-phase (superset of hits)
    std::vector<ObjectId> hits;       // narrow-phase, exact rational test
};

// An immutable, independently queryable view of the world. Obtained from
// SpatialDb::snapshot(); stays valid and unchanged after later publishes.
class Snapshot {
public:
    explicit Snapshot(std::vector<std::pair<ObjectId, Aabb>> objects);

    QueryResult query(const Ray& ray) const;

    const std::vector<std::pair<ObjectId, Aabb>>& objects() const { return objects_; }

private:
    struct Node {
        Aabb box;
        std::int32_t left = -1;  // child node indices (internal nodes)
        std::int32_t right = -1;
        std::uint32_t objBegin = 0; // range into leafObjs_ (leaf nodes)
        std::uint32_t objCount = 0;
        bool leaf = false;
    };

    std::uint32_t build(std::vector<std::uint32_t>& order,
                        std::uint32_t begin, std::uint32_t end);

    std::vector<std::pair<ObjectId, Aabb>> objects_;
    std::vector<Node> nodes_;
    std::vector<std::uint32_t> leafObjs_; // indices into objects_
};

// Owns the live world. Batch moves are applied off to the side and then
// published atomically; readers holding older snapshots are unaffected.
class SpatialDb {
public:
    explicit SpatialDb(std::vector<std::pair<ObjectId, Aabb>> initial);

    std::shared_ptr<const Snapshot> snapshot() const;

    // Applies all moves as one atomic publish. Each move replaces the AABB
    // of the given object id. Unknown ids are ignored.
    void applyBatch(const std::vector<std::pair<ObjectId, Aabb>>& moves);

private:
    mutable std::mutex mutex_;
    std::vector<std::pair<ObjectId, Aabb>> objects_;
    std::atomic<std::shared_ptr<const Snapshot>> published_;
};

// Reference implementation: exact test against every object. Used by tests
// to cross-check tree queries.
std::vector<ObjectId> bruteForceHits(const Snapshot& snap, const Ray& ray);

} // namespace spatial
