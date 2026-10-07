#pragma once

#include <cstdint>
#include <memory>
#include <unordered_map>
#include <vector>

namespace skyline {

using Coord = std::int64_t;
using Height = std::int64_t;
using RectId = std::int64_t;

// Axis-aligned rectangle on the skyline, half-open interval [left, right).
// A rectangle is "empty" (contributes nothing) when height <= 0 or left >= right.
struct Rect {
    RectId id = 0;
    Coord left = 0;
    Coord right = 0;
    Height height = 0;
    bool empty() const { return height <= 0 || left >= right; }
    bool operator==(const Rect&) const = default;
};

// Skyline change point: for x in [p.x, next.x) the height is p.height.
// Consecutive points always have distinct heights (adjacent equal heights merged).
struct ChangePoint {
    Coord x = 0;
    Height height = 0;
    bool operator==(const ChangePoint&) const = default;
};

// A maximal segment on which the set of top (max-height) rectangles is constant.
// `sources` holds every rect id attaining the max height on [left, right), sorted.
// Height 0 with empty sources means "no rectangle covers this segment".
struct Segment {
    Coord left = 0;
    Coord right = 0;
    Height height = 0;
    std::vector<RectId> sources;
    bool operator==(const Segment&) const = default;
};

// A maximal segment on which the top-source set differs between two snapshots.
// Emitted even when the height itself did not change (source-only change).
struct SourceChange {
    Coord left = 0;
    Coord right = 0;
    Height oldHeight = 0;
    Height newHeight = 0;
    std::vector<RectId> oldSources;
    std::vector<RectId> newSources;
    bool heightChanged() const { return oldHeight != newHeight; }
    bool operator==(const SourceChange&) const = default;
};

class Skyline {
public:
    using Map = std::unordered_map<RectId, Rect>;

    // Immutable handle to a past state. Cheap to copy (shared ownership).
    class Snapshot {
        friend class Skyline;
        std::shared_ptr<const Map> state_;
        std::uint64_t version_ = 0;

    public:
        Snapshot() = default;
        std::uint64_t version() const { return version_; }
    };

    Skyline();

    // Upserts a rectangle. Empty rectangles (height <= 0 or left >= right)
    // are stored but contribute nothing.
    void add(const Rect& r);
    void add(const std::vector<Rect>& rs);

    // Removes only the contribution of the given id. Returns false if absent.
    bool remove(RectId id);
    std::size_t remove(const std::vector<RectId>& ids);

    // Applies removals then additions as one batch; returns the new snapshot.
    Snapshot applyBatch(const std::vector<Rect>& adds, const std::vector<RectId>& removes);

    Snapshot snapshot() const;
    std::uint64_t version() const { return version_; }
    std::size_t size() const;

    // Skyline of the current (or snapshotted) state as merged change points.
    std::vector<ChangePoint> skyline() const;
    std::vector<ChangePoint> skyline(const Snapshot& snap) const;

    // Per-segment ids of all top rectangles inside the half-open query [ql, qr).
    // Regions with no covering rect report height 0 and empty sources.
    std::vector<Segment> topSegments(Coord ql, Coord qr) const;
    std::vector<Segment> topSegments(const Snapshot& snap, Coord ql, Coord qr) const;

    // Maximal segments where the top-source set changed between two snapshots,
    // including changes that leave the height untouched.
    static std::vector<SourceChange> diffSources(const Snapshot& oldSnap,
                                                 const Snapshot& newSnap);

private:
    std::shared_ptr<const Map> state_;
    std::uint64_t version_ = 0;

    void commit(Map next);
    static const Map& deref(const Snapshot& snap);
    static std::vector<ChangePoint> computeSkyline(const Map& m);
    static std::vector<Segment> computeTopSegments(const Map& m, Coord ql, Coord qr);
};

} // namespace skyline
