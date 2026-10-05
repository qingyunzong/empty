#pragma once

#include <array>
#include <cstddef>

namespace spatial {

// Axis-aligned bounding box with half-open semantics: [min, max).
// A box is empty (zero volume) when min[i] >= max[i] in any dimension.
template <std::size_t Dims>
struct Box {
    std::array<double, Dims> min{};
    std::array<double, Dims> max{};

    constexpr bool empty() const noexcept {
        for (std::size_t i = 0; i < Dims; ++i)
            if (!(min[i] < max[i])) return true;
        return false;
    }
};

// Half-open intersection: boxes that merely touch at a boundary do NOT
// intersect. Empty boxes never intersect anything.
template <std::size_t Dims>
constexpr bool intersects(const Box<Dims>& a, const Box<Dims>& b) noexcept {
    if (a.empty() || b.empty()) return false;
    for (std::size_t i = 0; i < Dims; ++i) {
        if (!(a.min[i] < b.max[i] && b.min[i] < a.max[i])) return false;
    }
    return true;
}

// Half-open point containment: min[i] <= p[i] < max[i].
template <std::size_t Dims>
constexpr bool contains(const Box<Dims>& b, const std::array<double, Dims>& p) noexcept {
    if (b.empty()) return false;
    for (std::size_t i = 0; i < Dims; ++i) {
        if (!(b.min[i] <= p[i] && p[i] < b.max[i])) return false;
    }
    return true;
}

}  // namespace spatial
