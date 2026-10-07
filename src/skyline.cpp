#include "skyline/skyline.hpp"

#include <algorithm>
#include <map>
#include <set>
#include <utility>

namespace skyline {

Skyline::Skyline() : state_(std::make_shared<const Map>()) {}

void Skyline::commit(Map next) {
    state_ = std::make_shared<const Map>(std::move(next));
    ++version_;
}

void Skyline::add(const Rect& r) {
    Map next = *state_;
    next[r.id] = r;
    commit(std::move(next));
}

void Skyline::add(const std::vector<Rect>& rs) {
    Map next = *state_;
    for (const Rect& r : rs) next[r.id] = r;
    commit(std::move(next));
}

bool Skyline::remove(RectId id) {
    if (state_->find(id) == state_->end()) return false;
    Map next = *state_;
    next.erase(id);
    commit(std::move(next));
    return true;
}

std::size_t Skyline::remove(const std::vector<RectId>& ids) {
    Map next = *state_;
    std::size_t erased = 0;
    for (RectId id : ids) erased += next.erase(id);
    if (erased > 0) commit(std::move(next));
    return erased;
}

Skyline::Snapshot Skyline::applyBatch(const std::vector<Rect>& adds,
                                      const std::vector<RectId>& removes) {
    Map next = *state_;
    for (RectId id : removes) next.erase(id);
    for (const Rect& r : adds) next[r.id] = r;
    commit(std::move(next));
    return snapshot();
}

Skyline::Snapshot Skyline::snapshot() const {
    Snapshot snap;
    snap.state_ = state_;
    snap.version_ = version_;
    return snap;
}

std::size_t Skyline::size() const { return state_->size(); }

const Skyline::Map& Skyline::deref(const Snapshot& snap) {
    static const Map* empty = new Map();
    return snap.state_ ? *snap.state_ : *empty;
}

std::vector<ChangePoint> Skyline::computeSkyline(const Map& m) {
    // Sweep events: at x, add/remove heights. Events at the same x are applied
    // together, so a point is emitted only when the running max actually changes
    // (adjacent equal heights are merged by construction).
    std::map<Coord, std::vector<std::pair<Height, int>>> events;
    for (const auto& [id, r] : m) {
        if (r.empty()) continue;
        events[r.left].emplace_back(r.height, +1);
        events[r.right].emplace_back(r.height, -1);
    }
    std::map<Height, std::int64_t> count;
    std::vector<ChangePoint> out;
    Height current = 0;
    for (const auto& [x, deltas] : events) {
        for (const auto& [h, d] : deltas) {
            if (d > 0) {
                ++count[h];
            } else if (--count[h] == 0) {
                count.erase(h);
            }
        }
        Height top = count.empty() ? 0 : count.rbegin()->first;
        if (top != current) {
            out.push_back({x, top});
            current = top;
        }
    }
    return out;
}

std::vector<ChangePoint> Skyline::skyline() const { return computeSkyline(*state_); }

std::vector<ChangePoint> Skyline::skyline(const Snapshot& snap) const {
    return computeSkyline(deref(snap));
}

std::vector<Segment> Skyline::computeTopSegments(const Map& m, Coord ql, Coord qr) {
    if (ql >= qr) return {};
    std::vector<Coord> xs{ql, qr};
    for (const auto& [id, r] : m) {
        if (r.empty()) continue;
        Coord lo = std::max(r.left, ql);
        Coord hi = std::min(r.right, qr);
        if (lo < hi) {
            xs.push_back(lo);
            xs.push_back(hi);
        }
    }
    std::sort(xs.begin(), xs.end());
    xs.erase(std::unique(xs.begin(), xs.end()), xs.end());

    std::vector<Segment> out;
    for (std::size_t i = 0; i + 1 < xs.size(); ++i) {
        Coord a = xs[i], b = xs[i + 1];
        Height best = 0;
        std::vector<RectId> ids;
        for (const auto& [id, r] : m) {
            if (r.empty() || r.left > a || r.right < b) continue;
            if (r.height > best) {
                best = r.height;
                ids.assign(1, id);
            } else if (r.height == best) {
                ids.push_back(id);
            }
        }
        std::sort(ids.begin(), ids.end());
        if (!out.empty() && out.back().height == best && out.back().sources == ids) {
            out.back().right = b; // merge adjacent segments with identical sources
        } else {
            out.push_back({a, b, best, std::move(ids)});
        }
    }
    return out;
}

std::vector<Segment> Skyline::topSegments(Coord ql, Coord qr) const {
    return computeTopSegments(*state_, ql, qr);
}

std::vector<Segment> Skyline::topSegments(const Snapshot& snap, Coord ql, Coord qr) const {
    return computeTopSegments(deref(snap), ql, qr);
}

std::vector<SourceChange> Skyline::diffSources(const Snapshot& oldSnap,
                                               const Snapshot& newSnap) {
    const Map& oldMap = deref(oldSnap);
    const Map& newMap = deref(newSnap);

    std::set<Coord> pointSet;
    auto collect = [&pointSet](const Map& m) {
        for (const auto& [id, r] : m) {
            if (r.empty()) continue;
            pointSet.insert(r.left);
            pointSet.insert(r.right);
        }
    };
    collect(oldMap);
    collect(newMap);
    std::vector<Coord> xs(pointSet.begin(), pointSet.end());

    auto topAt = [](const Map& m, Coord a, Coord b,
                    Height& height, std::vector<RectId>& ids) {
        height = 0;
        ids.clear();
        for (const auto& [id, r] : m) {
            if (r.empty() || r.left > a || r.right < b) continue;
            if (r.height > height) {
                height = r.height;
                ids.assign(1, id);
            } else if (r.height == height) {
                ids.push_back(id);
            }
        }
        std::sort(ids.begin(), ids.end());
    };

    std::vector<SourceChange> out;
    for (std::size_t i = 0; i + 1 < xs.size(); ++i) {
        Coord a = xs[i], b = xs[i + 1];
        Height oldH, newH;
        std::vector<RectId> oldIds, newIds;
        topAt(oldMap, a, b, oldH, oldIds);
        topAt(newMap, a, b, newH, newIds);
        if (oldH == newH && oldIds == newIds) continue;
        if (!out.empty() && out.back().right == a && out.back().oldHeight == oldH &&
            out.back().newHeight == newH && out.back().oldSources == oldIds &&
            out.back().newSources == newIds) {
            out.back().right = b; // merge adjacent identical transitions
        } else {
            out.push_back({a, b, oldH, newH, std::move(oldIds), std::move(newIds)});
        }
    }
    return out;
}

} // namespace skyline
