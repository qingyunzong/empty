#pragma once

#include <string>
#include <vector>

// A set of unsigned 8-bit values represented as a union of disjoint,
// non-adjacent, sorted intervals. At most kMaxSegments intervals are kept;
// exceeding that limit merges everything into a single hull interval
// (an over-approximation). Wraparound of the 8-bit ring is represented
// natively as two segments, e.g. [250,255] U [0,5].
class IntervalSet {
public:
    struct Interval {
        int lo = 0; // inclusive, 0..255
        int hi = 0; // inclusive, 0..255
        bool operator==(const Interval&) const = default;
    };

    static constexpr int kNumValues = 256;
    static constexpr int kMaxSegments = 4;

    IntervalSet() = default; // bottom: the empty set

    static IntervalSet bottom();
    static IntervalSet top();
    static IntervalSet constant(int value);   // value taken mod 256
    static IntervalSet range(int lo, int hi); // bottom if lo > hi; clamped to [0,255]

    bool isBottom() const { return intervals_.empty(); }
    bool contains(int value) const;
    bool includes(const IntervalSet& other) const; // *this superset-of other

    IntervalSet join(const IntervalSet& other) const;      // least upper bound (capped)
    IntervalSet intersect(const IntervalSet& other) const;
    IntervalSet addWrap(int delta) const;                  // + delta (mod 256), may split

    const std::vector<Interval>& intervals() const { return intervals_; }
    bool operator==(const IntervalSet&) const = default;
    std::string toString() const;

private:
    explicit IntervalSet(std::vector<Interval> ivs);
    static std::vector<Interval> normalize(std::vector<Interval> ivs);

    std::vector<Interval> intervals_;
};
