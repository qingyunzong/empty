#include "geom/rect_union.hpp"

#include <algorithm>
#include <cstdlib>
#include <vector>

namespace geom {

bool RectUnion::add(Id id, Coord x1, Coord y1, Coord x2, Coord y2) {
    if (x1 > x2) std::swap(x1, x2);
    if (y1 > y2) std::swap(y1, y2);
    if (x1 == x2 || y1 == y2) {
        return false; // zero-area rectangles are ignored
    }
    const Rect rect{x1, y1, x2, y2};
    const auto it = rects_.find(id);
    if (it != rects_.end()) {
        if (it->second.x1 == rect.x1 && it->second.y1 == rect.y1 &&
            it->second.x2 == rect.x2 && it->second.y2 == rect.y2) {
            return false; // identical rectangle, nothing changed
        }
        it->second = rect;
    } else {
        rects_.emplace(id, rect);
    }
    recompute();
    return true;
}

bool RectUnion::remove(Id id) {
    if (rects_.erase(id) == 0) {
        return false;
    }
    recompute();
    return true;
}

void RectUnion::recompute() {
    area_ = 0;
    perimeter_ = 0;
    if (rects_.empty()) {
        return;
    }

    std::vector<Coord> xs;
    std::vector<Coord> ys;
    xs.reserve(rects_.size() * 2);
    ys.reserve(rects_.size() * 2);
    for (const auto& [id, r] : rects_) {
        xs.push_back(r.x1);
        xs.push_back(r.x2);
        ys.push_back(r.y1);
        ys.push_back(r.y2);
    }
    std::sort(xs.begin(), xs.end());
    xs.erase(std::unique(xs.begin(), xs.end()), xs.end());
    std::sort(ys.begin(), ys.end());
    ys.erase(std::unique(ys.begin(), ys.end()), ys.end());

    const std::size_t nx = xs.size() - 1;
    const std::size_t ny = ys.size() - 1;
    std::vector<std::uint8_t> covered(nx * ny, 0);

    for (const auto& [id, r] : rects_) {
        const std::size_t xi1 = static_cast<std::size_t>(
            std::lower_bound(xs.begin(), xs.end(), r.x1) - xs.begin());
        const std::size_t xi2 = static_cast<std::size_t>(
            std::lower_bound(xs.begin(), xs.end(), r.x2) - xs.begin());
        const std::size_t yi1 = static_cast<std::size_t>(
            std::lower_bound(ys.begin(), ys.end(), r.y1) - ys.begin());
        const std::size_t yi2 = static_cast<std::size_t>(
            std::lower_bound(ys.begin(), ys.end(), r.y2) - ys.begin());
        for (std::size_t yi = yi1; yi < yi2; ++yi) {
            std::fill(covered.begin() + static_cast<std::ptrdiff_t>(yi * nx + xi1),
                      covered.begin() + static_cast<std::ptrdiff_t>(yi * nx + xi2),
                      std::uint8_t{1});
        }
    }

    const auto at = [&](std::size_t xi, std::size_t yi) -> std::uint8_t {
        return covered[yi * nx + xi];
    };

    for (std::size_t yi = 0; yi < ny; ++yi) {
        for (std::size_t xi = 0; xi < nx; ++xi) {
            if (at(xi, yi) == 0) {
                continue;
            }
            const std::int64_t w = xs[xi + 1] - xs[xi];
            const std::int64_t h = ys[yi + 1] - ys[yi];
            area_ += w * h;
            if (xi == 0 || at(xi - 1, yi) == 0) perimeter_ += h;
            if (xi + 1 == nx || at(xi + 1, yi) == 0) perimeter_ += h;
            if (yi == 0 || at(xi, yi - 1) == 0) perimeter_ += w;
            if (yi + 1 == ny || at(xi, yi + 1) == 0) perimeter_ += w;
        }
    }
}

} // namespace geom
