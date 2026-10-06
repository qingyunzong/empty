#include "interval_set.h"

#include <algorithm>
#include <cstdio>

IntervalSet IntervalSet::full() { return range(0, 255); }

IntervalSet IntervalSet::single(uint16_t v) { return range(v, v); }

IntervalSet IntervalSet::range(uint16_t lo, uint16_t hi) {
    IntervalSet s;
    if (lo <= hi) s.segs_.push_back({lo, hi});
    return s;
}

void IntervalSet::normalize() {
    std::sort(segs_.begin(), segs_.end(),
              [](const Interval& a, const Interval& b) { return a.lo < b.lo; });
    std::vector<Interval> out;
    for (const Interval& iv : segs_) {
        if (!out.empty() && iv.lo <= out.back().hi + 1) {
            out.back().hi = std::max(out.back().hi, iv.hi);
        } else {
            out.push_back(iv);
        }
    }
    segs_.swap(out);
}

void IntervalSet::capSegments() {
    while (segs_.size() > kMaxSegments) {
        size_t best = 0;
        uint16_t bestGap = UINT16_MAX;
        for (size_t i = 0; i + 1 < segs_.size(); ++i) {
            uint16_t gap = segs_[i + 1].lo - segs_[i].hi - 1;
            if (gap < bestGap) {
                bestGap = gap;
                best = i;
            }
        }
        segs_[best].hi = segs_[best + 1].hi;
        segs_.erase(segs_.begin() + best + 1);
    }
}

bool IntervalSet::contains(uint16_t v) const {
    for (const Interval& iv : segs_) {
        if (v < iv.lo) return false;
        if (v <= iv.hi) return true;
    }
    return false;
}

size_t IntervalSet::measure() const {
    size_t n = 0;
    for (const Interval& iv : segs_) n += iv.hi - iv.lo + 1;
    return n;
}

IntervalSet IntervalSet::join(const IntervalSet& other) const {
    IntervalSet r;
    r.segs_ = segs_;
    r.segs_.insert(r.segs_.end(), other.segs_.begin(), other.segs_.end());
    r.normalize();
    r.capSegments();
    return r;
}

IntervalSet IntervalSet::addWrap(uint16_t c) const {
    IntervalSet r;
    for (const Interval& iv : segs_) {
        uint32_t lo = iv.lo + c;
        uint32_t hi = iv.hi + c;
        if (hi < 256) {
            r.segs_.push_back({(uint16_t)lo, (uint16_t)hi});
        } else if (lo >= 256) {
            r.segs_.push_back({(uint16_t)(lo - 256), (uint16_t)(hi - 256)});
        } else {
            r.segs_.push_back({(uint16_t)lo, 255});
            r.segs_.push_back({0, (uint16_t)(hi - 256)});
        }
    }
    r.normalize();
    r.capSegments();
    return r;
}

IntervalSet IntervalSet::subWrap(uint16_t c) const {
    IntervalSet r;
    for (const Interval& iv : segs_) {
        int lo = (int)iv.lo - (int)c;
        int hi = (int)iv.hi - (int)c;
        if (lo >= 0) {
            r.segs_.push_back({(uint16_t)lo, (uint16_t)hi});
        } else if (hi < 0) {
            r.segs_.push_back({(uint16_t)(lo + 256), (uint16_t)(hi + 256)});
        } else {
            r.segs_.push_back({0, (uint16_t)hi});
            r.segs_.push_back({(uint16_t)(lo + 256), 255});
        }
    }
    r.normalize();
    r.capSegments();
    return r;
}

IntervalSet IntervalSet::intersect(uint16_t lo, uint16_t hi) const {
    IntervalSet r;
    if (lo > hi) return r;
    for (const Interval& iv : segs_) {
        uint16_t a = std::max(iv.lo, lo);
        uint16_t b = std::min(iv.hi, hi);
        if (a <= b) r.segs_.push_back({a, b});
    }
    return r;
}

std::string IntervalSet::toString() const {
    if (segs_.empty()) return "(bottom)";
    std::string s;
    for (size_t i = 0; i < segs_.size(); ++i) {
        if (i) s += " ∪ ";
        char buf[32];
        std::snprintf(buf, sizeof buf, "[%u,%u]", segs_[i].lo, segs_[i].hi);
        s += buf;
    }
    return s;
}
