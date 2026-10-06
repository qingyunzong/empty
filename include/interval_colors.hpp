#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <vector>

namespace icm {

// Half-open colored segment [left, right).
struct Segment {
    std::int64_t left;
    std::int64_t right;
    std::uint64_t color;

    friend bool operator==(const Segment&, const Segment&) = default;
};

// Persistent interval coloring over integer half-open ranges.
//
// Copy-array model: every version owns a full, independent copy of its
// sorted segment array. paint() builds a new array and appends it as a
// new version; existing versions are never mutated, so any old version
// can be queried or branched from at any time.
//
// Invariants per version:
//   - segments are sorted, non-overlapping, non-empty;
//   - adjacent segments never share a color (same-color runs are merged);
//   - uncolored regions are gaps, not stored.
class IntervalColors {
public:
    using Version = std::size_t;

    IntervalColors() : versions_(1) {} // version 0: completely uncolored

    // Paint [left, right) with `color` on top of `base`, returning the new
    // version. An empty range (left >= right) changes nothing and returns
    // `base` itself, so no new version is allocated.
    Version paint(Version base, std::int64_t left, std::int64_t right,
                  std::uint64_t color) {
        const std::vector<Segment>& segs = at(base);
        if (left >= right) return base;

        std::vector<Segment> next;
        next.reserve(segs.size() + 2);
        for (const Segment& s : segs) {
            if (s.right <= left || s.left >= right) {
                next.push_back(s); // disjoint: kept as-is
                continue;
            }
            if (s.left < left) next.push_back({s.left, left, s.color});
            if (s.right > right) next.push_back({right, s.right, s.color});
        }

        auto pos = std::lower_bound(next.begin(), next.end(), left,
            [](const Segment& s, std::int64_t v) { return s.left < v; });
        next.insert(pos, Segment{left, right, color});

        versions_.push_back(merge_adjacent(std::move(next)));
        return versions_.size() - 1;
    }

    // All colored segments of a version, in order.
    const std::vector<Segment>& segments(Version v) const { return at(v); }

    // Color at point x, or std::nullopt if x is uncolored.
    std::optional<std::uint64_t> color_at(Version v, std::int64_t x) const {
        const auto& segs = at(v);
        auto it = std::upper_bound(segs.begin(), segs.end(), x,
            [](std::int64_t value, const Segment& s) { return value < s.left; });
        if (it == segs.begin()) return std::nullopt;
        --it;
        if (x < it->right) return it->color;
        return std::nullopt;
    }

    // Total covered (colored) length of a version.
    std::int64_t covered_length(Version v) const {
        std::int64_t total = 0;
        for (const Segment& s : at(v)) total += s.right - s.left;
        return total;
    }

    // Covered length intersected with the query range [left, right).
    std::int64_t covered_length(Version v, std::int64_t left,
                                std::int64_t right) const {
        if (left >= right) return 0;
        std::int64_t total = 0;
        for (const Segment& s : at(v)) {
            if (s.right <= left) continue;
            if (s.left >= right) break;
            total += std::min(s.right, right) - std::max(s.left, left);
        }
        return total;
    }

    Version version_count() const { return versions_.size(); }

private:
    const std::vector<Segment>& at(Version v) const {
        if (v >= versions_.size())
            throw std::out_of_range("IntervalColors: unknown version");
        return versions_[v];
    }

    static std::vector<Segment> merge_adjacent(std::vector<Segment> segs) {
        std::vector<Segment> merged;
        merged.reserve(segs.size());
        for (const Segment& s : segs) {
            if (!merged.empty() && merged.back().color == s.color &&
                merged.back().right == s.left) {
                merged.back().right = s.right;
            } else {
                merged.push_back(s);
            }
        }
        return merged;
    }

    std::vector<std::vector<Segment>> versions_;
};

} // namespace icm
