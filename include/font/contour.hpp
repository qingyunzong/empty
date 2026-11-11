#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <vector>

namespace font {

struct Point {
    double x = 0.0;
    double y = 0.0;
};

// Affine transform in TrueType convention:
//   x' = xx * x + xy * y + tx
//   y' = yx * x + yy * y + ty
struct Affine {
    double xx = 1.0, xy = 0.0;
    double yx = 0.0, yy = 1.0;
    double tx = 0.0, ty = 0.0;

    static Affine identity() { return Affine{}; }
};

inline Point apply(const Affine& t, const Point& p) {
    return Point{t.xx * p.x + t.xy * p.y + t.tx,
                 t.yx * p.x + t.yy * p.y + t.ty};
}

// A directed segment in device space, handed to the rasterizer/filler.
struct Segment {
    Point from;
    Point to;
};

enum class FlattenError {
    kNone,
    kEmptyContour,
    kInvalidTolerance,
    kInvalidMaxDepth,
    // Reached the subdivision depth limit while still exceeding the
    // device-space flatness tolerance. No partial output is produced.
    kDepthLimitExceeded,
};

struct FlattenResult {
    FlattenError error = FlattenError::kNone;
    std::size_t failingSegmentIndex = 0;
    int failingDepth = 0;

    bool ok() const { return error == FlattenError::kNone; }
};

namespace detail {

struct InputPoint {
    Point position;
    bool onCurve;
};

inline Point midpoint(const Point& a, const Point& b) {
    return Point{(a.x + b.x) * 0.5, (a.y + b.y) * 0.5};
}

// Perpendicular distance of p to the infinite line through a and b.
// The distance to the (finite) chord is never larger than this value, so a
// curve passing this check is within tolerance of the chord as a whole.
inline double chordDeviation(const Point& a, const Point& b, const Point& p) {
    const double vx = b.x - a.x;
    const double vy = b.y - a.y;
    const double wx = p.x - a.x;
    const double wy = p.y - a.y;
    const double cross = vx * wy - vy * wx;
    const double len2 = vx * vx + vy * vy;
    if (len2 <= std::numeric_limits<double>::min()) {
        // Degenerate chord: fall back to the distance from the control point.
        return std::sqrt(wx * wx + wy * wy);
    }
    return std::abs(cross) / std::sqrt(len2);
}

}  // namespace detail

// Flatten one closed TrueType contour into directed device-space segments.
//
// Pipeline:
//   1. Apply `transform` to every input point (in font space).
//   2. Insert implicit on-curve midpoints between adjacent off-curve points,
//      including the wrap-around pair (TrueType convention).
//   3. Adaptively subdivide each quadratic curve until its maximum device
//      space deviation from its chord is <= `tolerance`.
//
// On failure the function returns an error and leaves `outSegments` empty, so
// callers never receive half of a glyph. `maxDepth` bounds recursion per
// quadratic segment (0 means only the original chord is allowed).
inline FlattenResult flattenContour(const std::vector<Point>& points,
                                    const std::vector<bool>& onCurve,
                                    const Affine& transform,
                                    double tolerance,
                                    int maxDepth,
                                    std::vector<Segment>& outSegments) {
    FlattenResult result;
    outSegments.clear();

    if (tolerance <= 0.0) {
        result.error = FlattenError::kInvalidTolerance;
        return result;
    }
    if (maxDepth < 0) {
        result.error = FlattenError::kInvalidMaxDepth;
        return result;
    }
    if (points.empty() || onCurve.size() != points.size()) {
        result.error = FlattenError::kEmptyContour;
        return result;
    }

    const std::size_t count = points.size();
    std::vector<detail::InputPoint> expanded;
    expanded.reserve(count * 2);

    // Expand in device space: implicit midpoints are inserted between
    // adjacent off-curve points, also across the end/start boundary.
    for (std::size_t i = 0; i < count; ++i) {
        const std::size_t prev = (i == 0) ? count - 1 : i - 1;
        if (!onCurve[i] && !onCurve[prev]) {
            expanded.push_back(
                {detail::midpoint(apply(transform, points[prev]),
                                  apply(transform, points[i])),
                 true});
        }
        expanded.push_back({apply(transform, points[i]), onCurve[i]});
    }

    const std::size_t expandedCount = expanded.size();
    if (expandedCount < 2) {
        result.error = FlattenError::kEmptyContour;
        return result;
    }

    std::vector<Point> polyline;
    polyline.reserve(expandedCount * 2);

    const auto startIt =
        std::find_if(expanded.begin(), expanded.end(),
                     [](const detail::InputPoint& p) { return p.onCurve; });
    if (startIt == expanded.end()) {
        // Unreachable: expansion always inserts on-curve midpoints when
        // off-curve points are adjacent; kept as an explicit guard.
        result.error = FlattenError::kEmptyContour;
        return result;
    }
    const std::size_t start =
        static_cast<std::size_t>(startIt - expanded.begin());

    polyline.push_back(expanded[start].position);

    for (std::size_t step = 0; step < expandedCount; ++step) {
        const detail::InputPoint& cur =
            expanded[(start + step) % expandedCount];
        const detail::InputPoint& next =
            expanded[(start + step + 1) % expandedCount];

        if (cur.onCurve && next.onCurve) {
            polyline.push_back(next.position);
        } else if (!cur.onCurve && next.onCurve) {
            // Quadratic: previous polyline point is the on-curve start,
            // cur is the control point and next is the on-curve end.
            const Point p0 = polyline.back();
            const Point& p1 = cur.position;
            const Point& p2 = next.position;

            bool failed = false;
            const auto subdivide = [&](const Point& a, const Point& c,
                                       const Point& b, int depth,
                                       auto&& self) -> void {
                if (detail::chordDeviation(a, b, c) <= tolerance) {
                    polyline.push_back(b);
                    return;
                }
                if (depth >= maxDepth) {
                    result.error = FlattenError::kDepthLimitExceeded;
                    result.failingDepth = depth;
                    failed = true;
                    return;
                }
                const Point ac = detail::midpoint(a, c);
                const Point cb = detail::midpoint(c, b);
                const Point mid = detail::midpoint(ac, cb);
                self(a, ac, mid, depth + 1, self);
                if (failed) return;
                self(mid, cb, b, depth + 1, self);
            };

            subdivide(p0, p1, p2, 0, subdivide);
            if (failed) {
                outSegments.clear();
                result.failingSegmentIndex = step;
                return result;
            }
        }
        // After expansion two off-curve points can never be adjacent, so no
        // other edge type exists.
    }

    // The final point must coincide with the start (closed contour). Drop a
    // duplicated closing copy and emit a single directed closing segment.
    if (polyline.size() >= 2) {
        Point first = polyline.front();
        Point last = polyline.back();
        if (first.x == last.x && first.y == last.y) {
            polyline.pop_back();
        }
    }

    if (polyline.size() < 2) {
        result.error = FlattenError::kEmptyContour;
        return result;
    }

    outSegments.reserve(polyline.size());
    for (std::size_t i = 0; i < polyline.size(); ++i) {
        const Point& from = polyline[i];
        const Point& to = polyline[(i + 1) % polyline.size()];
        // Skip zero-length degenerate links while preserving the cycle.
        if (from.x != to.x || from.y != to.y) {
            outSegments.push_back({from, to});
        }
    }

    return result;
}

}  // namespace font
