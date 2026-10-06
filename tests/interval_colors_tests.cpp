#include "interval_colors.hpp"

#include <cstdlib>
#include <iostream>
#include <vector>

namespace {

int failures = 0;

#define CHECK(cond)                                                        \
    do {                                                                   \
        if (!(cond)) {                                                     \
            ++failures;                                                    \
            std::cerr << "FAIL " << __FILE__ << ':' << __LINE__ << ": "    \
                      << #cond << '\n';                                    \
        }                                                                  \
    } while (0)

using icm::IntervalColors;
using icm::Segment;
using Segs = std::vector<Segment>;

void empty_map_has_nothing() {
    IntervalColors m;
    CHECK(m.version_count() == 1);
    CHECK(m.segments(0).empty());
    CHECK(m.covered_length(0) == 0);
    CHECK(m.covered_length(0, -100, 100) == 0);
    CHECK(!m.color_at(0, 0).has_value());
}

void empty_range_is_noop() {
    IntervalColors m;
    auto v1 = m.paint(0, 0, 10, 1);
    // Empty and reversed ranges: no change, no new version.
    CHECK(m.paint(v1, 5, 5, 2) == v1);
    CHECK(m.paint(v1, 7, 3, 2) == v1);
    CHECK(m.paint(0, 4, 4, 9) == 0);
    CHECK(m.version_count() == 2);
    CHECK(m.segments(v1) == Segs({{0, 10, 1}}));
}

void single_paint_and_queries() {
    IntervalColors m;
    auto v1 = m.paint(0, 0, 10, 1);
    CHECK(m.segments(v1) == Segs({{0, 10, 1}}));
    CHECK(m.covered_length(v1) == 10);
    CHECK(m.covered_length(v1, 3, 7) == 4);   // inside
    CHECK(m.covered_length(v1, -5, 3) == 3);  // partial left
    CHECK(m.covered_length(v1, 8, 20) == 2);  // partial right
    CHECK(m.covered_length(v1, 10, 20) == 0); // half-open: 10 excluded
    CHECK(m.covered_length(v1, 20, 30) == 0); // disjoint
    CHECK(m.color_at(v1, 0) == 1);
    CHECK(m.color_at(v1, 9) == 1);
    CHECK(!m.color_at(v1, 10).has_value()); // half-open right end
    CHECK(!m.color_at(v1, -1).has_value());
}

void adjacent_same_color_merges() {
    IntervalColors m;
    auto v1 = m.paint(0, 0, 10, 1);
    auto v2 = m.paint(v1, 10, 20, 1); // touching, same color
    CHECK(m.segments(v2) == Segs({{0, 20, 1}}));
    CHECK(m.covered_length(v2) == 20);

    auto v3 = m.paint(v1, 10, 20, 2); // touching, different color
    CHECK(m.segments(v3) == Segs({{0, 10, 1}, {10, 20, 2}}));

    // Recoloring the second half to 1 merges the whole run again.
    auto v4 = m.paint(v3, 10, 20, 1);
    CHECK(m.segments(v4) == Segs({{0, 20, 1}}));
}

void split_segment() {
    IntervalColors m;
    auto v1 = m.paint(0, 0, 10, 1);
    auto v2 = m.paint(v1, 3, 5, 2); // punch a hole -> 3 segments
    CHECK(m.segments(v2) == Segs({{0, 3, 1}, {3, 5, 2}, {5, 10, 1}}));
    CHECK(m.covered_length(v2) == 10);
    // Painting the hole back with color 1 re-merges everything.
    auto v3 = m.paint(v2, 3, 5, 1);
    CHECK(m.segments(v3) == Segs({{0, 10, 1}}));
}

void cross_segment_overwrite() {
    IntervalColors m;
    auto v1 = m.paint(0, 0, 5, 1);
    auto v2 = m.paint(v1, 5, 10, 2);
    auto v3 = m.paint(v2, 10, 15, 3);
    CHECK(m.segments(v3) == Segs({{0, 5, 1}, {5, 10, 2}, {10, 15, 3}}));

    // One stroke across all three segments, clipping both ends.
    auto v4 = m.paint(v3, 3, 12, 9);
    CHECK(m.segments(v4) == Segs({{0, 3, 1}, {3, 12, 9}, {12, 15, 3}}));
    CHECK(m.covered_length(v4) == 15);
    CHECK(m.color_at(v4, 2) == 1);
    CHECK(m.color_at(v4, 4) == 9);
    CHECK(m.color_at(v4, 11) == 9);
    CHECK(m.color_at(v4, 13) == 3);

    // Exact-boundary stroke over the middle segment only.
    auto v5 = m.paint(v3, 5, 10, 7);
    CHECK(m.segments(v5) == Segs({{0, 5, 1}, {5, 10, 7}, {10, 15, 3}}));

    // Stroke wider than everything replaces all segments.
    auto v6 = m.paint(v3, -100, 100, 4);
    CHECK(m.segments(v6) == Segs({{{-100, 100, 4}}}));
    CHECK(m.covered_length(v6) == 200);
}

void disjoint_segments_and_gaps() {
    IntervalColors m;
    auto v1 = m.paint(0, 0, 5, 1);
    auto v2 = m.paint(v1, 20, 25, 2); // gap in between
    CHECK(m.segments(v2) == Segs({{0, 5, 1}, {20, 25, 2}}));
    CHECK(m.covered_length(v2) == 10);
    CHECK(m.covered_length(v2, 0, 25) == 10); // gap not counted
    CHECK(!m.color_at(v2, 10).has_value());
}

void branch_versions_do_not_pollute() {
    IntervalColors m;
    auto v1 = m.paint(0, 0, 10, 1);
    auto v2 = m.paint(v1, 0, 5, 2);  // branch A: recolor left half
    auto v3 = m.paint(v1, 5, 10, 3); // branch B: recolor right half

    // Both branches see their own change...
    CHECK(m.segments(v2) == Segs({{0, 5, 2}, {5, 10, 1}}));
    CHECK(m.segments(v3) == Segs({{0, 5, 1}, {5, 10, 3}}));
    // ...the shared ancestor is untouched...
    CHECK(m.segments(v1) == Segs({{0, 10, 1}}));
    CHECK(m.color_at(v1, 2) == 1);
    CHECK(m.color_at(v1, 7) == 1);
    // ...and the branches do not leak into each other.
    CHECK(m.color_at(v2, 7) == 1);
    CHECK(m.color_at(v2, 2) == 2);
    CHECK(m.color_at(v3, 2) == 1);
    CHECK(m.color_at(v3, 7) == 3);

    // Deeper branching from an old version still works and stays isolated.
    auto v4 = m.paint(v2, 2, 8, 5);
    CHECK(m.segments(v4) == Segs({{0, 2, 2}, {2, 8, 5}, {8, 10, 1}}));
    CHECK(m.segments(v2) == Segs({{0, 5, 2}, {5, 10, 1}}));
    CHECK(m.segments(v3) == Segs({{0, 5, 1}, {5, 10, 3}}));
    CHECK(m.segments(v1) == Segs({{0, 10, 1}}));
    CHECK(m.version_count() == 5);
}

void invalid_version_throws() {
    IntervalColors m;
    bool threw = false;
    try {
        m.segments(42);
    } catch (const std::out_of_range&) {
        threw = true;
    }
    CHECK(threw);
}

} // namespace

int main() {
    empty_map_has_nothing();
    empty_range_is_noop();
    single_paint_and_queries();
    adjacent_same_color_merges();
    split_segment();
    cross_segment_overwrite();
    disjoint_segments_and_gaps();
    branch_versions_do_not_pollute();
    invalid_version_throws();

    if (failures != 0) {
        std::cerr << failures << " check(s) failed\n";
        return EXIT_FAILURE;
    }
    std::cout << "all tests passed\n";
    return EXIT_SUCCESS;
}
