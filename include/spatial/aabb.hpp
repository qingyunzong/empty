#pragma once

#include <array>
#include <cstddef>

namespace spatial {

// Half-open axis-aligned bounding box: [min, max) on every axis.
// Boxes that merely touch on a boundary do NOT intersect.
// Boxes with zero (or negative) extent on any axis are empty and are
// ignored by the index: they never intersect anything, not even themselves.
template <std::size_t Dims>
struct Aabb {
    std::array<double, Dims> min{};
    std::array<double, Dims> max{};

    bool empty() const {
        for (std::size_t i = 0; i < Dims; ++i) {
            if (!(min[i] < max[i])) return true;
        }
        return false;
    }

    bool intersects(const Aabb& other) const {
        if (empty() || other.empty()) return false;
        for (std::size_t i = 0; i < Dims; ++i) {
            if (!(min[i] < other.max[i] && other.min[i] < max[i])) return false;
        }
        return true;
    }
};

using Aabb2 = Aabb<2>;

}  // namespace spatial
