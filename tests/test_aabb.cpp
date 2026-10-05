#include "spatial/aabb.hpp"

#include "test_framework.hpp"

using spatial::Box;
using spatial::contains;
using spatial::intersects;

TF_TEST(half_open_touching_boundaries_do_not_intersect) {
    Box<2> a{{0, 0}, {1, 1}};
    Box<2> right{{1, 0}, {2, 1}};        // shares face x == 1
    Box<2> top{{0, 1}, {1, 2}};          // shares face y == 1
    Box<2> corner{{1, 1}, {2, 2}};       // touches at one corner point
    Box<2> edge{{1, 0.25}, {2, 0.75}};   // touches on x, overlaps on y
    Box<2> overlap{{0.5, 0.5}, {1.5, 1.5}};
    Box<2> inside{{0.25, 0.25}, {0.75, 0.75}};

    CHECK(!intersects(a, right));
    CHECK(!intersects(right, a));
    CHECK(!intersects(a, top));
    CHECK(!intersects(a, corner));
    CHECK(!intersects(a, edge));
    CHECK(!intersects(edge, a));

    CHECK(intersects(a, overlap));
    CHECK(intersects(overlap, a));
    CHECK(intersects(a, inside));
    CHECK(intersects(inside, a));
    CHECK(intersects(a, a));  // identical non-empty boxes intersect
}

TF_TEST(contains_point_is_half_open) {
    Box<2> a{{0, 0}, {2, 2}};
    CHECK(contains(a, {0, 0}));        // min edge inclusive
    CHECK(contains(a, {1.999, 0}));
    CHECK(!contains(a, {2, 0}));       // max edge exclusive
    CHECK(!contains(a, {0, 2}));
    CHECK(!contains(a, {-0.001, 1}));
    CHECK(!contains(a, {1, 2.5}));
}

TF_TEST(zero_volume_boxes_are_empty_and_never_intersect) {
    Box<2> point{{1, 1}, {1, 1}};
    Box<2> line{{0, 0}, {2, 0}};
    Box<2> inverted{{2, 2}, {1, 1}};
    Box<2> a{{0, 0}, {2, 2}};

    CHECK(point.empty());
    CHECK(line.empty());
    CHECK(inverted.empty());
    CHECK(!a.empty());

    CHECK(!intersects(a, point));
    CHECK(!intersects(point, a));
    CHECK(!intersects(a, line));
    CHECK(!intersects(point, line));
    CHECK(!contains(point, {1, 1}));
}

TF_TEST(three_dimensional_semantics) {
    Box<3> a{{0, 0, 0}, {1, 1, 1}};
    Box<3> touch{{1, 0, 0}, {2, 1, 1}};
    Box<3> overlap{{0.5, 0.5, 0.5}, {2, 2, 2}};
    Box<3> flat{{0, 0, 0}, {1, 1, 0}};  // zero thickness in z

    CHECK(!intersects(a, touch));
    CHECK(intersects(a, overlap));
    CHECK(flat.empty());
    CHECK(!intersects(a, flat));
    CHECK(contains(a, {0.5, 0.5, 0.5}));
    CHECK(!contains(a, {0.5, 0.5, 1.0}));
}

TF_MAIN()
