#include "interval_set.hpp"

#include <algorithm>
#include <sstream>

IntervalSet::IntervalSet(std::vector<Interval> ivs) : intervals_(normalize(std::move(ivs))) {}

IntervalSet IntervalSet::bottom() { return IntervalSet(); }

IntervalSet IntervalSet::top() { return IntervalSet({Interval{0, kNumValues - 1}}); }

IntervalSet IntervalSet::constant(int value) {
    int v = ((value % kNumValues) + kNumValues) % kNumValues;
    return IntervalSet({Interval{v, v}});
}

IntervalSet IntervalSet::range(int lo, int hi) {
    lo = std::max(lo, 0);
    hi = std::min(hi, kNumValues - 1);
    if (lo > hi) return bottom();
    return IntervalSet({Interval{lo, hi}});
}

std::vector<IntervalSet::Interval> IntervalSet::normalize(std::vector<Interval> ivs) {
    std::sort(ivs.begin(), ivs.end(),
              [](const Interval& a, const Interval& b) { return a.lo < b.lo; });
    std::vector<Interval> out;
    for (const Interval& iv : ivs) {
        if (iv.lo > iv.hi) continue;
        if (!out.empty() && iv.lo <= out.back().hi + 1) {
            out.back().hi = std::max(out.back().hi, iv.hi);
        } else {
            out.push_back(iv);
        }
    }
    if (static_cast<int>(out.size()) > kMaxSegments) {
        out = {Interval{out.front().lo, out.back().hi}}; // hull merge
    }
    return out;
}

bool IntervalSet::contains(int value) const {
    for (const Interval& iv : intervals_) {
        if (iv.lo <= value && value <= iv.hi) return true;
    }
    return false;
}

bool IntervalSet::includes(const IntervalSet& other) const {
    for (const Interval& need : other.intervals_) {
        bool covered = false;
        for (const Interval& have : intervals_) {
            if (have.lo <= need.lo && need.hi <= have.hi) {
                covered = true;
                break;
            }
        }
        if (!covered) return false;
    }
    return true;
}

IntervalSet IntervalSet::join(const IntervalSet& other) const {
    std::vector<Interval> all = intervals_;
    all.insert(all.end(), other.intervals_.begin(), other.intervals_.end());
    return IntervalSet(std::move(all));
}

IntervalSet IntervalSet::intersect(const IntervalSet& other) const {
    std::vector<Interval> out;
    for (const Interval& a : intervals_) {
        for (const Interval& b : other.intervals_) {
            Interval both{std::max(a.lo, b.lo), std::min(a.hi, b.hi)};
            if (both.lo <= both.hi) out.push_back(both);
        }
    }
    return IntervalSet(std::move(out));
}

IntervalSet IntervalSet::addWrap(int delta) const {
    int d = ((delta % kNumValues) + kNumValues) % kNumValues;
    std::vector<Interval> out;
    for (const Interval& iv : intervals_) {
        int lo = iv.lo + d;
        int hi = iv.hi + d;
        if (hi < kNumValues) {
            out.push_back({lo, hi});
        } else if (lo >= kNumValues) {
            out.push_back({lo - kNumValues, hi - kNumValues});
        } else {
            out.push_back({lo, kNumValues - 1});
            out.push_back({0, hi - kNumValues});
        }
    }
    return IntervalSet(std::move(out));
}

std::string IntervalSet::toString() const {
    if (intervals_.empty()) return "(empty)";
    std::ostringstream os;
    for (size_t i = 0; i < intervals_.size(); ++i) {
        if (i > 0) os << " U ";
        os << "[" << intervals_[i].lo << "," << intervals_[i].hi << "]";
    }
    return os.str();
}
