#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

// Inclusive interval over the 8-bit domain [0, 255].
struct Interval {
    uint16_t lo = 0;
    uint16_t hi = 0;
    bool operator==(const Interval&) const = default;
};

// Abstract value: union of disjoint, non-adjacent, sorted intervals.
// At most kMaxSegments segments are kept; when a join would exceed the
// cap, the closest pair of segments is merged (filling the gap), which
// keeps the result an over-approximation.
class IntervalSet {
public:
    static constexpr size_t kMaxSegments = 4;

    IntervalSet() = default;
    static IntervalSet full();
    static IntervalSet single(uint16_t v);
    static IntervalSet range(uint16_t lo, uint16_t hi);

    bool empty() const { return segs_.empty(); }
    size_t size() const { return segs_.size(); }
    const std::vector<Interval>& segments() const { return segs_; }

    bool contains(uint16_t v) const;
    size_t measure() const; // number of concrete points covered

    IntervalSet join(const IntervalSet& other) const; // union + cap
    IntervalSet addWrap(uint16_t c) const;            // image of x -> x + c (mod 256)
    IntervalSet subWrap(uint16_t c) const;            // image of x -> x - c (mod 256)
    IntervalSet intersect(uint16_t lo, uint16_t hi) const;

    bool operator==(const IntervalSet&) const = default;
    std::string toString() const;

private:
    std::vector<Interval> segs_; // sorted, disjoint, non-adjacent
    void normalize();
    void capSegments();
};
