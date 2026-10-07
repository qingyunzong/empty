// Half-open AABB semantics: touching boundaries do not intersect,
// zero-volume boxes are empty and never intersect.
#include "spatial/aabb.hpp"
#include "test_util.hpp"

using spatial::Aabb2;

int main() {
    Aabb2 unit{{0.0, 0.0}, {1.0, 1.0}};

    // Overlapping boxes intersect.
    CHECK(unit.intersects(Aabb2{{0.5, 0.5}, {1.5, 1.5}}));
    CHECK(Aabb2{{0.5, 0.5}, {1.5, 1.5}}.intersects(unit));
    // Containment intersects.
    CHECK(unit.intersects(Aabb2{{0.25, 0.25}, {0.75, 0.75}}));
    CHECK(unit.intersects(Aabb2{{-1.0, -1.0}, {2.0, 2.0}}));

    // Touching on an edge (max == min) does NOT intersect: [0,1) vs [1,2).
    CHECK(!unit.intersects(Aabb2{{1.0, 0.0}, {2.0, 1.0}}));
    CHECK(!unit.intersects(Aabb2{{-1.0, 0.0}, {0.0, 1.0}}));
    CHECK(!unit.intersects(Aabb2{{0.0, 1.0}, {1.0, 2.0}}));
    CHECK(!unit.intersects(Aabb2{{0.0, -1.0}, {1.0, 0.0}}));

    // Touching at a single corner point does NOT intersect.
    CHECK(!unit.intersects(Aabb2{{1.0, 1.0}, {2.0, 2.0}}));
    CHECK(!unit.intersects(Aabb2{{-1.0, -1.0}, {0.0, 0.0}}));

    // Clearly disjoint.
    CHECK(!unit.intersects(Aabb2{{2.0, 2.0}, {3.0, 3.0}}));

    // Zero-volume boxes are empty and intersect nothing, not even themselves.
    Aabb2 flat{{0.5, 0.5}, {0.5, 2.0}};   // zero width
    Aabb2 point{{0.5, 0.5}, {0.5, 0.5}};  // zero width and height
    Aabb2 inverted{{1.0, 0.0}, {0.0, 1.0}};
    CHECK(flat.empty() && point.empty() && inverted.empty());
    CHECK(!unit.empty());
    CHECK(!flat.intersects(unit));
    CHECK(!unit.intersects(flat));
    CHECK(!point.intersects(point));
    CHECK(!inverted.intersects(unit));

    // A box just inside the boundary still intersects.
    CHECK(unit.intersects(Aabb2{{0.999999, 0.0}, {2.0, 1.0}}));

    return test::summary("test_aabb");
}
