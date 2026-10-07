// topSegments queries: all top ids per segment, ties keep every source,
// queries outside the skyline report empty segments.
#include "skyline/skyline.hpp"
#include "check.hpp"

using namespace skyline;

int main() {
    Skyline s;
    s.add({1, 0, 10, 5});
    s.add({2, 2, 8, 5});  // same height as 1: both are sources on [2,8)
    s.add({3, 4, 6, 9});  // taller, occludes 1 and 2 on [4,6)
    s.add({4, 12, 14, 2});

    // Full-range query: ties keep all ids, taller rect wins its span.
    {
        std::vector<Segment> want = {
            {0, 2, 5, {1}},
            {2, 4, 5, {1, 2}},
            {4, 6, 9, {3}},
            {6, 8, 5, {1, 2}},
            {8, 10, 5, {1}},
            {10, 12, 0, {}},
            {12, 14, 2, {4}},
        };
        CHECK_EQ(s.topSegments(0, 14), want);
    }

    // Query entirely outside the skyline: height 0, no sources.
    {
        std::vector<Segment> want = {{20, 30, 0, {}}};
        CHECK_EQ(s.topSegments(20, 30), want);
    }

    // Query clipping: range cuts through rectangles.
    {
        std::vector<Segment> want = {
            {3, 4, 5, {1, 2}},
            {4, 6, 9, {3}},
            {6, 7, 5, {1, 2}},
        };
        CHECK_EQ(s.topSegments(3, 7), want);
    }

    // Empty / inverted query range yields nothing.
    CHECK(s.topSegments(5, 5).empty());
    CHECK(s.topSegments(9, 4).empty());

    // Negative-coordinate query across a gap.
    {
        Skyline t;
        t.add({1, -8, -2, 4});
        t.add({2, 2, 6, 4});
        std::vector<Segment> want = {
            {-10, -8, 0, {}},
            {-8, -2, 4, {1}},
            {-2, 2, 0, {}},
            {2, 6, 4, {2}},
            {6, 9, 0, {}},
        };
        CHECK_EQ(t.topSegments(-10, 9), want);
    }

    // Zero-height rects never appear as sources.
    {
        Skyline t;
        t.add({1, 0, 10, 0});
        t.add({2, 0, 10, 3});
        std::vector<Segment> want = {{0, 10, 3, {2}}};
        CHECK_EQ(t.topSegments(0, 10), want);
    }

    return 0;
}
