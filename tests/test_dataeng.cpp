#include "dataeng.hpp"

#include <cmath>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

namespace {

int failures = 0;
int checks = 0;

void check(bool condition, const std::string& message, int line) {
  ++checks;
  if (!condition) {
    ++failures;
    std::cerr << "FAIL line " << line << ": " << message << '\n';
  }
}

#define CHECK(condition) check((condition), #condition, __LINE__)
#define CHECK_NEAR(a, b) \
  check(std::fabs((a) - (b)) < 1e-9L, \
        std::string(#a " near " #b), __LINE__)

using dataeng::AreaThreshold;
using dataeng::IssueKind;
using dataeng::Point;
using dataeng::Polygon;
using dataeng::RepairAction;
using dataeng::RepairCandidate;
using dataeng::RepairPolicy;
using dataeng::Ring;
using dataeng::RingRole;
using dataeng::Severity;
using dataeng::ValidationReport;

Point P(long long x, long long y) {
  return Point::integer(x, y);
}

Ring rectangle(long long x0, long long y0, long long x1, long long y1,
               bool ccw = true) {
  if (ccw) {
    return Ring{P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)};
  }
  return Ring{P(x0, y0), P(x0, y1), P(x1, y1), P(x1, y0)};
}

bool has_issue(const ValidationReport& report, IssueKind kind) {
  for (const dataeng::Issue& issue : report.issues) {
    if (issue.kind == kind) {
      return true;
    }
  }
  return false;
}

const RepairCandidate* candidate_named(
    const dataeng::RepairReport& report, const std::string& name) {
  for (const RepairCandidate& candidate : report.candidates) {
    if (candidate.name == name) {
      return &candidate;
    }
  }
  return nullptr;
}

bool has_action(const RepairCandidate& candidate, RepairAction action) {
  for (RepairAction value : candidate.actions) {
    if (value == action) {
      return true;
    }
  }
  return false;
}

void test_valid_polygon() {
  Polygon polygon;
  polygon.shell = rectangle(0, 0, 10, 10);
  polygon.holes.push_back(rectangle(2, 2, 8, 8, false));
  const ValidationReport report = dataeng::validate(polygon);
  CHECK(report.valid());
  CHECK(report.issues.empty());
  CHECK_NEAR(dataeng::polygon_area(polygon), 64.0L);

  const dataeng::RepairReport repair = dataeng::repair(polygon);
  CHECK(repair.input_validation.valid());
  CHECK(repair.candidates.size() == 1);
  CHECK(repair.best() != nullptr);
  if (repair.best() != nullptr) {
    CHECK(repair.best()->accepted);
    CHECK(repair.best()->actions.empty());
    CHECK_NEAR(repair.best()->area.absolute_delta, 0.0L);
  }
}

void test_wrong_orientation_and_provenance() {
  Polygon polygon;
  polygon.shell = rectangle(0, 0, 10, 10, false);  // CW, wrong
  polygon.holes.push_back(rectangle(2, 2, 8, 8, true));  // CCW, wrong
  const ValidationReport report = dataeng::validate(polygon);
  CHECK(!report.valid());
  CHECK(has_issue(report, IssueKind::WrongOrientation));

  const dataeng::RepairReport repair = dataeng::repair(polygon);
  CHECK(repair.best() != nullptr);
  if (repair.best() == nullptr) {
    return;
  }
  const RepairCandidate& candidate = *repair.best();
  CHECK(candidate.geometrically_valid);
  CHECK(candidate.area.within_threshold);
  CHECK_NEAR(candidate.area.before, 64.0L);
  CHECK_NEAR(candidate.area.after, 64.0L);
  CHECK_NEAR(candidate.area.absolute_delta, 0.0L);
  CHECK(candidate.polygons.size() == 1);

  const dataeng::OutputPolygon& output = candidate.polygons.front();
  CHECK(output.shell.role == RingRole::Shell);
  CHECK(output.shell.signed_area > 0.0L);
  CHECK(output.holes.size() == 1);
  CHECK(output.holes.front().role == RingRole::Hole);
  CHECK(output.holes.front().signed_area < 0.0L);

  CHECK(output.shell.edge_sources.size() == output.shell.ring.size());
  for (const auto& sources : output.shell.edge_sources) {
    CHECK(!sources.empty());
    for (const dataeng::SourceEdgeRef& source : sources) {
      CHECK(source.input_ring == 0);
      CHECK(source.input_edge < 4);
    }
  }
  CHECK(!output.shell.source_spans.empty());
  CHECK(output.shell.source_spans.front().input_ring == 0);
  CHECK(output.shell.source_spans.front().edge_count == 4);
  CHECK(!output.holes.front().source_spans.empty());
  CHECK(output.holes.front().source_spans.front().input_ring == 1);
}

void test_duplicate_ring_and_area_gate() {
  Polygon polygon;
  polygon.shell = rectangle(0, 0, 10, 10);
  polygon.holes.push_back(rectangle(2, 2, 8, 8, false));
  polygon.holes.push_back(rectangle(2, 2, 8, 8, false));
  const ValidationReport report = dataeng::validate(polygon);
  CHECK(!report.valid());
  CHECK(has_issue(report, IssueKind::DuplicateRing));
  CHECK_NEAR(dataeng::polygon_area(polygon), 28.0L);

  const dataeng::RepairReport strict = dataeng::repair(polygon);
  CHECK(strict.best() == nullptr);
  const RepairCandidate* dedupe =
      candidate_named(strict, "deduplicate-rings");
  CHECK(dedupe != nullptr);
  if (dedupe != nullptr) {
    CHECK(dedupe->geometrically_valid);
    CHECK(!dedupe->area.within_threshold);
    CHECK_NEAR(dedupe->area.absolute_delta, 36.0L);
    CHECK(has_action(*dedupe, RepairAction::DropDuplicateRings));
  }

  AreaThreshold threshold;
  threshold.max_absolute_delta = 40.0L;
  const dataeng::RepairReport allowed =
      dataeng::repair(polygon, RepairPolicy{}, threshold);
  CHECK(allowed.best() != nullptr);
  if (allowed.best() != nullptr) {
    CHECK_NEAR(allowed.best()->area.after, 64.0L);
    CHECK(allowed.best()->polygons.front().holes.size() == 1);
    const dataeng::OutputRing& hole =
        allowed.best()->polygons.front().holes.front();
    CHECK(!hole.source_spans.empty());
    CHECK(hole.source_spans.front().input_ring == 1);
  }
}

void test_duplicate_ring_rotation_and_reversal() {
  Polygon rotated;
  rotated.shell = rectangle(0, 0, 10, 10);
  rotated.holes.push_back(rectangle(2, 2, 8, 8, false));
  rotated.holes.push_back(
      Ring{P(8, 8), P(8, 2), P(2, 2), P(2, 8)});
  CHECK(has_issue(dataeng::validate(rotated), IssueKind::DuplicateRing));

  Polygon reversed;
  reversed.shell = rectangle(0, 0, 10, 10);
  reversed.holes.push_back(rectangle(2, 2, 8, 8, false));
  reversed.holes.push_back(
      Ring{P(2, 2), P(8, 2), P(8, 8), P(2, 8)});
  CHECK(has_issue(dataeng::validate(reversed), IssueKind::DuplicateRing));
}

void test_hole_outside_shell() {
  Polygon polygon;
  polygon.shell = rectangle(0, 0, 10, 10);
  polygon.holes.push_back(rectangle(20, 20, 30, 30, false));
  const ValidationReport report = dataeng::validate(polygon);
  CHECK(!report.valid());
  CHECK(has_issue(report, IssueKind::HoleOutsideShell));

  const dataeng::RepairReport strict = dataeng::repair(polygon);
  CHECK(strict.best() == nullptr);

  AreaThreshold threshold;
  threshold.max_absolute_delta = 150.0L;
  const dataeng::RepairReport allowed =
      dataeng::repair(polygon, RepairPolicy{}, threshold);
  CHECK(allowed.best() != nullptr);
  if (allowed.best() != nullptr) {
    CHECK(allowed.best()->polygons.front().holes.empty());
    CHECK_NEAR(allowed.best()->area.after, 100.0L);
    CHECK(has_action(*allowed.best(), RepairAction::DropInvalidHoles));
  }
}

void test_hole_crosses_shell() {
  Polygon polygon;
  polygon.shell = rectangle(0, 0, 10, 10);
  polygon.holes.push_back(rectangle(5, 2, 15, 8, false));
  const ValidationReport report = dataeng::validate(polygon);
  CHECK(!report.valid());
  CHECK(has_issue(report, IssueKind::HoleOutsideShell));
}

void test_self_intersection_split() {
  Polygon polygon;
  polygon.shell = Ring{P(0, 0), P(2, 2), P(0, 2), P(2, 0)};
  const ValidationReport report = dataeng::validate(polygon);
  CHECK(!report.valid());
  CHECK(has_issue(report, IssueKind::SelfIntersection));

  AreaThreshold threshold;
  threshold.max_absolute_delta = 10.0L;
  const dataeng::RepairReport repair =
      dataeng::repair(polygon, RepairPolicy{}, threshold);
  CHECK(repair.best() != nullptr);
  if (repair.best() == nullptr) {
    return;
  }
  const RepairCandidate& candidate = *repair.best();
  CHECK(has_action(candidate, RepairAction::SplitSelfIntersections));
  CHECK(candidate.geometrically_valid);
  CHECK(candidate.polygons.size() == 2);
  CHECK_NEAR(candidate.area.before, 0.0L);
  CHECK_NEAR(candidate.area.after, 2.0L);
  for (const dataeng::OutputPolygon& part : candidate.polygons) {
    CHECK(part.shell.role == RingRole::Shell);
    CHECK(part.shell.signed_area > 0.0L);
    CHECK(part.shell.ring.size() >= 3);
    CHECK(!part.shell.source_spans.empty());
    for (const dataeng::SourceSpan& span : part.shell.source_spans) {
      CHECK(span.input_ring == 0);
      CHECK(span.first_edge < 4);
      CHECK(span.last_edge < 4);
      CHECK(span.edge_count >= 1);
    }
    for (const auto& sources : part.shell.edge_sources) {
      CHECK(!sources.empty());
      CHECK(sources.front().input_ring == 0);
    }
  }
}

void test_split_keeps_hole_in_correct_lobe() {
  Polygon polygon;
  polygon.shell = Ring{P(0, 0), P(8, 8), P(0, 8), P(8, 0)};
  polygon.holes.push_back(
      Ring{P(3, 1), P(3, 2), P(4, 2), P(4, 1)});

  AreaThreshold threshold;
  threshold.max_absolute_delta = 200.0L;
  const dataeng::RepairReport repair =
      dataeng::repair(polygon, RepairPolicy{}, threshold);
  CHECK(repair.best() != nullptr);
  if (repair.best() == nullptr) {
    return;
  }
  const RepairCandidate& candidate = *repair.best();
  CHECK(candidate.polygons.size() == 2);
  std::size_t polygons_with_holes = 0;
  for (const dataeng::OutputPolygon& part : candidate.polygons) {
    if (!part.holes.empty()) {
      ++polygons_with_holes;
      CHECK(part.holes.size() == 1);
      CHECK(part.holes.front().ring.size() == 4);
      CHECK(!part.holes.front().source_spans.empty());
      CHECK(part.holes.front().source_spans.front().input_ring == 1);
    }
  }
  CHECK(polygons_with_holes == 1);
  CHECK_NEAR(candidate.area.after, 31.0L);
}

void test_hole_overlap_and_nesting() {
  Polygon polygon;
  polygon.shell = rectangle(0, 0, 20, 20);
  polygon.holes.push_back(rectangle(2, 2, 10, 10, false));
  polygon.holes.push_back(rectangle(8, 8, 16, 16, false));
  const ValidationReport overlap = dataeng::validate(polygon);
  CHECK(!overlap.valid());
  CHECK(has_issue(overlap, IssueKind::HoleOverlap));

  Polygon nested;
  nested.shell = rectangle(0, 0, 20, 20);
  nested.holes.push_back(rectangle(2, 2, 16, 16, false));
  nested.holes.push_back(rectangle(4, 4, 8, 8, false));
  const ValidationReport nesting = dataeng::validate(nested);
  CHECK(!nesting.valid());
  CHECK(has_issue(nesting, IssueKind::HoleNesting));
}

void test_repeated_vertex_and_degenerate() {
  Polygon repeated;
  repeated.shell =
      Ring{P(0, 0), P(10, 0), P(10, 0), P(10, 10), P(0, 10)};
  const ValidationReport report = dataeng::validate(repeated);
  CHECK(!report.valid());
  CHECK(has_issue(report, IssueKind::RepeatedVertex));

  Polygon degenerate;
  degenerate.shell = Ring{P(0, 0), P(10, 0), P(20, 0)};
  const ValidationReport line = dataeng::validate(degenerate);
  CHECK(!line.valid());
  CHECK(has_issue(line, IssueKind::DegenerateRing));
}

void test_exact_integer_predicates() {
  const Point a = P(0, 0);
  const Point b = P(1000000000, 1000000000);
  const Point c = P(1000000001, 1000000000);
  CHECK(dataeng::orientation(a, b, c) ==
        dataeng::Orientation::Clockwise);
  CHECK(dataeng::orientation(a, b, P(1000000001, 1000000001)) ==
        dataeng::Orientation::Collinear);

  const dataeng::SegmentIntersection crossing = dataeng::segment_intersection(
      P(0, 0), P(1000000000, 1000000000), P(0, 1000000000),
      P(1000000000, 0));
  CHECK(crossing.relation == dataeng::SegmentRelation::Cross);
  CHECK_NEAR(crossing.point.x, 500000000.0L);
  CHECK_NEAR(crossing.point.y, 500000000.0L);

  // A double-based cross product loses the sign here; the exact predicate
  // must still classify the point as collinear.
  CHECK(dataeng::orientation(a, b, P(999999999, 999999999)) ==
        dataeng::Orientation::Collinear);
  CHECK(!dataeng::point_on_segment(P(999999999, 1000000000), a, b));

  // The exact 128-bit kernel keeps the sign even when the products are far
  // beyond both double and 80-bit long-double precision.
  const Point huge_a = P(0, 0);
  const Point huge_b = P(1000000000000000000LL, 1000000000000000000LL);
  const Point huge_c = P(1000000000000000001LL, 1000000000000000000LL);
  CHECK(dataeng::orientation(huge_a, huge_b, huge_c) ==
        dataeng::Orientation::Clockwise);

  const dataeng::SegmentIntersection overlap = dataeng::segment_intersection(
      P(0, 0), P(1000000000000000000LL, 1000000000000000000LL),
      P(500000000000000000LL, 500000000000000000LL),
      P(1000000000000000000LL, 1000000000000000000LL));
  CHECK(overlap.relation == dataeng::SegmentRelation::Overlap);
  const dataeng::SegmentIntersection touch = dataeng::segment_intersection(
      P(0, 0), P(1000000000000000000LL, 1000000000000000000LL),
      P(1000000000000000000LL, 1000000000000000000LL),
      P(2000000000000000000LL, 2000000000000000000LL));
  CHECK(touch.relation == dataeng::SegmentRelation::Touch);
}

void test_relative_area_gate() {
  Polygon polygon;
  polygon.shell = rectangle(0, 0, 10, 10);
  polygon.holes.push_back(rectangle(2, 2, 8, 8, false));
  polygon.holes.push_back(rectangle(2, 2, 8, 8, false));

  AreaThreshold threshold;
  threshold.check_absolute = false;
  threshold.check_relative = true;
  threshold.max_relative_delta = 0.10L;  // 36 / 28 is far above this.
  const dataeng::RepairReport rejected =
      dataeng::repair(polygon, RepairPolicy{}, threshold);
  CHECK(rejected.best() == nullptr);

  threshold.max_relative_delta = 2.0L;
  const dataeng::RepairReport accepted =
      dataeng::repair(polygon, RepairPolicy{}, threshold);
  CHECK(accepted.best() != nullptr);
}

void test_closed_input_ring() {
  Polygon polygon;
  polygon.shell =
      Ring{P(0, 0), P(10, 0), P(10, 10), P(0, 10), P(0, 0)};
  const ValidationReport report = dataeng::validate(polygon);
  CHECK(report.valid());
  CHECK_NEAR(dataeng::signed_area(polygon.shell), 100.0L);
}

void test_explicit_reject_policies() {
  Polygon duplicate;
  duplicate.shell = rectangle(0, 0, 10, 10);
  duplicate.holes.push_back(rectangle(2, 2, 8, 8, false));
  duplicate.holes.push_back(rectangle(2, 2, 8, 8, false));

  RepairPolicy reject_duplicates;
  reject_duplicates.duplicate_rings = dataeng::DuplicateRingPolicy::Reject;
  AreaThreshold generous;
  generous.max_absolute_delta = 1000.0L;
  const dataeng::RepairReport duplicate_report =
      dataeng::repair(duplicate, reject_duplicates, generous);
  CHECK(duplicate_report.best() == nullptr);

  Polygon bowtie;
  bowtie.shell = Ring{P(0, 0), P(2, 2), P(0, 2), P(2, 0)};
  RepairPolicy reject_self;
  reject_self.self_intersections =
      dataeng::SelfIntersectionPolicy::Reject;
  AreaThreshold loose;
  loose.max_absolute_delta = 100.0L;
  const dataeng::RepairReport self_report =
      dataeng::repair(bowtie, reject_self, loose);
  CHECK(self_report.best() == nullptr);

  RepairPolicy single_stage;
  single_stage.generate_staged_candidates = false;
  const dataeng::RepairReport single_report =
      dataeng::repair(duplicate, single_stage, generous);
  CHECK(single_report.candidates.size() == 1);
  CHECK(single_report.candidates.front().name == "policy-combined");
  CHECK(single_report.best() != nullptr);
}

}  // namespace

int main() {
  test_valid_polygon();
  test_wrong_orientation_and_provenance();
  test_duplicate_ring_and_area_gate();
  test_duplicate_ring_rotation_and_reversal();
  test_hole_outside_shell();
  test_hole_crosses_shell();
  test_self_intersection_split();
  test_split_keeps_hole_in_correct_lobe();
  test_hole_overlap_and_nesting();
  test_repeated_vertex_and_degenerate();
  test_exact_integer_predicates();
  test_relative_area_gate();
  test_closed_input_ring();
  test_explicit_reject_policies();

  std::cout << (checks - failures) << "/" << checks << " checks passed\n";
  if (failures != 0) {
    std::cerr << failures << " check(s) failed\n";
    return EXIT_FAILURE;
  }
  return EXIT_SUCCESS;
}
