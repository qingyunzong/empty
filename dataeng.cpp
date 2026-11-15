#include "dataeng.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <string>
#include <utility>
#include <vector>

namespace dataeng {
namespace {

constexpr long double kParamEpsilon = 1.0e-18L;
constexpr long double kAreaEpsilon = 1.0e-15L;
constexpr long double kDuplicateTolerance = 1.0e-12L;

[[nodiscard]] bool finite_point(const Point& point) noexcept {
  return std::isfinite(point.x) && std::isfinite(point.y);
}

[[nodiscard]] long double orient_value(const Point& a, const Point& b,
                                       const Point& c) noexcept {
  if (a.exact_integer && b.exact_integer && c.exact_integer) {
    const __int128 abx = static_cast<__int128>(b.ix) - a.ix;
    const __int128 aby = static_cast<__int128>(b.iy) - a.iy;
    const __int128 acx = static_cast<__int128>(c.ix) - a.ix;
    const __int128 acy = static_cast<__int128>(c.iy) - a.iy;
    const __int128 det = abx * acy - aby * acx;
    if (det > 0) {
      return 1.0L;
    }
    if (det < 0) {
      return -1.0L;
    }
    return 0.0L;
  }
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

[[nodiscard]] bool same_coordinate(long double a, long double b) noexcept {
  if (a == b) {
    return true;
  }
  const long double scale = std::max({1.0L, std::fabs(a), std::fabs(b)});
  return std::fabs(a - b) <= kDuplicateTolerance * scale;
}

[[nodiscard]] bool same_point(const Point& a, const Point& b) noexcept {
  if (a.exact_integer && b.exact_integer) {
    return a.ix == b.ix && a.iy == b.iy;
  }
  return same_coordinate(a.x, b.x) && same_coordinate(a.y, b.y);
}

[[nodiscard]] Point interpolate(const Point& a, const Point& b,
                                long double t) noexcept {
  return Point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
}

[[nodiscard]] std::vector<Point> closed_ring_points(const Ring& ring) {
  std::vector<Point> points = ring.points;
  if (points.size() > 1 && same_point(points.front(), points.back())) {
    points.pop_back();
  }
  return points;
}

struct RingInfo {
  std::vector<Point> points;
  // points.size() entries.  Each entry is the corresponding edge index in the
  // caller's input ring (a repeated closing vertex is removed).
  std::vector<std::size_t> edge_index;
  bool repeated_vertex = false;
  bool invalid_coordinate = false;
};

[[nodiscard]] RingInfo make_ring_info(const Ring& ring) {
  RingInfo info;
  info.points = closed_ring_points(ring);
  info.edge_index.resize(info.points.size());
  for (std::size_t i = 0; i < info.edge_index.size(); ++i) {
    info.edge_index[i] = i;
  }
  for (const Point& point : info.points) {
    if (!finite_point(point)) {
      info.invalid_coordinate = true;
      break;
    }
  }
  if (info.points.size() > 1) {
    for (std::size_t i = 0; i < info.points.size(); ++i) {
      const std::size_t next = (i + 1) % info.points.size();
      if (same_point(info.points[i], info.points[next])) {
        info.repeated_vertex = true;
        break;
      }
    }
  }
  return info;
}

[[nodiscard]] RingRole role_of_ring(std::size_t ring_id) noexcept {
  return ring_id == 0 ? RingRole::Shell : RingRole::Hole;
}

[[nodiscard]] std::vector<RingInfo> make_ring_infos(const Polygon& polygon) {
  std::vector<RingInfo> infos;
  infos.reserve(polygon.holes.size() + 1);
  infos.push_back(make_ring_info(polygon.shell));
  for (const Ring& hole : polygon.holes) {
    infos.push_back(make_ring_info(hole));
  }
  return infos;
}

[[nodiscard]] long double signed_area_points(
    const std::vector<Point>& points) noexcept {
  if (points.size() < 3) {
    return 0.0L;
  }
  bool exact = true;
  for (const Point& point : points) {
    if (!point.exact_integer) {
      exact = false;
      break;
    }
  }
  if (exact) {
    __int128 twice_area = 0;
    for (std::size_t i = 0; i < points.size(); ++i) {
      const Point& a = points[i];
      const Point& b = points[(i + 1) % points.size()];
      twice_area += static_cast<__int128>(a.ix) * b.iy -
                    static_cast<__int128>(a.iy) * b.ix;
    }
    return static_cast<long double>(twice_area) * 0.5L;
  }
  long double twice_area = 0.0L;
  for (std::size_t i = 0; i < points.size(); ++i) {
    const Point& a = points[i];
    const Point& b = points[(i + 1) % points.size()];
    twice_area += a.x * b.y - a.y * b.x;
  }
  return twice_area * 0.5L;
}

void add_issue(ValidationReport& report, Issue issue) {
  if (issue.severity == Severity::Error) {
    ++report.error_count;
  } else {
    ++report.warning_count;
  }
  report.issues.push_back(std::move(issue));
}

[[nodiscard]] std::string edge_label(std::size_t ring_id,
                                     std::size_t edge) {
  if (ring_id == kNoIndex || edge == kNoIndex) {
    return "<none>";
  }
  return "ring " + std::to_string(ring_id) + " edge " +
         std::to_string(edge);
}

struct BoundaryStats {
  bool cross = false;
  bool overlap = false;
  bool touch = false;
  Point point;
  std::size_t edge_a = kNoIndex;
  std::size_t edge_b = kNoIndex;
};

[[nodiscard]] BoundaryStats boundary_stats(const RingInfo& a,
                                           const RingInfo& b) {
  BoundaryStats stats;
  if (a.points.size() < 2 || b.points.size() < 2) {
    return stats;
  }
  for (std::size_t i = 0; i < a.points.size(); ++i) {
    const Point& a0 = a.points[i];
    const Point& a1 = a.points[(i + 1) % a.points.size()];
    if (same_point(a0, a1)) {
      continue;
    }
    for (std::size_t j = 0; j < b.points.size(); ++j) {
      const Point& b0 = b.points[j];
      const Point& b1 = b.points[(j + 1) % b.points.size()];
      if (same_point(b0, b1)) {
        continue;
      }
      const SegmentIntersection hit =
          segment_intersection(a0, a1, b0, b1);
      if (hit.relation == SegmentRelation::Disjoint) {
        continue;
      }
      if (hit.relation == SegmentRelation::Cross) {
        stats.cross = true;
        stats.point = hit.point;
        stats.edge_a = a.edge_index[i];
        stats.edge_b = b.edge_index[j];
        return stats;
      }
      if (hit.relation == SegmentRelation::Overlap) {
        stats.overlap = true;
        stats.point = hit.point;
        stats.edge_a = a.edge_index[i];
        stats.edge_b = b.edge_index[j];
        return stats;
      }
      if (!stats.touch) {
        stats.touch = true;
        stats.point = hit.point;
        stats.edge_a = a.edge_index[i];
        stats.edge_b = b.edge_index[j];
      }
    }
  }
  return stats;
}

[[nodiscard]] bool same_cycle_oriented(const std::vector<Point>& a,
                                       const std::vector<Point>& b) {
  if (a.size() != b.size() || a.empty()) {
    return false;
  }
  const std::size_t n = a.size();
  for (std::size_t shift = 0; shift < n; ++shift) {
    bool equal = true;
    for (std::size_t k = 0; k < n; ++k) {
      if (!same_point(a[(shift + k) % n], b[k])) {
        equal = false;
        break;
      }
    }
    if (equal) {
      return true;
    }
  }
  return false;
}

[[nodiscard]] bool same_cycle(const std::vector<Point>& a,
                              const std::vector<Point>& b,
                              bool* reversed = nullptr) {
  if (same_cycle_oriented(a, b)) {
    if (reversed != nullptr) {
      *reversed = false;
    }
    return true;
  }
  std::vector<Point> reversed_b(b.rbegin(), b.rend());
  if (same_cycle_oriented(a, reversed_b)) {
    if (reversed != nullptr) {
      *reversed = true;
    }
    return true;
  }
  return false;
}

void check_ring_self_intersections(const RingInfo& info, std::size_t ring_id,
                                   const ValidationOptions& options,
                                   ValidationReport& report) {
  const std::size_t count = info.points.size();
  if (count < 4) {
    return;
  }
  for (std::size_t i = 0; i < count; ++i) {
    const Point& a0 = info.points[i];
    const Point& a1 = info.points[(i + 1) % count];
    if (same_point(a0, a1)) {
      continue;
    }
    for (std::size_t j = i + 1; j < count; ++j) {
      if (j == i) {
        continue;
      }
      const Point& b0 = info.points[j];
      const Point& b1 = info.points[(j + 1) % count];
      if (same_point(b0, b1)) {
        continue;
      }
      const bool adjacent =
          (j == i + 1) || (i == 0 && j + 1 == count);
      const SegmentIntersection hit =
          segment_intersection(a0, a1, b0, b1);
      if (hit.relation == SegmentRelation::Disjoint) {
        continue;
      }
      if (adjacent) {
        // Consecutive edges legitimately share one endpoint.  Only an
        // overlap (a spike doubling back on itself) is invalid.
        if (hit.relation == SegmentRelation::Overlap) {
          Issue issue;
          issue.kind = IssueKind::SelfIntersection;
          issue.severity = Severity::Error;
          issue.message =
              "adjacent edges overlap (spike) in " +
              edge_label(ring_id, info.edge_index[i]) + " and " +
              edge_label(ring_id, info.edge_index[j]);
          issue.ring_a = ring_id;
          issue.edge_a = EdgeRef{ring_id, info.edge_index[i]};
          issue.edge_b = EdgeRef{ring_id, info.edge_index[j]};
          issue.location = hit.point;
          add_issue(report, std::move(issue));
        }
        continue;
      }
      if (hit.relation == SegmentRelation::Cross ||
          hit.relation == SegmentRelation::Overlap) {
        Issue issue;
        issue.kind = IssueKind::SelfIntersection;
        issue.severity = Severity::Error;
        issue.message =
            std::string(hit.relation == SegmentRelation::Cross
                            ? "self-crossing"
                            : "overlapping non-adjacent edges") +
            " in " + edge_label(ring_id, info.edge_index[i]) + " and " +
            edge_label(ring_id, info.edge_index[j]);
        issue.ring_a = ring_id;
        issue.edge_a = EdgeRef{ring_id, info.edge_index[i]};
        issue.edge_b = EdgeRef{ring_id, info.edge_index[j]};
        issue.location = hit.point;
        add_issue(report, std::move(issue));
      } else if (hit.relation == SegmentRelation::Touch) {
        Issue issue;
        issue.kind = IssueKind::RingSelfTouch;
        issue.severity =
            options.strict_touching ? Severity::Error : Severity::Warning;
        issue.message =
            "ring touches itself at a non-adjacent vertex/edge in " +
            edge_label(ring_id, info.edge_index[i]) + " and " +
            edge_label(ring_id, info.edge_index[j]);
        issue.ring_a = ring_id;
        issue.edge_a = EdgeRef{ring_id, info.edge_index[i]};
        issue.edge_b = EdgeRef{ring_id, info.edge_index[j]};
        issue.location = hit.point;
        add_issue(report, std::move(issue));
      }
    }
  }
}

void check_hole_against_shell(const RingInfo& shell, std::size_t shell_id,
                              const RingInfo& hole, std::size_t hole_id,
                              const ValidationOptions& options,
                              ValidationReport& report) {
  const BoundaryStats stats = boundary_stats(shell, hole);
  if (stats.cross || stats.overlap) {
    Issue issue;
    issue.kind = IssueKind::HoleOutsideShell;
    issue.severity = Severity::Error;
    issue.message =
        std::string(stats.cross ? "hole boundary crosses shell"
                                : "hole boundary overlaps shell") +
        " (" + edge_label(hole_id, stats.edge_b) + " vs " +
        edge_label(shell_id, stats.edge_a) + ")";
    issue.ring_a = hole_id;
    issue.ring_b = shell_id;
    issue.edge_a = EdgeRef{hole_id, stats.edge_b};
    issue.edge_b = EdgeRef{shell_id, stats.edge_a};
    issue.location = stats.point;
    add_issue(report, std::move(issue));
    return;
  }

  bool outside = false;
  bool on_boundary = stats.touch;
  for (const Point& point : hole.points) {
    const PointLocation location = locate_point(point, Ring{shell.points});
    if (location == PointLocation::Outside) {
      outside = true;
      break;
    }
    if (location == PointLocation::Boundary) {
      on_boundary = true;
    }
  }
  if (outside) {
    Issue issue;
    issue.kind = IssueKind::HoleOutsideShell;
    issue.severity = Severity::Error;
    issue.message = "hole is not contained by the shell";
    issue.ring_a = hole_id;
    issue.ring_b = shell_id;
    add_issue(report, std::move(issue));
    return;
  }
  if (on_boundary) {
    Issue issue;
    issue.kind = IssueKind::RingTouch;
    issue.severity =
        options.strict_touching ? Severity::Error : Severity::Warning;
    issue.message = "hole touches the shell boundary";
    issue.ring_a = hole_id;
    issue.ring_b = shell_id;
    issue.edge_a = EdgeRef{hole_id, stats.edge_b};
    issue.edge_b = EdgeRef{shell_id, stats.edge_a};
    issue.location = stats.point;
    add_issue(report, std::move(issue));
  }
}

void check_hole_pair(const RingInfo& a, std::size_t a_id, const RingInfo& b,
                     std::size_t b_id, const ValidationOptions& options,
                     ValidationReport& report) {
  bool reversed = false;
  if (same_cycle(a.points, b.points, &reversed)) {
    return;  // already reported by duplicate-ring detection
  }
  const BoundaryStats stats = boundary_stats(a, b);
  if (stats.cross || stats.overlap) {
    Issue issue;
    issue.kind = IssueKind::HoleOverlap;
    issue.severity = Severity::Error;
    issue.message =
        std::string(stats.cross ? "hole boundaries cross"
                                : "hole boundaries overlap") +
        " (" + edge_label(a_id, stats.edge_a) + " vs " +
        edge_label(b_id, stats.edge_b) + ")";
    issue.ring_a = a_id;
    issue.ring_b = b_id;
    issue.edge_a = EdgeRef{a_id, stats.edge_a};
    issue.edge_b = EdgeRef{b_id, stats.edge_b};
    issue.location = stats.point;
    add_issue(report, std::move(issue));
    return;
  }
  if (stats.touch) {
    Issue issue;
    issue.kind = IssueKind::RingTouch;
    issue.severity =
        options.strict_touching ? Severity::Error : Severity::Warning;
    issue.message = "hole boundaries touch";
    issue.ring_a = a_id;
    issue.ring_b = b_id;
    issue.edge_a = EdgeRef{a_id, stats.edge_a};
    issue.edge_b = EdgeRef{b_id, stats.edge_b};
    issue.location = stats.point;
    add_issue(report, std::move(issue));
  }

  // With no boundary crossing, a vertex of one ring inside the other means
  // one hole is nested inside the other (an island is missing).
  bool nested = false;
  for (const Point& point : a.points) {
    if (locate_point(point, Ring{b.points}) == PointLocation::Inside) {
      nested = true;
      break;
    }
  }
  if (!nested) {
    for (const Point& point : b.points) {
      if (locate_point(point, Ring{a.points}) == PointLocation::Inside) {
        nested = true;
        break;
      }
    }
  }
  if (nested) {
    Issue issue;
    issue.kind = IssueKind::HoleNesting;
    issue.severity = Severity::Error;
    issue.message = "one hole is nested inside another hole";
    issue.ring_a = a_id;
    issue.ring_b = b_id;
    add_issue(report, std::move(issue));
  }
}

}  // namespace

Point::Point(long double x_value, long double y_value)
    : x(x_value), y(y_value) {
  // 2^63 is exactly representable in long double on supported targets; using
  // a half-open interval avoids casting 2^63 itself to int64_t.
  constexpr long double kInt64Bound = 9223372036854775808.0L;
  if (std::isfinite(x_value) && std::isfinite(y_value) &&
      std::trunc(x_value) == x_value && std::trunc(y_value) == y_value &&
      x_value >= -kInt64Bound && x_value < kInt64Bound &&
      y_value >= -kInt64Bound && y_value < kInt64Bound) {
    ix = static_cast<std::int64_t>(x_value);
    iy = static_cast<std::int64_t>(y_value);
    exact_integer = true;
    x = static_cast<long double>(ix);
    y = static_cast<long double>(iy);
  }
}

Point Point::integer(std::int64_t x_value, std::int64_t y_value) {
  Point point;
  point.x = static_cast<long double>(x_value);
  point.y = static_cast<long double>(y_value);
  point.ix = x_value;
  point.iy = y_value;
  point.exact_integer = true;
  return point;
}

Point Point::real(long double x_value, long double y_value) {
  Point point;
  point.x = x_value;
  point.y = y_value;
  point.exact_integer = false;
  return point;
}

bool Point::same_position(const Point& other) const noexcept {
  return same_point(*this, other);
}

Orientation orientation(const Point& a, const Point& b,
                        const Point& c) noexcept {
  const long double value = orient_value(a, b, c);
  if (value > 0.0L) {
    return Orientation::CounterClockwise;
  }
  if (value < 0.0L) {
    return Orientation::Clockwise;
  }
  return Orientation::Collinear;
}

bool point_on_segment(const Point& point, const Point& a,
                      const Point& b) noexcept {
  if (orientation(a, b, point) != Orientation::Collinear) {
    return false;
  }
  if (a.exact_integer && b.exact_integer && point.exact_integer) {
    return point.ix >= std::min(a.ix, b.ix) &&
           point.ix <= std::max(a.ix, b.ix) &&
           point.iy >= std::min(a.iy, b.iy) &&
           point.iy <= std::max(a.iy, b.iy);
  }
  return point.x >= std::min(a.x, b.x) && point.x <= std::max(a.x, b.x) &&
         point.y >= std::min(a.y, b.y) && point.y <= std::max(a.y, b.y);
}

SegmentIntersection segment_intersection(const Point& p0, const Point& p1,
                                         const Point& q0,
                                         const Point& q1) noexcept {
  SegmentIntersection result;
  const Orientation o1 = orientation(p0, p1, q0);
  const Orientation o2 = orientation(p0, p1, q1);
  const Orientation o3 = orientation(q0, q1, p0);
  const Orientation o4 = orientation(q0, q1, p1);

  const bool collinear = o1 == Orientation::Collinear &&
                         o2 == Orientation::Collinear &&
                         o3 == Orientation::Collinear &&
                         o4 == Orientation::Collinear;
  if (collinear) {
    if (same_point(p0, p1)) {
      if (point_on_segment(p0, q0, q1)) {
        result.relation = SegmentRelation::Touch;
        result.point = p0;
      }
      return result;
    }
    if (same_point(q0, q1)) {
      if (point_on_segment(q0, p0, p1)) {
        result.relation = SegmentRelation::Touch;
        result.point = q0;
      }
      return result;
    }
    if (p0.exact_integer && p1.exact_integer && q0.exact_integer &&
        q1.exact_integer) {
      const __int128 x_span =
          static_cast<__int128>(p1.ix) - p0.ix;
      const __int128 y_span =
          static_cast<__int128>(p1.iy) - p0.iy;
      const bool use_x = (x_span < 0 ? -x_span : x_span) >=
                         (y_span < 0 ? -y_span : y_span);
      const std::int64_t p0c = use_x ? p0.ix : p0.iy;
      const std::int64_t p1c = use_x ? p1.ix : p1.iy;
      const std::int64_t q0c = use_x ? q0.ix : q0.iy;
      const std::int64_t q1c = use_x ? q1.ix : q1.iy;
      const std::int64_t p_lo = std::min(p0c, p1c);
      const std::int64_t p_hi = std::max(p0c, p1c);
      const std::int64_t q_lo = std::min(q0c, q1c);
      const std::int64_t q_hi = std::max(q0c, q1c);
      const std::int64_t lo = std::max(p_lo, q_lo);
      const std::int64_t hi = std::min(p_hi, q_hi);
      if (hi < lo) {
        return result;
      }
      const long double denominator =
          static_cast<long double>(p1c) - p0c;
      result.t = (static_cast<long double>(lo) - p0c) / denominator;
      result.t = std::clamp(result.t, 0.0L, 1.0L);
      result.point = interpolate(p0, p1, result.t);
      result.relation =
          hi == lo ? SegmentRelation::Touch : SegmentRelation::Overlap;
      return result;
    }
    const long double dx = p1.x - p0.x;
    const long double dy = p1.y - p0.y;
    const long double length2 = dx * dx + dy * dy;
    if (length2 <= kParamEpsilon) {
      if (point_on_segment(p0, q0, q1)) {
        result.relation = SegmentRelation::Touch;
        result.point = p0;
      }
      return result;
    }
    const auto project = [&](const Point& point) {
      return ((point.x - p0.x) * dx + (point.y - p0.y) * dy) / length2;
    };
    long double t0 = project(q0);
    long double t1 = project(q1);
    if (t0 > t1) {
      std::swap(t0, t1);
    }
    const long double lo = std::max<long double>(0.0L, t0);
    const long double hi = std::min<long double>(1.0L, t1);
    if (hi < lo - kParamEpsilon) {
      return result;
    }
    result.t = std::clamp(lo, 0.0L, 1.0L);
    result.point = interpolate(p0, p1, result.t);
    if (hi - lo <= kParamEpsilon) {
      result.relation = SegmentRelation::Touch;
      return result;
    }
    result.relation = SegmentRelation::Overlap;
    return result;
  }

  if ((o1 == Orientation::CounterClockwise &&
       o2 == Orientation::Clockwise) ||
      (o1 == Orientation::Clockwise &&
       o2 == Orientation::CounterClockwise)) {
    if ((o3 == Orientation::CounterClockwise &&
         o4 == Orientation::Clockwise) ||
        (o3 == Orientation::Clockwise &&
         o4 == Orientation::CounterClockwise)) {
      const long double rx = p1.x - p0.x;
      const long double ry = p1.y - p0.y;
      const long double sx = q1.x - q0.x;
      const long double sy = q1.y - q0.y;
      const long double denominator = rx * sy - ry * sx;
      if (std::fabs(denominator) > kParamEpsilon) {
        const long double qpx = q0.x - p0.x;
        const long double qpy = q0.y - p0.y;
        result.t = (qpx * sy - qpy * sx) / denominator;
        result.u = (qpx * ry - qpy * rx) / denominator;
        result.point = interpolate(p0, p1, result.t);
        result.relation = SegmentRelation::Cross;
        return result;
      }
    }
  }

  if (o1 == Orientation::Collinear && point_on_segment(q0, p0, p1)) {
    result.relation = SegmentRelation::Touch;
    result.point = q0;
    result.u = 0.0L;
    return result;
  }
  if (o2 == Orientation::Collinear && point_on_segment(q1, p0, p1)) {
    result.relation = SegmentRelation::Touch;
    result.point = q1;
    result.u = 1.0L;
    return result;
  }
  if (o3 == Orientation::Collinear && point_on_segment(p0, q0, q1)) {
    result.relation = SegmentRelation::Touch;
    result.point = p0;
    result.t = 0.0L;
    return result;
  }
  if (o4 == Orientation::Collinear && point_on_segment(p1, q0, q1)) {
    result.relation = SegmentRelation::Touch;
    result.point = p1;
    result.t = 1.0L;
    return result;
  }
  return result;
}

long double signed_area(const Ring& ring) noexcept {
  return signed_area_points(closed_ring_points(ring));
}

long double ring_area(const Ring& ring) noexcept {
  return std::fabs(signed_area(ring));
}

long double polygon_area(const Polygon& polygon) noexcept {
  long double area = std::fabs(signed_area(polygon.shell));
  for (const Ring& hole : polygon.holes) {
    area -= std::fabs(signed_area(hole));
  }
  return area;
}

PointLocation locate_point(const Point& point, const Ring& ring) noexcept {
  const std::vector<Point> points = closed_ring_points(ring);
  if (points.size() < 3) {
    return PointLocation::Outside;
  }
  int winding = 0;
  for (std::size_t i = 0; i < points.size(); ++i) {
    const Point& a = points[i];
    const Point& b = points[(i + 1) % points.size()];
    if (point_on_segment(point, a, b)) {
      return PointLocation::Boundary;
    }
    if (a.y <= point.y) {
      if (b.y > point.y &&
          orientation(a, b, point) == Orientation::CounterClockwise) {
        ++winding;
      }
    } else if (b.y <= point.y &&
               orientation(a, b, point) == Orientation::Clockwise) {
      --winding;
    }
  }
  return winding == 0 ? PointLocation::Outside : PointLocation::Inside;
}

ValidationReport validate(const Polygon& polygon,
                          const ValidationOptions& options) {
  ValidationReport report;
  const std::vector<RingInfo> rings = make_ring_infos(polygon);

  for (std::size_t id = 0; id < rings.size(); ++id) {
    const RingInfo& info = rings[id];
    if (info.invalid_coordinate) {
      Issue issue;
      issue.kind = IssueKind::InvalidCoordinate;
      issue.severity = Severity::Error;
      issue.message = "ring contains a non-finite coordinate";
      issue.ring_a = id;
      add_issue(report, std::move(issue));
      continue;
    }
    if (info.repeated_vertex) {
      Issue issue;
      issue.kind = IssueKind::RepeatedVertex;
      issue.severity = Severity::Error;
      issue.message = "ring has consecutive repeated vertices";
      issue.ring_a = id;
      add_issue(report, std::move(issue));
    }
    if (info.points.size() < 3) {
      Issue issue;
      issue.kind = IssueKind::DegenerateRing;
      issue.severity = Severity::Error;
      issue.message = "ring has fewer than three distinct vertices";
      issue.ring_a = id;
      add_issue(report, std::move(issue));
      continue;
    }
    const long double area = signed_area_points(info.points);
    if (std::fabs(area) <= kAreaEpsilon) {
      Issue issue;
      issue.kind = IssueKind::DegenerateRing;
      issue.severity = Severity::Error;
      issue.message = "ring has zero signed area";
      issue.ring_a = id;
      add_issue(report, std::move(issue));
    } else if (options.check_orientation) {
      const bool ccw = area > 0.0L;
      const bool expected_ccw = role_of_ring(id) == RingRole::Shell;
      if (ccw != expected_ccw) {
        Issue issue;
        issue.kind = IssueKind::WrongOrientation;
        issue.severity = Severity::Error;
        issue.message = id == 0
                            ? "shell must be counter-clockwise"
                            : "hole must be clockwise";
        issue.ring_a = id;
        add_issue(report, std::move(issue));
      }
    }
    if (options.check_self_intersections) {
      check_ring_self_intersections(info, id, options, report);
    }
  }

  if (options.check_duplicate_rings) {
    for (std::size_t i = 0; i < rings.size(); ++i) {
      for (std::size_t j = i + 1; j < rings.size(); ++j) {
        bool reversed = false;
        if (same_cycle(rings[i].points, rings[j].points, &reversed)) {
          Issue issue;
          issue.kind = IssueKind::DuplicateRing;
          issue.severity = Severity::Error;
          issue.message = std::string("duplicate ring") +
                          (reversed ? " (reversed copy)" : "");
          issue.ring_a = i;
          issue.ring_b = j;
          add_issue(report, std::move(issue));
        }
      }
    }
  }

  if (options.check_hole_containment && !rings.empty()) {
    const RingInfo& shell = rings[0];
    for (std::size_t hole_id = 1; hole_id < rings.size(); ++hole_id) {
      check_hole_against_shell(shell, 0, rings[hole_id], hole_id, options,
                               report);
    }
    for (std::size_t i = 1; i < rings.size(); ++i) {
      for (std::size_t j = i + 1; j < rings.size(); ++j) {
        check_hole_pair(rings[i], i, rings[j], j, options, report);
      }
    }
  }
  return report;
}

ValidationReport validate(const std::vector<Polygon>& components,
                          const ValidationOptions& options) {
  ValidationReport report;
  const auto locate_in_component = [](const Point& point,
                                      const Polygon& polygon) {
    const PointLocation shell_location = locate_point(point, polygon.shell);
    if (shell_location != PointLocation::Inside) {
      return shell_location;
    }
    for (const Ring& hole : polygon.holes) {
      const PointLocation hole_location = locate_point(point, hole);
      if (hole_location == PointLocation::Inside) {
        return PointLocation::Outside;
      }
      if (hole_location == PointLocation::Boundary) {
        return PointLocation::Boundary;
      }
    }
    return PointLocation::Inside;
  };

  for (std::size_t i = 0; i < components.size(); ++i) {
    ValidationReport local = validate(components[i], options);
    for (Issue& issue : local.issues) {
      issue.message =
          "component " + std::to_string(i) + ": " + issue.message;
      if (issue.severity == Severity::Error) {
        ++report.error_count;
      } else {
        ++report.warning_count;
      }
      report.issues.push_back(std::move(issue));
    }
  }

  // Cross-component boundaries may touch but must not cross, overlap, or
  // contain another component's shell.
  for (std::size_t i = 0; i < components.size(); ++i) {
    for (std::size_t j = i + 1; j < components.size(); ++j) {
      const std::vector<RingInfo> a = make_ring_infos(components[i]);
      const std::vector<RingInfo> b = make_ring_infos(components[j]);
      for (std::size_t ra = 0; ra < a.size(); ++ra) {
        for (std::size_t rb = 0; rb < b.size(); ++rb) {
          const BoundaryStats stats = boundary_stats(a[ra], b[rb]);
          if (stats.cross || stats.overlap) {
            Issue issue;
            issue.kind = IssueKind::ComponentIntersection;
            issue.severity = Severity::Error;
            issue.message =
                "component " + std::to_string(i) +
                " intersects component " + std::to_string(j);
            issue.ring_a = ra;
            issue.ring_b = rb;
            issue.location = stats.point;
            add_issue(report, std::move(issue));
          } else if (stats.touch) {
            Issue issue;
            issue.kind = IssueKind::RingTouch;
            issue.severity =
                options.strict_touching ? Severity::Error : Severity::Warning;
            issue.message = "components touch at a finite set of points";
            issue.ring_a = ra;
            issue.ring_b = rb;
            issue.location = stats.point;
            add_issue(report, std::move(issue));
          }
        }
      }
      if (!a.empty() && !b.empty()) {
        bool contained = false;
        for (const Point& point : a[0].points) {
          if (locate_in_component(point, components[j]) ==
              PointLocation::Inside) {
            contained = true;
            break;
          }
        }
        if (!contained) {
          for (const Point& point : b[0].points) {
            if (locate_in_component(point, components[i]) ==
                PointLocation::Inside) {
              contained = true;
              break;
            }
          }
        }
        if (contained) {
          Issue issue;
          issue.kind = IssueKind::ComponentContainment;
          issue.severity = Severity::Error;
          issue.message = "one component is contained by another component";
          add_issue(report, std::move(issue));
        }
      }
    }
  }
  return report;
}

namespace {

struct Piece {
  Point a;
  Point b;
  std::size_t input_ring = kNoIndex;
  std::size_t input_edge = kNoIndex;
  long double t0 = 0.0L;
  long double t1 = 1.0L;
};

struct WorkRing {
  std::vector<Piece> pieces;
  RingRole role = RingRole::Shell;
  std::size_t input_ring = kNoIndex;
};

struct WorkPolygon {
  WorkRing shell;
  std::vector<WorkRing> holes;
};

[[nodiscard]] std::vector<Point> piece_points(
    const std::vector<Piece>& pieces) {
  std::vector<Point> points;
  points.reserve(pieces.size());
  for (const Piece& piece : pieces) {
    points.push_back(piece.a);
  }
  return points;
}

[[nodiscard]] long double piece_area(const std::vector<Piece>& pieces) {
  if (pieces.size() < 3) {
    return 0.0L;
  }
  long double twice_area = 0.0L;
  for (const Piece& piece : pieces) {
    twice_area += piece.a.x * piece.b.y - piece.a.y * piece.b.x;
  }
  return twice_area * 0.5L;
}

[[nodiscard]] std::vector<Piece> reversed_pieces(
    const std::vector<Piece>& pieces) {
  std::vector<Piece> result;
  result.reserve(pieces.size());
  for (auto it = pieces.rbegin(); it != pieces.rend(); ++it) {
    result.push_back(Piece{it->b, it->a, it->input_ring, it->input_edge,
                           it->t1, it->t0});
  }
  return result;
}

[[nodiscard]] bool connected(const std::vector<Piece>& loop) {
  if (loop.empty()) {
    return true;
  }
  for (std::size_t i = 0; i < loop.size(); ++i) {
    if (!same_point(loop[i].b, loop[(i + 1) % loop.size()].a)) {
      return false;
    }
  }
  return true;
}

[[nodiscard]] std::pair<Piece, Piece> split_piece(const Piece& piece,
                                                  long double fraction) {
  fraction = std::clamp(fraction, 0.0L, 1.0L);
  Point midpoint = interpolate(piece.a, piece.b, fraction);
  const long double tm = piece.t0 + (piece.t1 - piece.t0) * fraction;
  return {Piece{piece.a, midpoint, piece.input_ring, piece.input_edge,
                piece.t0, tm},
          Piece{midpoint, piece.b, piece.input_ring, piece.input_edge, tm,
                piece.t1}};
}

struct SplitLoops {
  std::vector<Piece> first;
  std::vector<Piece> second;
};

[[nodiscard]] std::optional<SplitLoops> split_once(
    const std::vector<Piece>& pieces) {
  const std::size_t count = pieces.size();
  if (count < 4) {
    return std::nullopt;
  }
  for (std::size_t i = 0; i < count; ++i) {
    if (same_point(pieces[i].a, pieces[i].b)) {
      continue;
    }
    for (std::size_t j = i + 1; j < count; ++j) {
      if (same_point(pieces[j].a, pieces[j].b)) {
        continue;
      }
      const bool adjacent =
          (j == i + 1) || (i == 0 && j + 1 == count);
      if (adjacent) {
        continue;
      }
      const SegmentIntersection hit = segment_intersection(
          pieces[i].a, pieces[i].b, pieces[j].a, pieces[j].b);
      if (hit.relation != SegmentRelation::Cross) {
        continue;
      }
      const long double u = hit.t;
      const long double v = hit.u;
      if (u <= kParamEpsilon || u >= 1.0L - kParamEpsilon ||
          v <= kParamEpsilon || v >= 1.0L - kParamEpsilon) {
        continue;
      }

      const auto [a1, a2] = split_piece(pieces[i], u);
      const auto [b1, b2] = split_piece(pieces[j], v);

      std::vector<Piece> loop1;
      loop1.reserve(count + 2);
      loop1.push_back(Piece{a1.b, a1.a, a1.input_ring, a1.input_edge,
                            a1.t1, a1.t0});
      for (std::size_t k = i; k-- > 0;) {
        loop1.push_back(Piece{pieces[k].b, pieces[k].a,
                              pieces[k].input_ring, pieces[k].input_edge,
                              pieces[k].t1, pieces[k].t0});
      }
      for (std::size_t k = count; k-- > j + 1;) {
        loop1.push_back(Piece{pieces[k].b, pieces[k].a,
                              pieces[k].input_ring, pieces[k].input_edge,
                              pieces[k].t1, pieces[k].t0});
      }
      loop1.push_back(Piece{b2.b, b2.a, b2.input_ring, b2.input_edge,
                            b2.t1, b2.t0});

      std::vector<Piece> loop2;
      loop2.reserve(count + 2);
      loop2.push_back(a2);
      for (std::size_t k = i + 1; k < j; ++k) {
        loop2.push_back(pieces[k]);
      }
      loop2.push_back(b1);

      if (!connected(loop1) || !connected(loop2)) {
        continue;
      }
      if (loop1.size() < 3 || loop2.size() < 3) {
        continue;
      }
      return SplitLoops{std::move(loop1), std::move(loop2)};
    }
  }
  return std::nullopt;
}

[[nodiscard]] std::vector<std::vector<Piece>> split_pieces_recursive(
    const std::vector<Piece>& pieces, int depth = 0) {
  if (pieces.size() < 4 || depth > 512) {
    return {pieces};
  }
  const std::optional<SplitLoops> split = split_once(pieces);
  if (!split.has_value()) {
    return {pieces};
  }
  std::vector<std::vector<Piece>> result;
  for (const std::vector<Piece>& loop :
       {split->first, split->second}) {
    std::vector<std::vector<Piece>> nested =
        split_pieces_recursive(loop, depth + 1);
    result.insert(result.end(),
                  std::make_move_iterator(nested.begin()),
                  std::make_move_iterator(nested.end()));
  }
  return result;
}

[[nodiscard]] std::vector<Piece> make_pieces(const RingInfo& info,
                                             std::size_t input_ring) {
  std::vector<Piece> pieces;
  pieces.reserve(info.points.size());
  for (std::size_t i = 0; i < info.points.size(); ++i) {
    const Point& a = info.points[i];
    const Point& b = info.points[(i + 1) % info.points.size()];
    if (same_point(a, b)) {
      continue;
    }
    pieces.push_back(Piece{a, b, input_ring, info.edge_index[i], 0.0L,
                           1.0L});
  }
  return pieces;
}

[[nodiscard]] WorkPolygon make_work_polygon(const Polygon& polygon) {
  const std::vector<RingInfo> infos = make_ring_infos(polygon);
  WorkPolygon work;
  work.shell.pieces = make_pieces(infos[0], 0);
  work.shell.role = RingRole::Shell;
  work.shell.input_ring = 0;
  for (std::size_t i = 1; i < infos.size(); ++i) {
    WorkRing hole;
    hole.pieces = make_pieces(infos[i], i);
    hole.role = RingRole::Hole;
    hole.input_ring = i;
    work.holes.push_back(std::move(hole));
  }
  return work;
}

void normalize_orientation(WorkRing& ring) {
  const long double area = piece_area(ring.pieces);
  if (std::fabs(area) <= kAreaEpsilon) {
    return;
  }
  const bool ccw = area > 0.0L;
  const bool expected_ccw = ring.role == RingRole::Shell;
  if (ccw != expected_ccw) {
    ring.pieces = reversed_pieces(ring.pieces);
  }
}

void normalize_orientation(std::vector<WorkPolygon>& polygons) {
  for (WorkPolygon& polygon : polygons) {
    normalize_orientation(polygon.shell);
    for (WorkRing& hole : polygon.holes) {
      normalize_orientation(hole);
    }
  }
}

[[nodiscard]] RingInfo info_from_points(const std::vector<Point>& points) {
  RingInfo info;
  info.points = points;
  info.edge_index.resize(points.size());
  for (std::size_t i = 0; i < points.size(); ++i) {
    info.edge_index[i] = i;
  }
  return info;
}

[[nodiscard]] bool hole_is_valid(const WorkRing& hole, const WorkRing& shell,
                                 const std::vector<WorkRing>& kept_holes,
                                 bool strict_touching) {
  const std::vector<Point> hole_points = piece_points(hole.pieces);
  const std::vector<Point> shell_points = piece_points(shell.pieces);
  if (hole_points.size() < 3 || shell_points.size() < 3) {
    return false;
  }
  if (std::fabs(signed_area_points(hole_points)) <= kAreaEpsilon) {
    return false;
  }
  if (same_cycle(hole_points, shell_points)) {
    return true;  // duplicate policy owns this decision
  }

  const RingInfo hole_info = info_from_points(hole_points);
  const RingInfo shell_info = info_from_points(shell_points);
  const BoundaryStats stats = boundary_stats(shell_info, hole_info);
  if (stats.cross || stats.overlap) {
    return false;
  }
  if (stats.touch && strict_touching) {
    return false;
  }
  for (const Point& point : hole_points) {
    const PointLocation location =
        locate_point(point, Ring{shell_points});
    if (location == PointLocation::Outside) {
      return false;
    }
    if (location == PointLocation::Boundary && strict_touching) {
      return false;
    }
  }

  for (const WorkRing& other : kept_holes) {
    const std::vector<Point> other_points = piece_points(other.pieces);
    if (other_points.size() < 3) {
      continue;
    }
    if (same_cycle(hole_points, other_points)) {
      return true;  // duplicate policy owns this decision
    }
    const RingInfo other_info = info_from_points(other_points);
    const BoundaryStats relation = boundary_stats(hole_info, other_info);
    if (relation.cross || relation.overlap) {
      return false;
    }
    if (relation.touch && strict_touching) {
      return false;
    }
    if (!relation.touch) {
      for (const Point& point : hole_points) {
        if (locate_point(point, Ring{other_points}) ==
            PointLocation::Inside) {
          return false;
        }
      }
      for (const Point& point : other_points) {
        if (locate_point(point, Ring{hole_points}) ==
            PointLocation::Inside) {
          return false;
        }
      }
    }
  }
  return true;
}

[[nodiscard]] std::size_t drop_duplicate_rings(
    std::vector<WorkPolygon>& polygons) {
  std::size_t dropped = 0;
  for (WorkPolygon& polygon : polygons) {
    const std::vector<Point> shell_points = piece_points(polygon.shell.pieces);
    std::vector<WorkRing> kept;
    kept.reserve(polygon.holes.size());
    for (WorkRing& hole : polygon.holes) {
      const std::vector<Point> hole_points = piece_points(hole.pieces);
      bool duplicate = same_cycle(hole_points, shell_points);
      if (!duplicate) {
        for (const WorkRing& other : kept) {
          if (same_cycle(hole_points, piece_points(other.pieces))) {
            duplicate = true;
            break;
          }
        }
      }
      if (duplicate) {
        ++dropped;
      } else {
        kept.push_back(std::move(hole));
      }
    }
    polygon.holes = std::move(kept);
  }
  return dropped;
}

[[nodiscard]] std::size_t drop_invalid_holes(
    std::vector<WorkPolygon>& polygons, bool strict_touching) {
  std::size_t dropped = 0;
  for (WorkPolygon& polygon : polygons) {
    std::vector<WorkRing> kept;
    kept.reserve(polygon.holes.size());
    for (WorkRing& hole : polygon.holes) {
      if (hole_is_valid(hole, polygon.shell, kept, strict_touching)) {
        kept.push_back(std::move(hole));
      } else {
        ++dropped;
      }
    }
    polygon.holes = std::move(kept);
  }
  return dropped;
}

[[nodiscard]] std::size_t choose_shell(
    const WorkRing& hole, const std::vector<WorkRing>& shells) {
  if (shells.empty()) {
    return 0;
  }
  const std::vector<Point> hole_points = piece_points(hole.pieces);
  for (std::size_t i = 0; i < shells.size(); ++i) {
    const std::vector<Point> shell_points = piece_points(shells[i].pieces);
    if (shell_points.size() < 3) {
      continue;
    }
    bool any_inside = false;
    bool any_outside = false;
    for (const Point& point : hole_points) {
      const PointLocation location =
          locate_point(point, Ring{shell_points});
      any_inside = any_inside || location == PointLocation::Inside;
      any_outside = any_outside || location == PointLocation::Outside;
      if (any_outside) {
        break;
      }
    }
    if (!any_outside && any_inside) {
      return i;
    }
  }
  std::size_t best = 0;
  long double best_area = -1.0L;
  for (std::size_t i = 0; i < shells.size(); ++i) {
    const long double area =
        std::fabs(piece_area(shells[i].pieces));
    if (area > best_area) {
      best_area = area;
      best = i;
    }
  }
  return best;
}

[[nodiscard]] std::vector<WorkPolygon> split_self_intersections(
    const std::vector<WorkPolygon>& input, bool* changed) {
  std::vector<WorkPolygon> output;
  *changed = false;
  for (const WorkPolygon& polygon : input) {
    std::vector<std::vector<Piece>> shell_loops =
        split_pieces_recursive(polygon.shell.pieces);
    if (shell_loops.empty()) {
      shell_loops.push_back({});
    }
    if (shell_loops.size() > 1) {
      *changed = true;
    }

    std::vector<WorkRing> hole_loops;
    for (const WorkRing& hole : polygon.holes) {
      std::vector<std::vector<Piece>> loops =
          split_pieces_recursive(hole.pieces);
      if (loops.size() > 1) {
        *changed = true;
      }
      for (std::vector<Piece>& loop : loops) {
        WorkRing ring;
        ring.pieces = std::move(loop);
        ring.role = RingRole::Hole;
        ring.input_ring = hole.input_ring;
        hole_loops.push_back(std::move(ring));
      }
    }

    std::vector<WorkRing> shells;
    shells.reserve(shell_loops.size());
    for (std::vector<Piece>& loop : shell_loops) {
      WorkRing ring;
      ring.pieces = std::move(loop);
      ring.role = RingRole::Shell;
      ring.input_ring = polygon.shell.input_ring;
      shells.push_back(std::move(ring));
    }

    if (shells.size() <= 1) {
      WorkPolygon result;
      result.shell = std::move(shells.front());
      result.holes = std::move(hole_loops);
      output.push_back(std::move(result));
      continue;
    }

    std::vector<WorkPolygon> pieces_polygons(shells.size());
    for (WorkRing& hole : hole_loops) {
      const std::size_t index = choose_shell(hole, shells);
      pieces_polygons[index].holes.push_back(std::move(hole));
    }
    for (std::size_t i = 0; i < shells.size(); ++i) {
      pieces_polygons[i].shell = std::move(shells[i]);
    }
    for (WorkPolygon& result : pieces_polygons) {
      output.push_back(std::move(result));
    }
  }
  return output;
}

struct SpanAccumulator {
  std::size_t input_ring = kNoIndex;
  std::size_t first_edge = kNoIndex;
  std::size_t last_edge = kNoIndex;
  std::vector<std::size_t> edges;
};

void append_span(std::vector<SpanAccumulator>& spans, std::size_t input_ring,
                 std::size_t input_edge,
                 const std::vector<std::size_t>& input_sizes) {
  if (!spans.empty()) {
    SpanAccumulator& span = spans.back();
    if (span.input_ring == input_ring) {
      const std::size_t size = input_sizes[input_ring];
      bool adjacent = input_edge == span.last_edge;
      if (!adjacent && size > 0) {
        adjacent = input_edge == (span.last_edge + 1) % size ||
                   input_edge == (span.last_edge + size - 1) % size;
      }
      if (adjacent) {
        if (std::find(span.edges.begin(), span.edges.end(), input_edge) ==
            span.edges.end()) {
          span.edges.push_back(input_edge);
        }
        span.last_edge = input_edge;
        return;
      }
    }
  }
  spans.push_back(
      SpanAccumulator{input_ring, input_edge, input_edge, {input_edge}});
}

[[nodiscard]] std::vector<SourceSpan> build_spans(
    const std::vector<std::vector<SourceEdgeRef>>& edge_sources,
    const std::vector<std::size_t>& input_sizes) {
  std::vector<SpanAccumulator> spans;
  for (const std::vector<SourceEdgeRef>& edge : edge_sources) {
    for (const SourceEdgeRef& ref : edge) {
      append_span(spans, ref.input_ring, ref.input_edge, input_sizes);
    }
  }
  std::vector<SourceSpan> result;
  result.reserve(spans.size());
  for (const SpanAccumulator& span : spans) {
    result.push_back(SourceSpan{span.input_ring, span.first_edge,
                                span.last_edge, span.edges.size()});
  }
  return result;
}

[[nodiscard]] OutputRing make_output_ring(
    const std::vector<Piece>& pieces, RingRole role,
    const std::vector<std::size_t>& input_sizes) {
  OutputRing output;
  output.role = role;
  output.ring.points = piece_points(pieces);
  output.signed_area = piece_area(pieces);
  output.edge_sources.resize(pieces.size());
  for (std::size_t i = 0; i < pieces.size(); ++i) {
    output.edge_sources[i].push_back(
        SourceEdgeRef{pieces[i].input_ring, pieces[i].input_edge,
                      pieces[i].t0, pieces[i].t1});
  }
  output.source_spans = build_spans(output.edge_sources, input_sizes);
  return output;
}

[[nodiscard]] OutputPolygon make_output_polygon(
    const WorkPolygon& polygon,
    const std::vector<std::size_t>& input_sizes) {
  OutputPolygon output;
  output.shell =
      make_output_ring(polygon.shell.pieces, RingRole::Shell, input_sizes);
  output.holes.reserve(polygon.holes.size());
  for (const WorkRing& hole : polygon.holes) {
    output.holes.push_back(
        make_output_ring(hole.pieces, RingRole::Hole, input_sizes));
  }
  return output;
}

[[nodiscard]] AreaCheck check_area(long double before, long double after,
                                   const AreaThreshold& threshold) {
  AreaCheck check;
  check.before = before;
  check.after = after;
  check.absolute_delta = std::fabs(after - before);
  const long double magnitude = std::fabs(before);
  if (magnitude <= kAreaEpsilon) {
    check.relative_delta =
        check.absolute_delta <= kAreaEpsilon
            ? 0.0L
            : std::numeric_limits<long double>::infinity();
  } else {
    check.relative_delta = check.absolute_delta / magnitude;
  }

  if (threshold.check_absolute &&
      check.absolute_delta > threshold.max_absolute_delta + kAreaEpsilon) {
    check.within_threshold = false;
    check.rejection_reason =
        "absolute area delta " + std::to_string(check.absolute_delta) +
        " exceeds " + std::to_string(threshold.max_absolute_delta);
  }
  if (threshold.check_relative &&
      check.relative_delta > threshold.max_relative_delta + kAreaEpsilon) {
    check.within_threshold = false;
    if (!check.rejection_reason.empty()) {
      check.rejection_reason += "; ";
    }
    check.rejection_reason +=
        "relative area delta " + std::to_string(check.relative_delta) +
        " exceeds " + std::to_string(threshold.max_relative_delta);
  }
  return check;
}

}  // namespace

Polygon OutputPolygon::to_polygon() const {
  Polygon polygon;
  polygon.shell = shell.ring;
  polygon.holes.reserve(holes.size());
  for (const OutputRing& hole : holes) {
    polygon.holes.push_back(hole.ring);
  }
  return polygon;
}

RepairReport repair(const Polygon& polygon, const RepairPolicy& policy,
                    const AreaThreshold& area_threshold) {
  RepairReport report;
  ValidationOptions validation_options;
  validation_options.strict_touching = policy.strict_touching;
  report.input_validation = validate(polygon, validation_options);

  const long double before = polygon_area(polygon);
  std::vector<std::size_t> input_sizes;
  input_sizes.reserve(polygon.holes.size() + 1);
  input_sizes.push_back(closed_ring_points(polygon.shell).size());
  for (const Ring& hole : polygon.holes) {
    input_sizes.push_back(closed_ring_points(hole).size());
  }

  auto add_candidate = [&](std::string name,
                           std::vector<RepairAction> actions,
                           const std::vector<WorkPolygon>& work) {
    for (const RepairCandidate& existing : report.candidates) {
      if (existing.actions == actions) {
        return;
      }
    }
    RepairCandidate candidate;
    candidate.name = std::move(name);
    candidate.actions = std::move(actions);
    std::vector<Polygon> components;
    components.reserve(work.size());
    long double after = 0.0L;
    for (const WorkPolygon& item : work) {
      OutputPolygon out = make_output_polygon(item, input_sizes);
      components.push_back(out.to_polygon());
      after += polygon_area(components.back());
      candidate.polygons.push_back(std::move(out));
    }
    const ValidationReport validation =
        validate(components, validation_options);
    candidate.remaining_issues = validation.issues;
    candidate.geometrically_valid = validation.valid();
    candidate.area = check_area(before, after, area_threshold);
    candidate.accepted =
        candidate.geometrically_valid && candidate.area.within_threshold;
    if (!candidate.geometrically_valid) {
      candidate.rejection_reasons.push_back(
          std::to_string(validation.error_count) +
          " validation error(s) remain");
    }
    if (!candidate.area.within_threshold) {
      candidate.rejection_reasons.push_back(
          candidate.area.rejection_reason);
    }
    if (candidate.accepted && !report.accepted_candidate.has_value()) {
      report.accepted_candidate = report.candidates.size();
    }
    report.candidates.push_back(std::move(candidate));
  };

  const std::vector<WorkPolygon> base = {make_work_polygon(polygon)};
  if (report.input_validation.valid()) {
    add_candidate("unchanged", {}, base);
    return report;
  }

  std::vector<std::vector<WorkPolygon>> stages;
  std::vector<std::vector<RepairAction>> stage_actions;
  std::vector<std::string> stage_names;

  if (policy.generate_staged_candidates) {
    stage_actions.push_back({RepairAction::NormalizeOrientation});
    stage_names.push_back("normalize-orientation");
  }

  if (policy.generate_staged_candidates &&
      policy.duplicate_rings == DuplicateRingPolicy::Drop) {
    stage_actions.push_back({RepairAction::NormalizeOrientation,
                             RepairAction::DropDuplicateRings});
    stage_names.push_back("deduplicate-rings");
  }
  if (policy.generate_staged_candidates &&
      policy.invalid_holes == InvalidHolePolicy::Drop) {
    std::vector<RepairAction> actions = {
        RepairAction::NormalizeOrientation,
        RepairAction::DropInvalidHoles};
    if (policy.duplicate_rings == DuplicateRingPolicy::Drop) {
      actions.insert(actions.begin() + 1,
                     RepairAction::DropDuplicateRings);
    }
    stage_actions.push_back(std::move(actions));
    stage_names.push_back("resolve-holes");
  }
  if (policy.generate_staged_candidates &&
      policy.self_intersections == SelfIntersectionPolicy::Split) {
    std::vector<RepairAction> actions = {
        RepairAction::NormalizeOrientation};
    if (policy.duplicate_rings == DuplicateRingPolicy::Drop) {
      actions.push_back(RepairAction::DropDuplicateRings);
    }
    actions.push_back(RepairAction::SplitSelfIntersections);
    if (policy.invalid_holes == InvalidHolePolicy::Drop) {
      actions.push_back(RepairAction::DropInvalidHoles);
    }
    stage_actions.push_back(std::move(actions));
    stage_names.push_back("split-self-intersections");
  }

  std::vector<RepairAction> combined_actions = {
      RepairAction::NormalizeOrientation};
  if (policy.duplicate_rings == DuplicateRingPolicy::Drop) {
    combined_actions.push_back(RepairAction::DropDuplicateRings);
  }
  if (policy.self_intersections == SelfIntersectionPolicy::Split) {
    combined_actions.push_back(RepairAction::SplitSelfIntersections);
  }
  if (policy.invalid_holes == InvalidHolePolicy::Drop) {
    combined_actions.push_back(RepairAction::DropInvalidHoles);
  }
  stage_actions.push_back(combined_actions);
  stage_names.push_back("policy-combined");

  for (std::size_t i = 0; i < stage_actions.size(); ++i) {
    std::vector<WorkPolygon> work = base;
    for (RepairAction action : stage_actions[i]) {
      switch (action) {
        case RepairAction::NormalizeOrientation:
          normalize_orientation(work);
          break;
        case RepairAction::DropDuplicateRings:
          (void)drop_duplicate_rings(work);
          break;
        case RepairAction::DropInvalidHoles:
          (void)drop_invalid_holes(work, policy.strict_touching);
          break;
        case RepairAction::SplitSelfIntersections: {
          bool changed = false;
          work = split_self_intersections(work, &changed);
          normalize_orientation(work);
          break;
        }
      }
    }
    add_candidate(stage_names[i], stage_actions[i], work);
  }
  return report;
}

const RepairCandidate* RepairReport::best() const noexcept {
  if (!accepted_candidate.has_value() ||
      *accepted_candidate >= candidates.size()) {
    return nullptr;
  }
  return &candidates[*accepted_candidate];
}

}  // namespace dataeng
