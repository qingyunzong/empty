#include "geom/rect_union.h"

#include <algorithm>
#include <vector>

namespace geom {
namespace {

// Segment tree over elementary y-intervals between consecutive compressed
// coordinates. Tracks, for the covered subset of each node's interval:
//   cnt: lazy cover count (how many active rectangles fully cover the node)
//   len: total covered length
//   seg: number of connected covered components
//   lbd/rbd: whether the left/right boundary point is covered
class CoverTree {
public:
    explicit CoverTree(const std::vector<std::int64_t>& ys)
        : ys_(ys), n_(ys.size() - 1), cnt_(4 * n_), len_(4 * n_),
          seg_(4 * n_), lbd_(4 * n_), rbd_(4 * n_) {}

    void add(std::int64_t y1, std::int64_t y2, std::int64_t delta) {
        auto lo = static_cast<std::size_t>(
            std::lower_bound(ys_.begin(), ys_.end(), y1) - ys_.begin());
        auto hi = static_cast<std::size_t>(
            std::lower_bound(ys_.begin(), ys_.end(), y2) - ys_.begin());
        update(1, 0, n_, lo, hi, delta);
    }

    std::int64_t coveredLength() const { return len_[1]; }
    std::int64_t coveredSegments() const { return seg_[1]; }

private:
    void update(std::size_t node, std::size_t l, std::size_t r,
                std::size_t ql, std::size_t qr, std::int64_t delta) {
        if (ql >= r || qr <= l) {
            return;
        }
        if (ql <= l && r <= qr) {
            cnt_[node] += delta;
        } else {
            std::size_t mid = l + (r - l) / 2;
            update(2 * node, l, mid, ql, qr, delta);
            update(2 * node + 1, mid, r, ql, qr, delta);
        }
        pull(node, l, r);
    }

    void pull(std::size_t node, std::size_t l, std::size_t r) {
        if (cnt_[node] > 0) {
            len_[node] = ys_[r] - ys_[l];
            seg_[node] = 1;
            lbd_[node] = rbd_[node] = 1;
            return;
        }
        if (r - l == 1) {
            len_[node] = seg_[node] = lbd_[node] = rbd_[node] = 0;
            return;
        }
        std::size_t lc = 2 * node, rc = 2 * node + 1;
        len_[node] = len_[lc] + len_[rc];
        seg_[node] = seg_[lc] + seg_[rc] - ((rbd_[lc] && lbd_[rc]) ? 1 : 0);
        lbd_[node] = lbd_[lc];
        rbd_[node] = rbd_[rc];
    }

    const std::vector<std::int64_t>& ys_;
    std::size_t n_;
    std::vector<std::int64_t> cnt_, len_, seg_, lbd_, rbd_;
};

struct Event {
    std::int64_t x, y1, y2, delta;
};

} // namespace

bool RectUnion::add(std::int64_t id, std::int64_t x1, std::int64_t y1,
                    std::int64_t x2, std::int64_t y2) {
    if (x1 > x2) std::swap(x1, x2);
    if (y1 > y2) std::swap(y1, y2);
    if (x1 == x2 || y1 == y2) {
        return false; // zero-area rectangles are ignored
    }
    if (!rects_.emplace(id, Rect{x1, y1, x2, y2}).second) {
        return false;
    }
    recompute();
    return true;
}

bool RectUnion::remove(std::int64_t id) {
    if (rects_.erase(id) == 0) {
        return false;
    }
    recompute();
    return true;
}

bool RectUnion::contains(std::int64_t id) const {
    return rects_.find(id) != rects_.end();
}

void RectUnion::recompute() {
    area_ = 0;
    perimeter_ = 0;
    if (rects_.empty()) {
        return;
    }

    std::vector<std::int64_t> ys;
    std::vector<Event> events;
    ys.reserve(2 * rects_.size());
    events.reserve(2 * rects_.size());
    for (const auto& [id, r] : rects_) {
        ys.push_back(r.y1);
        ys.push_back(r.y2);
        events.push_back({r.x1, r.y1, r.y2, +1});
        events.push_back({r.x2, r.y1, r.y2, -1});
    }
    std::sort(ys.begin(), ys.end());
    ys.erase(std::unique(ys.begin(), ys.end()), ys.end());
    // At the same x, entering events (+1) must be applied before leaving
    // events (-1): the covered set then grows monotonically to a peak and
    // shrinks monotonically, so the vertical boundary length contributed at
    // x is (peak - before) + (peak - after), which equals the length of the
    // symmetric difference of the covered y-sets on both sides of x.
    std::sort(events.begin(), events.end(),
              [](const Event& a, const Event& b) {
                  return a.x < b.x || (a.x == b.x && a.delta > b.delta);
              });

    CoverTree tree(ys);
    std::int64_t prev_x = events.front().x;
    std::size_t i = 0;
    while (i < events.size()) {
        std::int64_t x = events[i].x;
        std::int64_t dx = x - prev_x;
        // Slab [prev_x, x): area and the two horizontal edges per component.
        area_ += tree.coveredLength() * dx;
        perimeter_ += 2 * tree.coveredSegments() * dx;
        // Vertical edges appear where the covered y-set changes at x.
        std::int64_t before = tree.coveredLength();
        while (i < events.size() && events[i].x == x && events[i].delta > 0) {
            tree.add(events[i].y1, events[i].y2, events[i].delta);
            ++i;
        }
        std::int64_t peak = tree.coveredLength();
        while (i < events.size() && events[i].x == x) {
            tree.add(events[i].y1, events[i].y2, events[i].delta);
            ++i;
        }
        std::int64_t after = tree.coveredLength();
        perimeter_ += (peak - before) + (peak - after);
        prev_x = x;
    }
}

} // namespace geom
