#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <unordered_map>
#include <utility>
#include <vector>

#include "spatial/aabb.hpp"

namespace spatial {

// An immutable, self-contained view of the index at one point in time.
// Entries are stored in a uniform grid keyed by cell coordinates; each
// entry is inserted into every cell its box overlaps, and queries report
// an entry only from the cell holding the entry's min corner, so results
// contain no duplicates without a visited set.
class Snapshot {
public:
    struct Entry {
        std::uint64_t id;
        Aabb2 box;
    };

    Snapshot(std::vector<Entry> entries, double cell_size) : cell_size_(cell_size) {
        std::sort(entries.begin(), entries.end(),
                  [](const Entry& a, const Entry& b) { return a.id < b.id; });
        entries_ = std::move(entries);
        for (std::uint32_t i = 0; i < entries_.size(); ++i) {
            const Aabb2& b = entries_[i].box;
            const auto lo = cell_of(b.min);
            // Max corner is exclusive: a box ending exactly on a cell
            // boundary does not occupy the next cell.
            const auto hi = cell_of_max(b.max);
            for (std::int64_t y = lo.second; y <= hi.second; ++y) {
                for (std::int64_t x = lo.first; x <= hi.first; ++x) {
                    grid_[pack(x, y)].push_back(i);
                }
            }
        }
    }

    // Returns ids of all entries whose boxes intersect `range`
    // (half-open semantics), sorted by id. An empty range matches nothing.
    std::vector<std::uint64_t> query(const Aabb2& range) const {
        std::vector<std::uint64_t> out;
        if (range.empty()) return out;
        const auto lo = cell_of(range.min);
        const auto hi = cell_of_max(range.max);
        std::vector<std::uint32_t> candidates;
        for (std::int64_t y = lo.second; y <= hi.second; ++y) {
            for (std::int64_t x = lo.first; x <= hi.first; ++x) {
                auto it = grid_.find(pack(x, y));
                if (it == grid_.end()) continue;
                candidates.insert(candidates.end(), it->second.begin(),
                                  it->second.end());
            }
        }
        // Entries spanning multiple cells appear as candidates more than
        // once; deduplicate before the exact half-open intersection test.
        std::sort(candidates.begin(), candidates.end());
        candidates.erase(std::unique(candidates.begin(), candidates.end()),
                         candidates.end());
        for (std::uint32_t idx : candidates) {
            const Entry& e = entries_[idx];
            if (e.box.intersects(range)) out.push_back(e.id);
        }
        std::sort(out.begin(), out.end());
        return out;
    }

    const std::vector<Entry>& entries() const { return entries_; }
    std::size_t size() const { return entries_.size(); }

private:
    std::pair<std::int64_t, std::int64_t> cell_of(
        const std::array<double, 2>& p) const {
        return {static_cast<std::int64_t>(std::floor(p[0] / cell_size_)),
                static_cast<std::int64_t>(std::floor(p[1] / cell_size_))};
    }

    // Cell range end for an exclusive max coordinate: the last cell that
    // still contains some point strictly inside the box.
    std::pair<std::int64_t, std::int64_t> cell_of_max(
        const std::array<double, 2>& p) const {
        return cell_of({std::nextafter(p[0], -HUGE_VAL),
                        std::nextafter(p[1], -HUGE_VAL)});
    }

    static std::int64_t pack(std::int64_t x, std::int64_t y) {
        return (x << 32) ^ (y & 0xffffffffLL);
    }

    std::vector<Entry> entries_;
    double cell_size_;
    std::unordered_map<std::int64_t, std::vector<std::uint32_t>> grid_;
};

}  // namespace spatial
