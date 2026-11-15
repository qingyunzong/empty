#pragma once

#include <cstddef>
#include <cstdint>
#include <initializer_list>
#include <optional>
#include <string>
#include <vector>

namespace dataeng {

// Ring identifiers use the ETL-wide convention:
//   0      -> polygon shell
//   1..N   -> holes, in Polygon::holes order
inline constexpr std::size_t kNoIndex = static_cast<std::size_t>(-1);

// A point keeps both a floating representation (used for output geometry) and,
// when the input was an integer, an exact signed-64-bit representation.  All
// topological predicates use the exact representation when it is available.
struct Point {
  long double x = 0.0L;
  long double y = 0.0L;

  bool exact_integer = false;
  std::int64_t ix = 0;
  std::int64_t iy = 0;

  Point() = default;
  Point(long double x_value, long double y_value);

  static Point integer(std::int64_t x_value, std::int64_t y_value);
  static Point real(long double x_value, long double y_value);

  [[nodiscard]] bool has_exact_integer() const noexcept { return exact_integer; }
  [[nodiscard]] bool same_position(const Point& other) const noexcept;
};

struct Ring {
  std::vector<Point> points;

  Ring() = default;
  explicit Ring(std::vector<Point> values) : points(std::move(values)) {}
  Ring(std::initializer_list<Point> values) : points(values) {}

  [[nodiscard]] bool empty() const noexcept { return points.empty(); }
  [[nodiscard]] std::size_t size() const noexcept { return points.size(); }
};

struct Polygon {
  Ring shell;
  std::vector<Ring> holes;
};

enum class RingRole { Shell, Hole };

enum class Orientation {
  Clockwise = -1,
  Collinear = 0,
  CounterClockwise = 1
};

enum class PointLocation { Outside, Inside, Boundary };

enum class SegmentRelation { Disjoint, Cross, Touch, Overlap };

struct SegmentIntersection {
  SegmentRelation relation = SegmentRelation::Disjoint;
  Point point;
  long double t = 0.0L;  // position along p0 -> p1
  long double u = 0.0L;  // position along q0 -> q1
};

// Exact for integral inputs whose products fit signed __int128.  Integral
// coordinates are detected automatically by Point's converting constructor,
// or can be tagged explicitly with Point::integer().
[[nodiscard]] Orientation orientation(const Point& a, const Point& b,
                                      const Point& c) noexcept;
[[nodiscard]] bool point_on_segment(const Point& point, const Point& a,
                                    const Point& b) noexcept;
[[nodiscard]] SegmentIntersection segment_intersection(const Point& p0,
                                                       const Point& p1,
                                                       const Point& q0,
                                                       const Point& q1) noexcept;

// Signed shoelace area.  Shells are positive when counter-clockwise.
[[nodiscard]] long double signed_area(const Ring& ring) noexcept;
[[nodiscard]] long double ring_area(const Ring& ring) noexcept;
// Geometric polygon area: |shell| - sum(|holes|).
[[nodiscard]] long double polygon_area(const Polygon& polygon) noexcept;
[[nodiscard]] PointLocation locate_point(const Point& point,
                                         const Ring& ring) noexcept;

enum class Severity { Warning, Error };

enum class IssueKind {
  InvalidCoordinate,
  DegenerateRing,
  RepeatedVertex,
  DuplicateRing,
  WrongOrientation,
  SelfIntersection,
  RingSelfTouch,
  HoleOutsideShell,
  HoleOverlap,
  HoleNesting,
  RingTouch,
  ComponentIntersection,
  ComponentContainment
};

struct EdgeRef {
  std::size_t ring = kNoIndex;
  std::size_t edge = kNoIndex;
};

struct Issue {
  IssueKind kind = IssueKind::DegenerateRing;
  Severity severity = Severity::Error;
  std::string message;
  std::size_t ring_a = kNoIndex;
  std::size_t ring_b = kNoIndex;
  EdgeRef edge_a;
  EdgeRef edge_b;
  Point location;
};

struct ValidationOptions {
  // Treat point touches (as opposed to crossings/overlaps) as errors.
  bool strict_touching = false;
  // Individual checks can be disabled by an ETL stage.
  bool check_self_intersections = true;
  bool check_duplicate_rings = true;
  bool check_orientation = true;
  bool check_hole_containment = true;
};

struct ValidationReport {
  std::vector<Issue> issues;
  std::size_t error_count = 0;
  std::size_t warning_count = 0;

  [[nodiscard]] bool valid() const noexcept { return error_count == 0; }
};

[[nodiscard]] ValidationReport validate(
    const Polygon& polygon, const ValidationOptions& options = {});

// Validates several polygon components as one multipolygon.  Components may
// touch at finitely many points (unless strict_touching is set), but their
// boundaries may not cross or overlap.
[[nodiscard]] ValidationReport validate(
    const std::vector<Polygon>& components,
    const ValidationOptions& options = {});

// Provenance of one output edge.  t_begin/t_end are positions on the input
// edge p[input_edge] -> p[(input_edge + 1) % ring_size].  A decreasing
// parameter range means the output edge traverses the input edge backwards.
struct SourceEdgeRef {
  std::size_t input_ring = kNoIndex;
  std::size_t input_edge = kNoIndex;
  long double t_begin = 0.0L;
  long double t_end = 1.0L;
};

// Coalesced run of input edges used by an output ring.  It is a cyclic
// interval [first_edge, last_edge] when traversing a ring, and edge_count
// records how many input edges participate (so a full reversed ring is not
// confused with a one-edge interval).
struct SourceSpan {
  std::size_t input_ring = kNoIndex;
  std::size_t first_edge = kNoIndex;
  std::size_t last_edge = kNoIndex;
  std::size_t edge_count = 0;
};

struct OutputRing {
  Ring ring;
  RingRole role = RingRole::Shell;
  // Parallel to the output edges (ring.points.size() edges).  Each edge has
  // at least one source; split edges still point back to their original edge.
  std::vector<std::vector<SourceEdgeRef>> edge_sources;
  // Coalesced ring-level lineage.  This is the stable ETL contract: every
  // output ring enumerates the input edge intervals it came from.
  std::vector<SourceSpan> source_spans;
  long double signed_area = 0.0L;
};

struct OutputPolygon {
  OutputRing shell;
  std::vector<OutputRing> holes;

  [[nodiscard]] Polygon to_polygon() const;
};

struct AreaThreshold {
  // Both configured limits, when enabled, must pass.  The default accepts only
  // area-preserving repairs.  Set max_relative_delta to allow tiny changes.
  bool check_absolute = true;
  long double max_absolute_delta = 0.0L;
  bool check_relative = false;
  long double max_relative_delta = 0.0L;
};

struct AreaCheck {
  long double before = 0.0L;
  long double after = 0.0L;
  long double absolute_delta = 0.0L;
  long double relative_delta = 0.0L;
  bool within_threshold = true;
  std::string rejection_reason;
};

enum class RepairAction {
  NormalizeOrientation,
  DropDuplicateRings,
  DropInvalidHoles,
  SplitSelfIntersections
};

enum class DuplicateRingPolicy { Drop, Reject };
enum class InvalidHolePolicy { Drop, Reject };
enum class SelfIntersectionPolicy { Split, Reject };

struct RepairPolicy {
  DuplicateRingPolicy duplicate_rings = DuplicateRingPolicy::Drop;
  InvalidHolePolicy invalid_holes = InvalidHolePolicy::Drop;
  SelfIntersectionPolicy self_intersections = SelfIntersectionPolicy::Split;
  bool strict_touching = false;
  // Emit less-aggressive intermediate candidates as well as the combined one.
  // The first accepted candidate in the report is the least aggressive.
  bool generate_staged_candidates = true;
};

struct RepairCandidate {
  std::string name;
  std::vector<RepairAction> actions;
  std::vector<OutputPolygon> polygons;
  std::vector<Issue> remaining_issues;
  bool geometrically_valid = false;
  AreaCheck area;
  bool accepted = false;
  std::vector<std::string> rejection_reasons;
};

struct RepairReport {
  ValidationReport input_validation;
  std::vector<RepairCandidate> candidates;
  std::optional<std::size_t> accepted_candidate;

  [[nodiscard]] const RepairCandidate* best() const noexcept;
};

// Generates candidates according to an explicit policy.  Geometry is never
// returned without diagnostics, provenance and an area check.
[[nodiscard]] RepairReport repair(
    const Polygon& polygon, const RepairPolicy& policy = {},
    const AreaThreshold& area_threshold = {});

class PolygonValidityEngine {
 public:
  explicit PolygonValidityEngine(ValidationOptions options = {})
      : options_(options) {}

  [[nodiscard]] ValidationReport validate(const Polygon& polygon) const {
    return dataeng::validate(polygon, options_);
  }

  [[nodiscard]] RepairReport repair(
      const Polygon& polygon, const RepairPolicy& policy = {},
      const AreaThreshold& area_threshold = {}) const {
    RepairPolicy effective = policy;
    effective.strict_touching =
        effective.strict_touching || options_.strict_touching;
    return dataeng::repair(polygon, effective, area_threshold);
  }

 private:
  ValidationOptions options_;
};

}  // namespace dataeng
