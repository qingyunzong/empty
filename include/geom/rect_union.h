#pragma once

#include <cstddef>
#include <cstdint>
#include <unordered_map>

namespace geom {

// Maintains a dynamic set of axis-aligned integer rectangles keyed by id and
// tracks the exact area and perimeter of their union.
//
// - Rectangles are half-open: [x1, x2) x [y1, y2); coordinates are normalized
//   so x1 < x2 and y1 < y2 after swapping.
// - Zero-area rectangles (x1 == x2 or y1 == y2) are ignored: add() returns
//   false and nothing is stored.
// - Overlapping and edge-touching rectangles merge: interior edges never
//   contribute to the perimeter.
// - All arithmetic is exact 64-bit integer math.
class RectUnion {
public:
    // Adds a rectangle. Returns false (and changes nothing) if the id already
    // exists or the rectangle has zero area.
    bool add(std::int64_t id, std::int64_t x1, std::int64_t y1,
             std::int64_t x2, std::int64_t y2);

    // Removes the rectangle with the given id. Returns false if absent.
    bool remove(std::int64_t id);

    bool contains(std::int64_t id) const;
    std::size_t size() const { return rects_.size(); }

    std::int64_t area() const { return area_; }
    std::int64_t perimeter() const { return perimeter_; }

private:
    struct Rect {
        std::int64_t x1, y1, x2, y2;
    };

    std::unordered_map<std::int64_t, Rect> rects_;
    std::int64_t area_ = 0;
    std::int64_t perimeter_ = 0;

    void recompute();
};

} // namespace geom
