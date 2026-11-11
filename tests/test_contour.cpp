#include "font/contour.hpp"

#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstdio>
#include <limits>
#include <vector>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

namespace {

int g_checks = 0;

bool nearlyEqual(double a, double b, double eps = 1e-12) {
    return std::abs(a - b) <= eps;
}

bool pointEqual(const font::Point& a, const font::Point& b,
                double eps = 1e-12) {
    return nearlyEqual(a.x, b.x, eps) && nearlyEqual(a.y, b.y, eps);
}

void mustFlatten(const std::vector<font::Point>& points,
                 const std::vector<bool>& onCurve,
                 const font::Affine& transform, double tolerance,
                 int maxDepth, std::vector<font::Segment>& segments) {
    font::FlattenResult result =
        font::flattenContour(points, onCurve, transform, tolerance, maxDepth,
                             segments);
    if (!result.ok()) {
        std::fprintf(stderr, "unexpected flatten error %d\n",
                     static_cast<int>(result.error));
        std::abort();
    }
}

double signedArea(const std::vector<font::Segment>& segments) {
    double area = 0.0;
    for (const auto& s : segments) {
        area += s.from.x * s.to.y - s.to.x * s.from.y;
    }
    return area * 0.5;
}

void checkClosedLoop(const std::vector<font::Segment>& segments) {
    assert(!segments.empty());
    for (std::size_t i = 0; i < segments.size(); ++i) {
        const auto& next = segments[(i + 1) % segments.size()];
        ++g_checks;
        assert(pointEqual(segments[i].to, next.from));
    }
}

// Compare two closed segment loops up to a cyclic shift, preserving direction.
bool sameLoopCyclic(const std::vector<font::Segment>& a,
                    const std::vector<font::Segment>& b,
                    double eps = 1e-10) {
    if (a.size() != b.size() || a.empty()) return false;
    for (std::size_t shift = 0; shift < b.size(); ++shift) {
        bool match = true;
        for (std::size_t i = 0; i < a.size(); ++i) {
            const auto& sa = a[i];
            const auto& sb = b[(i + shift) % b.size()];
            if (!pointEqual(sa.from, sb.from, eps) ||
                !pointEqual(sa.to, sb.to, eps)) {
                match = false;
                break;
            }
        }
        if (match) return true;
    }
    return false;
}

// Point-to-segment distance (finite segment, not the infinite line).
double pointSegmentDistance(const font::Point& p, const font::Point& a,
                            const font::Point& b) {
    const double vx = b.x - a.x;
    const double vy = b.y - a.y;
    const double len2 = vx * vx + vy * vy;
    if (len2 == 0.0) return std::hypot(p.x - a.x, p.y - a.y);
    double t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
    t = std::max(0.0, std::min(1.0, t));
    const double px = a.x + t * vx;
    const double py = a.y + t * vy;
    return std::hypot(p.x - px, p.y - py);
}

struct Quadratic {
    font::Point p0, p1, p2;
};

font::Point quadraticAt(const Quadratic& q, double t) {
    const double u = 1.0 - t;
    return font::Point{
        u * u * q.p0.x + 2.0 * u * t * q.p1.x + t * t * q.p2.x,
        u * u * q.p0.y + 2.0 * u * t * q.p1.y + t * t * q.p2.y};
}

// Rebuild the device-space quadratics the flattener was asked to subdivide:
// implicit midpoints are inserted between adjacent off-curve points first.
std::vector<Quadratic> buildDeviceQuadratics(
    const std::vector<font::Point>& points,
    const std::vector<bool>& onCurve, const font::Affine& transform) {
    const std::size_t n = points.size();
    std::vector<font::Point> dev(n);
    for (std::size_t i = 0; i < n; ++i) {
        dev[i] = font::apply(transform, points[i]);
    }
    std::vector<font::Point> effective;
    std::vector<bool> effectiveOn;
    for (std::size_t i = 0; i < n; ++i) {
        const std::size_t prev = (i == 0) ? n - 1 : i - 1;
        if (!onCurve[i] && !onCurve[prev]) {
            effective.push_back(
                font::Point{0.5 * (dev[prev].x + dev[i].x),
                            0.5 * (dev[prev].y + dev[i].y)});
            effectiveOn.push_back(true);
        }
        effective.push_back(dev[i]);
        effectiveOn.push_back(onCurve[i]);
    }
    std::vector<Quadratic> result;
    const std::size_t m = effective.size();
    std::size_t start = 0;
    while (!effectiveOn[start]) start = (start + 1) % m;
    for (std::size_t step = 0; step < m; ++step) {
        const std::size_t cur = (start + step) % m;
        const std::size_t next = (start + step + 1) % m;
        if (!effectiveOn[cur] && effectiveOn[next]) {
            const std::size_t prev = (cur == 0) ? m - 1 : cur - 1;
            result.push_back({effective[prev], effective[cur],
                              effective[next]});
        }
    }
    return result;
}

// 1. Pure off-curve contour: implicit on-curve midpoints are inserted,
// including the wrap-around end/start pair, and the loop stays closed.
void testPureOffCurve() {
    const std::vector<font::Point> points{
        {1.0, 0.0}, {0.0, 1.0}, {-1.0, 0.0}, {0.0, -1.0}};
    const std::vector<bool> onCurve{false, false, false, false};

    std::vector<font::Segment> segments;
    mustFlatten(points, onCurve, font::Affine::identity(), 0.01, 24,
                segments);
    checkClosedLoop(segments);

    // Every implicit midpoint (including last->first) must be a vertex.
    for (std::size_t i = 0; i < points.size(); ++i) {
        const auto& a = points[i];
        const auto& b = points[(i + 1) % points.size()];
        const font::Point mid{0.5 * (a.x + b.x), 0.5 * (a.y + b.y)};
        bool hit = false;
        for (const auto& s : segments) {
            if (pointEqual(s.from, mid)) {
                hit = true;
                break;
            }
        }
        ++g_checks;
        assert(hit);
    }

    // No original off-curve point may itself be emitted as a segment
    // endpoint (only midpoints and subdivision points on the curves).
    for (const auto& offPoint : points) {
        for (const auto& s : segments) {
            ++g_checks;
            assert(!pointEqual(s.from, offPoint));
        }
    }
}

// 2. Mirror transform: output equals explicitly mirrored geometry and the
// contour orientation flips with the negative determinant.
void testMirrorTransform() {
    const std::vector<font::Point> points{
        {0.0, 0.0}, {2.0, 0.0}, {2.0, 2.0}, {0.0, 2.0}};
    const std::vector<bool> onCurve{true, false, true, false};

    std::vector<font::Segment> identitySegments;
    mustFlatten(points, onCurve, font::Affine::identity(), 0.001, 24,
                identitySegments);

    const font::Affine mirror{1.0, 0.0, 0.0, -1.0, 0.0, 0.0};
    std::vector<font::Segment> mirroredSegments;
    mustFlatten(points, onCurve, mirror, 0.001, 24, mirroredSegments);
    checkClosedLoop(mirroredSegments);

    ++g_checks;
    assert(identitySegments.size() == mirroredSegments.size());
    for (std::size_t i = 0; i < identitySegments.size(); ++i) {
        const auto& a = identitySegments[i];
        const auto& b = mirroredSegments[i];
        ++g_checks;
        assert(nearlyEqual(a.from.x, b.from.x));
        assert(nearlyEqual(a.from.y, -b.from.y));
        assert(nearlyEqual(a.to.x, b.to.x));
        assert(nearlyEqual(a.to.y, -b.to.y));
    }

    ++g_checks;
    assert(signedArea(identitySegments) * signedArea(mirroredSegments) < 0.0);

    // General affine (mixing + translation): with subdivision disabled
    // (maxDepth 0 on a tolerant curve) both runs emit the same chord
    // topology, so every device vertex must equal the transformed font-space
    // vertex point-by-point.
    const font::Affine mixed{2.0, 0.5, -0.5, 1.5, 10.0, -4.0};
    const std::vector<font::Point> chordPoints{
        {0.0, 0.0}, {2.0, 2.0}, {0.0, 2.0}};
    const std::vector<bool> chordOn{true, true, true};

    std::vector<font::Segment> plainChord;
    mustFlatten(chordPoints, chordOn, font::Affine::identity(), 0.001, 0,
                plainChord);
    std::vector<font::Segment> mixedSegments;
    mustFlatten(chordPoints, chordOn, mixed, 0.001, 0, mixedSegments);
    checkClosedLoop(mixedSegments);
    ++g_checks;
    assert(plainChord.size() == mixedSegments.size());
    for (std::size_t i = 0; i < plainChord.size(); ++i) {
        const auto expectedFrom =
            font::apply(mixed, plainChord[i].from);
        const auto expectedTo = font::apply(mixed, plainChord[i].to);
        ++g_checks;
        assert(pointEqual(expectedFrom, mixedSegments[i].from, 1e-10));
        assert(pointEqual(expectedTo, mixedSegments[i].to, 1e-10));
    }

    // The original mixed-flattening run on quadratic input still closes and
    // stays finite.
    std::vector<font::Segment> mixedQuadratic;
    mustFlatten(points, onCurve, mixed, 0.001, 24, mixedQuadratic);
    checkClosedLoop(mixedQuadratic);
    for (const auto& s : mixedQuadratic) {
        ++g_checks;
        assert(std::isfinite(s.from.x) && std::isfinite(s.from.y));
        assert(std::isfinite(s.to.x) && std::isfinite(s.to.y));
    }
}

// 3. Extremely flat curves: collinear control points need no subdivision,
// near-flat curves converge, and a squashed contour still closes.
void testExtremelyFlatCurves() {
    const std::vector<bool> onCurve{true, false, true};

    // Perfectly collinear quadratic: control point lies on the chord.
    const std::vector<font::Point> flatPoints{
        {0.0, 0.0}, {5.0, 0.0}, {10.0, 0.0}};
    std::vector<font::Segment> flatSegments;
    mustFlatten(flatPoints, onCurve, font::Affine::identity(), 0.001, 24,
                flatSegments);
    // One chord plus the closing segment back to the start.
    ++g_checks;
    assert(flatSegments.size() == 2);
    ++g_checks;
    assert(pointEqual(flatSegments[0].from, font::Point{0.0, 0.0}));
    ++g_checks;
    assert(pointEqual(flatSegments[0].to, font::Point{10.0, 0.0}));

    // Near-flat curve inside tolerance: still a single chord.
    const std::vector<font::Point> nearFlatPoints{
        {0.0, 0.0}, {5.0, 1e-6}, {10.0, 0.0}};
    std::vector<font::Segment> nearFlatSegments;
    mustFlatten(nearFlatPoints, onCurve, font::Affine::identity(), 0.01, 24,
                nearFlatSegments);
    ++g_checks;
    assert(nearFlatSegments.size() == 2);

    // Same curve under a tight tolerance must subdivide yet stay closed.
    std::vector<font::Segment> tightSegments;
    mustFlatten(nearFlatPoints, onCurve, font::Affine::identity(), 1e-9, 24,
                tightSegments);
    checkClosedLoop(tightSegments);
    ++g_checks;
    assert(tightSegments.size() > 2);

    // Squashed closed contour: height is five orders of magnitude below
    // width, built entirely from off-curve points.
    std::vector<font::Point> squashed;
    std::vector<bool> squashedOn;
    for (int k = 0; k < 8; ++k) {
        const double angle = 2.0 * M_PI * k / 8.0;
        squashed.push_back(
            {100.0 * std::cos(angle), 0.01 * std::sin(angle)});
        squashedOn.push_back(false);
    }
    std::vector<font::Segment> squashedSegments;
    mustFlatten(squashed, squashedOn, font::Affine::identity(), 0.001, 32,
                squashedSegments);
    checkClosedLoop(squashedSegments);
    for (const auto& s : squashedSegments) {
        ++g_checks;
        assert(std::abs(s.from.y) <= 0.02);
        assert(std::abs(s.to.y) <= 0.02);
        assert(std::isfinite(s.from.x) && std::isfinite(s.to.x));
    }
}

// 4. Cyclic shifts of the same contour produce the same directed geometry.
void testCyclicShiftInvariance() {
    const std::vector<font::Point> points{
        {0.0, 0.0}, {2.0, 0.0}, {2.0, 2.0}, {1.0, 3.0}, {0.0, 2.0}};
    const std::vector<bool> onCurve{true, false, true, false, true};

    std::vector<font::Segment> reference;
    mustFlatten(points, onCurve, font::Affine::identity(), 0.001, 24,
                reference);

    for (std::size_t shift = 1; shift < points.size(); ++shift) {
        std::vector<font::Point> shiftedPoints;
        std::vector<bool> shiftedOn;
        for (std::size_t i = 0; i < points.size(); ++i) {
            shiftedPoints.push_back(points[(i + shift) % points.size()]);
            shiftedOn.push_back(onCurve[(i + shift) % points.size()]);
        }
        std::vector<font::Segment> shiftedSegments;
        mustFlatten(shiftedPoints, shiftedOn, font::Affine::identity(),
                    0.001, 24, shiftedSegments);
        ++g_checks;
        assert(sameLoopCyclic(reference, shiftedSegments));
    }

    // Invariance also holds for a pure off-curve contour, which has no
    // caller-defined starting vertex.
    const std::vector<font::Point> allOff{
        {1.0, 0.0}, {0.0, 1.0}, {-1.0, 0.0}, {0.0, -1.0}};
    const std::vector<bool> allOffOn{false, false, false, false};

    std::vector<font::Segment> offReference;
    mustFlatten(allOff, allOffOn, font::Affine::identity(), 0.01, 24,
                offReference);

    for (std::size_t shift = 1; shift < allOff.size(); ++shift) {
        std::vector<font::Point> shiftedPoints;
        std::vector<bool> shiftedOn;
        for (std::size_t i = 0; i < allOff.size(); ++i) {
            shiftedPoints.push_back(allOff[(i + shift) % allOff.size()]);
            shiftedOn.push_back(allOffOn[(i + shift) % allOffOn.size()]);
        }
        std::vector<font::Segment> shiftedSegments;
        mustFlatten(shiftedPoints, shiftedOn, font::Affine::identity(),
                    0.01, 24, shiftedSegments);
        ++g_checks;
        assert(sameLoopCyclic(offReference, shiftedSegments));
    }
}

// Reaching the subdivision depth limit while still out of tolerance is an
// explicit failure: the output vector is cleared, never a half glyph.
void testDepthLimitFailure() {
    const std::vector<font::Point> points{
        {0.0, 0.0}, {5.0, 10.0}, {10.0, 0.0}};
    const std::vector<bool> onCurve{true, false, true};

    std::vector<font::Segment> segments;
    segments.push_back({{1.0, 1.0}, {2.0, 2.0}});  // stale content

    font::FlattenResult result = font::flattenContour(
        points, onCurve, font::Affine::identity(), 1e-12, 0, segments);
    ++g_checks;
    assert(result.error == font::FlattenError::kDepthLimitExceeded);
    ++g_checks;
    assert(segments.empty());

    // A generous depth limit on the same curve succeeds and closes.
    result = font::flattenContour(points, onCurve, font::Affine::identity(),
                                  1e-12, 40, segments);
    ++g_checks;
    assert(result.ok());
    checkClosedLoop(segments);
}

// Numeric guarantee: densely sampled points of every device-space quadratic
// stay within the requested tolerance of the emitted directed segments.
void testDeviceSpaceToleranceGuarantee() {
    const std::vector<font::Point> points{
        {0.0, 0.0},   {4.0, 6.0},  {8.0, 0.0},  {9.0, -3.0},
        {6.0, -6.0},  {1.0, -7.0}, {-2.0, -3.0}};
    const std::vector<bool> onCurve{true,  false, true,  false,
                                    false, false, true};

    const double tolerance = 0.05;
    std::vector<font::Segment> segments;
    mustFlatten(points, onCurve, font::Affine::identity(), tolerance, 32,
                segments);
    checkClosedLoop(segments);

    const auto quadratics =
        buildDeviceQuadratics(points, onCurve, font::Affine::identity());
    ++g_checks;
    assert(!quadratics.empty());

    for (const auto& q : quadratics) {
        for (int sample = 0; sample <= 200; ++sample) {
            const double t = sample / 200.0;
            const font::Point curvePoint = quadraticAt(q, t);
            double nearest = std::numeric_limits<double>::infinity();
            for (const auto& s : segments) {
                nearest = std::min(
                    nearest, pointSegmentDistance(curvePoint, s.from, s.to));
            }
            ++g_checks;
            assert(nearest <= tolerance * (1.0 + 1e-9));
        }
    }

    // Same guarantee under a mirror plus scale transform.
    const font::Affine mirrorScale{3.0, 0.0, 0.0, -2.0, 5.0, 7.0};
    std::vector<font::Segment> scaledSegments;
    mustFlatten(points, onCurve, mirrorScale, tolerance, 32, scaledSegments);
    checkClosedLoop(scaledSegments);

    const auto scaledQuadratics =
        buildDeviceQuadratics(points, onCurve, mirrorScale);
    for (const auto& q : scaledQuadratics) {
        for (int sample = 0; sample <= 100; ++sample) {
            const font::Point curvePoint =
                quadraticAt(q, sample / 100.0);
            double nearest = std::numeric_limits<double>::infinity();
            for (const auto& s : scaledSegments) {
                nearest = std::min(
                    nearest, pointSegmentDistance(curvePoint, s.from, s.to));
            }
            ++g_checks;
            assert(nearest <= tolerance * (1.0 + 1e-9));
        }
    }
}

// Invalid inputs are rejected rather than producing garbage.
void testInvalidInputs() {
    std::vector<font::Segment> segments;
    const std::vector<font::Point> points{{0.0, 0.0}, {1.0, 1.0}};
    const std::vector<bool> onCurve{true, true};

    ++g_checks;
    assert(font::flattenContour(points, onCurve, font::Affine::identity(),
                                0.0, 24, segments)
               .error == font::FlattenError::kInvalidTolerance);
    ++g_checks;
    assert(segments.empty());

    ++g_checks;
    assert(font::flattenContour(points, onCurve, font::Affine::identity(),
                                0.01, -1, segments)
               .error == font::FlattenError::kInvalidMaxDepth);

    ++g_checks;
    assert(font::flattenContour({}, {}, font::Affine::identity(), 0.01, 24,
                                segments)
               .error == font::FlattenError::kEmptyContour);

    const std::vector<bool> mismatched{true};
    ++g_checks;
    assert(font::flattenContour(points, mismatched,
                                font::Affine::identity(), 0.01, 24, segments)
               .error == font::FlattenError::kEmptyContour);

    // Duplicated on-curve points create zero-length links: the output skips
    // them but still forms a single closed loop.
    const std::vector<font::Point> duplicated{
        {0.0, 0.0}, {0.0, 0.0}, {3.0, 0.0}, {3.0, 3.0}, {0.0, 3.0}};
    const std::vector<bool> duplicatedOn{true, true, true, true, true};
    mustFlatten(duplicated, duplicatedOn, font::Affine::identity(), 0.01,
                24, segments);
    checkClosedLoop(segments);
    for (const auto& s : segments) {
        ++g_checks;
        assert(!pointEqual(s.from, s.to));
    }
}

}  // namespace

int main() {
    testPureOffCurve();
    testMirrorTransform();
    testExtremelyFlatCurves();
    testCyclicShiftInvariance();
    testDepthLimitFailure();
    testDeviceSpaceToleranceGuarantee();
    testInvalidInputs();
    std::printf("all contour tests passed (%d checks)\n", g_checks);
    return 0;
}
