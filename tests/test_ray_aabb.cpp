#include "test_util.hpp"

using namespace spatial;

static Aabb unitBox() { return Aabb{{0, 0, 0}, {10, 10, 10}}; }

int main() {
    const Aabb box = unitBox();

    // Straight hit through the box.
    {
        RayHit h = rayAabbIntersect(Ray{{-5, 5, 5}, {1, 0, 0}}, box);
        CHECK(h.hit);
        CHECK(compare(h.tEnter, makeRational(5, 1)) == 0);
        CHECK(compare(h.tExit, makeRational(15, 1)) == 0);
    }
    // Grazing the face y == 10: boundary contact counts as a hit.
    {
        RayHit h = rayAabbIntersect(Ray{{-5, 10, 5}, {1, 0, 0}}, box);
        CHECK(h.hit);
        CHECK(compare(h.tEnter, makeRational(5, 1)) == 0);
        CHECK(compare(h.tExit, makeRational(15, 1)) == 0);
    }
    // Diagonal through the box: enters at corner (0,0,0), exits at (10,10,10).
    {
        RayHit h = rayAabbIntersect(Ray{{-1, -1, -1}, {1, 1, 1}}, box);
        CHECK(h.hit);
        CHECK(compare(h.tEnter, makeRational(1, 1)) == 0);
        CHECK(compare(h.tExit, makeRational(11, 1)) == 0);
    }
    // Single-point contact on a box edge: entry and exit intervals meet at
    // exactly t = 1. Boundary-inclusive, so this counts as a hit.
    {
        RayHit h = rayAabbIntersect(Ray{{-1, -1, -1}, {1, 1, 3}},
                                    Aabb{{0, 0, 0}, {10, 10, 2}});
        CHECK(h.hit);
        CHECK(compare(h.tEnter, makeRational(1, 1)) == 0);
        CHECK(compare(h.tExit, makeRational(1, 1)) == 0);
    }
    // Near miss by one unit: y-slab entry (t=12) is one past x-slab exit
    // (t=11), so the slabs never overlap.
    {
        RayHit h = rayAabbIntersect(Ray{{-1, -12, -1}, {1, 1, 1}}, box);
        CHECK(!h.hit);
    }
    // Exact rational parameter: tEnter = 3/2, not a float approximation.
    {
        RayHit h = rayAabbIntersect(Ray{{-3, 5, 5}, {2, 0, 0}}, box);
        CHECK(h.hit);
        CHECK(compare(h.tEnter, makeRational(3, 2)) == 0);
        CHECK(compare(h.tExit, makeRational(13, 2)) == 0);
    }
    // Zero-direction component inside the slab.
    {
        RayHit h = rayAabbIntersect(Ray{{5, 5, -3}, {0, 0, 2}}, box);
        CHECK(h.hit);
        CHECK(compare(h.tEnter, makeRational(3, 2)) == 0);
        CHECK(compare(h.tExit, makeRational(13, 2)) == 0);
    }
    // Zero-direction component outside the slab: miss regardless of other axes.
    {
        RayHit h = rayAabbIntersect(Ray{{5, 11, 5}, {1, 0, 0}}, box);
        CHECK(!h.hit);
    }
    // Box entirely behind the ray.
    {
        CHECK(!rayAabbIntersect(Ray{{20, 5, 5}, {1, 0, 0}}, box).hit);
        RayHit h = rayAabbIntersect(Ray{{20, 5, 5}, {-1, 0, 0}}, box);
        CHECK(h.hit);
        CHECK(compare(h.tEnter, makeRational(10, 1)) == 0);
    }
    // Origin inside the box: tEnter clamps to 0.
    {
        RayHit h = rayAabbIntersect(Ray{{5, 5, 5}, {1, 1, 1}}, box);
        CHECK(h.hit);
        CHECK(compare(h.tEnter, makeRational(0, 1)) == 0);
        CHECK(compare(h.tExit, makeRational(5, 1)) == 0);
    }
    // Degenerate ray (zero direction): hit iff origin inside, inclusive.
    {
        CHECK(rayAabbIntersect(Ray{{10, 10, 10}, {0, 0, 0}}, box).hit);
        CHECK(!rayAabbIntersect(Ray{{11, 5, 5}, {0, 0, 0}}, box).hit);
    }
    // Two slabs whose intervals meet at exactly one rational point.
    {
        RayHit h = rayAabbIntersect(Ray{{0, 0, 5}, {3, 2, 0}},
                                    Aabb{{3, 2, 0}, {30, 20, 10}});
        CHECK(h.hit);
        CHECK(compare(h.tEnter, makeRational(1, 1)) == 0);
    }
    // Huge coordinates: t = 10^18 / 3 exactly.
    {
        RayHit h = rayAabbIntersect(Ray{{0, 0, 0}, {3, 0, 0}},
                                    Aabb{{1000000000000000000LL, -1, -1},
                                         {1000000000000000005LL, 1, 1}});
        CHECK(h.hit);
        CHECK(compare(h.tEnter, makeRational(1000000000000000000LL, 3)) == 0);
    }

    std::puts("test_ray_aabb: OK");
    return 0;
}
