#pragma once

#include <cstddef>
#include <cstdint>
#include <unordered_map>

namespace geom {

// Maintains a set of axis-aligned integer rectangles keyed by id and
// reports the exact area and perimeter of their union.
//
// Rectangles are half-open: [x1, x2) x [y1, y2). Zero-area rectangles
// (x1 == x2 or y1 == y2 after normalization) are ignored. Overlapping
// and edge-touching rectangles merge: shared interior edges do not
// contribute to the perimeter. All arithmetic is exact int64_t, safe
// for coordinates in [-1e6, 1e6] and far beyond.
class RectUnion {
public:
    using Coord = std::int64_t;
    using Id = std::int64_t;

    // Adds a rectangle, replacing any existing rectangle with the same id.
    // Coordinates are normalized (min/max). Zero-area rectangles are
    // ignored and do not replace an existing entry. Returns true if the
    // stored set changed.
    bool add(Id id, Coord x1, Coord y1, Coord x2, Coord y2);

    // Removes the rectangle with the given id. Returns true if it existed.
    bool remove(Id id);

    [[nodiscard]] bool contains(Id id) const { return rects_.find(id) != rects_.end(); }
    [[nodiscard]] std::size_t size() const noexcept { return rects_.size(); }

    // Exact union area and perimeter of the current rectangle set.
    [[nodiscard]] std::int64_t area() const noexcept { return area_; }
    [[nodiscard]] std::int64_t perimeter() const noexcept { return perimeter_; }

private:
    struct Rect {
        Coord x1, y1, x2, y2;
    };

    std::unordered_map<Id, Rect> rects_;
    std::int64_t area_ = 0;
    std::int64_t perimeter_ = 0;

    // Recomputes union area/perimeter with a coordinate-compressed grid
    // model: every distinct x/y coordinate becomes a grid line, each
    // elementary cell is either fully covered or fully empty, so exact
    // integer results follow from summing covered cells and their
    // boundary edges.
    void recompute();
};

} // namespace geom
