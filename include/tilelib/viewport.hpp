#pragma once

#include "tilelib/tile.hpp"

#include <cstdint>
#include <vector>

namespace tilelib {

// A viewport pins a generation (version) and a tile rectangle at its finest
// level. Required tiles are requested coarse-to-fine across the level range
// [min_level, level], i.e. by viewport hierarchy.
struct Viewport {
    std::uint64_t generation = 0;
    std::uint32_t min_level = 0;
    std::uint32_t level = 0;
    std::uint32_t x0 = 0; // inclusive rect at `level`
    std::uint32_t y0 = 0;
    std::uint32_t x1 = 0;
    std::uint32_t y1 = 0;
};

inline std::vector<TileId> required_tiles(const Viewport& v) {
    std::vector<TileId> out;
    for (std::uint32_t l = v.min_level; l <= v.level; ++l) {
        const std::uint32_t shift = v.level - l;
        const std::uint32_t bx0 = v.x0 >> shift, bx1 = v.x1 >> shift;
        const std::uint32_t by0 = v.y0 >> shift, by1 = v.y1 >> shift;
        for (std::uint32_t y = by0; y <= by1; ++y)
            for (std::uint32_t x = bx0; x <= bx1; ++x)
                out.push_back(TileId{l, x, y});
    }
    return out;
}

} // namespace tilelib
