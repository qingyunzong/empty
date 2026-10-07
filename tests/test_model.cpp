// Randomized cross-validation against brute-force models:
//  - skyline vs endpoint-segment full scan model
//  - topSegments vs per-segment scan
//  - diffSources vs per-endpoint model over both states
#include "skyline/skyline.hpp"
#include "check.hpp"

#include <algorithm>
#include <random>
#include <set>
#include <vector>

using namespace skyline;

namespace {

// Reference model: expand every endpoint, scan all rects per elementary
// segment, then merge adjacent equal (height) / (height, sources) runs.
struct Model {
    std::vector<Rect> rects; // active rects (non-empty only)

    std::vector<Coord> endpoints(Coord ql, Coord qr) const {
        std::set<Coord> xs{ql, qr};
        for (const Rect& r : rects) {
            Coord lo = std::max(r.left, ql), hi = std::min(r.right, qr);
            if (lo < hi) {
                xs.insert(lo);
                xs.insert(hi);
            }
        }
        return {xs.begin(), xs.end()};
    }

    void scan(Coord a, Coord b, Height& h, std::vector<RectId>& ids) const {
        h = 0;
        ids.clear();
        for (const Rect& r : rects) {
            if (r.left > a || r.right < b) continue;
            if (r.height > h) {
                h = r.height;
                ids.assign(1, r.id);
            } else if (r.height == h) {
                ids.push_back(r.id);
            }
        }
        std::sort(ids.begin(), ids.end());
    }

    std::vector<ChangePoint> skylineModel() const {
        if (rects.empty()) return {};
        Coord lo = rects[0].left, hi = rects[0].right;
        for (const Rect& r : rects) {
            lo = std::min(lo, r.left);
            hi = std::max(hi, r.right);
        }
        std::vector<Coord> xs = endpoints(lo, hi);
        std::vector<ChangePoint> out;
        Height cur = 0;
        for (std::size_t i = 0; i + 1 < xs.size(); ++i) {
            Height h;
            std::vector<RectId> ids;
            scan(xs[i], xs[i + 1], h, ids);
            if (h != cur) {
                out.push_back({xs[i], h});
                cur = h;
            }
        }
        if (cur != 0) out.push_back({hi, 0});
        return out;
    }

    std::vector<Segment> topModel(Coord ql, Coord qr) const {
        std::vector<Coord> xs = endpoints(ql, qr);
        std::vector<Segment> out;
        for (std::size_t i = 0; i + 1 < xs.size(); ++i) {
            Height h;
            std::vector<RectId> ids;
            scan(xs[i], xs[i + 1], h, ids);
            if (!out.empty() && out.back().height == h && out.back().sources == ids) {
                out.back().right = xs[i + 1];
            } else {
                out.push_back({xs[i], xs[i + 1], h, ids});
            }
        }
        return out;
    }
};

} // namespace

int main() {
    std::mt19937_64 rng(20261007);
    std::uniform_int_distribution<Coord> coordDist(-60, 60);
    std::uniform_int_distribution<Height> heightDist(0, 12); // 0 -> empty rect
    std::uniform_int_distribution<int> opDist(0, 2);

    for (int iter = 0; iter < 400; ++iter) {
        Skyline s;
        std::vector<Rect> active; // brute-force ground truth (non-empty)
        std::vector<Skyline::Snapshot> snaps;
        std::vector<std::vector<Rect>> snapStates;
        RectId nextId = 1;

        for (int step = 0; step < 30; ++step) {
            int op = opDist(rng);
            if (op <= 1 || active.empty()) {
                Coord a = coordDist(rng), b = coordDist(rng);
                if (a > b) std::swap(a, b);
                Rect r{nextId++, a, b, heightDist(rng)};
                s.add(r);
                if (!r.empty()) {
                    active.erase(std::remove_if(active.begin(), active.end(),
                                                [&](const Rect& e) { return e.id == r.id; }),
                                 active.end());
                    active.push_back(r);
                }
            } else {
                std::uniform_int_distribution<std::size_t> pick(0, active.size() - 1);
                RectId victim = active[pick(rng)].id;
                s.remove(victim);
                active.erase(std::remove_if(active.begin(), active.end(),
                                            [&](const Rect& e) { return e.id == victim; }),
                             active.end());
            }
            snaps.push_back(s.snapshot());
            snapStates.push_back(active);

            // 1) Skyline vs endpoint-segment full scan model.
            Model m{active};
            CHECK_EQ(s.skyline(), m.skylineModel());

            // 2) topSegments vs per-segment scan on a random query window.
            Coord qa = coordDist(rng), qb = coordDist(rng);
            if (qa > qb) std::swap(qa, qb);
            if (qa < qb) CHECK_EQ(s.topSegments(qa, qb), m.topModel(qa, qb));
        }

        // 3) diffSources vs per-endpoint model over pairs of snapshots.
        for (int k = 0; k < 10; ++k) {
            std::uniform_int_distribution<std::size_t> pick(0, snaps.size() - 1);
            std::size_t i = pick(rng), j = pick(rng);
            Model oldM{snapStates[i]}, newM{snapStates[j]};
            std::set<Coord> pointSet;
            for (const Rect& r : oldM.rects) {
                pointSet.insert(r.left);
                pointSet.insert(r.right);
            }
            for (const Rect& r : newM.rects) {
                pointSet.insert(r.left);
                pointSet.insert(r.right);
            }
            std::vector<Coord> xs(pointSet.begin(), pointSet.end());
            std::vector<SourceChange> want;
            for (std::size_t t = 0; t + 1 < xs.size(); ++t) {
                Height oh, nh;
                std::vector<RectId> oi, ni;
                oldM.scan(xs[t], xs[t + 1], oh, oi);
                newM.scan(xs[t], xs[t + 1], nh, ni);
                if (oh == nh && oi == ni) continue;
                if (!want.empty() && want.back().right == xs[t] &&
                    want.back().oldHeight == oh && want.back().newHeight == nh &&
                    want.back().oldSources == oi && want.back().newSources == ni) {
                    want.back().right = xs[t + 1];
                } else {
                    want.push_back({xs[t], xs[t + 1], oh, nh, oi, ni});
                }
            }
            CHECK_EQ(Skyline::diffSources(snaps[i], snaps[j]), want);
            // Snapshot skyline must equal the model of its recorded state.
            CHECK_EQ(s.skyline(snaps[i]), oldM.skylineModel());
        }
    }

    return 0;
}
