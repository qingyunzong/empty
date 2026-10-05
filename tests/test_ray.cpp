#include <cstdint>

#include "../tests/check.hpp"
#include "spatial/aabb.hpp"

using spatial::Aabb;
using spatial::Ray;
using spatial::RayBoxHit;
using spatial::make_rational;
using spatial::ray_intersect;

static const spatial::Rational kInf = make_rational(INT64_C(1) << 60, 1);

static Aabb unit_box(std::int64_t lo, std::int64_t hi) {
  return {{lo, lo, lo}, {hi, hi, hi}};
}

int main() {
  const Aabb box = unit_box(0, 10);

  // Straight hit along +x through the box center.
  {
    RayBoxHit h = ray_intersect(box, Ray{{-5, 5, 5}, {1, 0, 0}}, kInf);
    CHECK(h.hit);
    CHECK(h.t_enter == make_rational(5, 1));
    CHECK(h.t_exit == make_rational(15, 1));
  }
  // Origin on the boundary face (y == hi) is inclusive -> hit at t = 0..10.
  {
    RayBoxHit h = ray_intersect(box, Ray{{-5, 10, 5}, {1, 0, 0}}, kInf);
    CHECK(h.hit);
    CHECK(h.t_enter == make_rational(5, 1));
  }
  // One unit outside the boundary -> miss.
  {
    RayBoxHit h = ray_intersect(box, Ray{{-5, 11, 5}, {1, 0, 0}}, kInf);
    CHECK(!h.hit);
  }
  // Grazing the top-back edge (y = z = 10): touch counts as hit.
  {
    RayBoxHit h = ray_intersect(box, Ray{{-5, 10, 10}, {1, 0, 0}}, kInf);
    CHECK(h.hit);
    CHECK(h.t_enter == make_rational(5, 1));
    CHECK(h.t_exit == make_rational(15, 1));
  }
  // Pure corner touch: ray passes through corner (10,10,10) only.
  {
    RayBoxHit h = ray_intersect(box, Ray{{0, 0, 20}, {1, 1, -1}}, kInf);
    CHECK(h.hit);
    CHECK(h.t_enter == make_rational(10, 1));
    CHECK(h.t_exit == make_rational(10, 1));
  }
  // Diagonal ray passing just above the box -> miss.
  {
    RayBoxHit h = ray_intersect(box, Ray{{0, 0, 11}, {1, 1, 1}}, kInf);
    CHECK(!h.hit);
  }
  // Exact rational t: dir (3,0,0) against slab x in [1,2].
  {
    RayBoxHit h = ray_intersect(unit_box(1, 2), Ray{{0, 1, 1}, {3, 0, 0}},
                                kInf);
    CHECK(h.hit);
    CHECK(h.t_enter == make_rational(1, 3));
    CHECK(h.t_exit == make_rational(2, 3));
  }
  // Negative direction: symmetric fractions.
  {
    RayBoxHit h = ray_intersect(box, Ray{{15, 5, 5}, {-2, 0, 0}}, kInf);
    CHECK(h.hit);
    CHECK(h.t_enter == make_rational(5, 2));
    CHECK(h.t_exit == make_rational(15, 2));
  }
  // Ray parallel to a slab, outside it -> miss; on its plane -> hit.
  {
    CHECK(!ray_intersect(box, Ray{{0, 11, 5}, {1, 0, 0}}, kInf).hit);
    RayBoxHit h = ray_intersect(box, Ray{{0, 10, 5}, {1, 0, 0}}, kInf);
    CHECK(h.hit);
    CHECK(h.t_enter == make_rational(0, 1));
  }
  // t_max clipping: beyond range -> miss; inside range -> clipped exit.
  {
    CHECK(!ray_intersect(box, Ray{{-5, 5, 5}, {1, 0, 0}},
                         make_rational(4, 1))
               .hit);
    RayBoxHit h = ray_intersect(box, Ray{{-5, 5, 5}, {1, 0, 0}},
                                make_rational(6, 1));
    CHECK(h.hit);
    CHECK(h.t_enter == make_rational(5, 1));
    CHECK(h.t_exit == make_rational(6, 1));
  }
  // Ray starting inside the box: t_enter clamps to 0.
  {
    RayBoxHit h = ray_intersect(box, Ray{{5, 5, 5}, {0, 1, 0}}, kInf);
    CHECK(h.hit);
    CHECK(h.t_enter == make_rational(0, 1));
    CHECK(h.t_exit == make_rational(5, 1));
  }
  return testutil::finish("test_ray");
}
