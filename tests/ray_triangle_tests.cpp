#include "geom/ray_triangle.hpp"

#include <cstdlib>
#include <iostream>

using geom::Hit;
using geom::Rational;
using geom::Ray;
using geom::Triangle;
using geom::Vec3;

static int failures = 0;

#define CHECK(cond)                                                            \
    do {                                                                       \
        if (!(cond)) {                                                         \
            std::cerr << "FAIL " << __FILE__ << ":" << __LINE__ << ": "        \
                      << #cond << "\n";                                        \
            ++failures;                                                        \
        }                                                                      \
    } while (0)

static Vec3 v(std::int64_t x, std::int64_t y, std::int64_t z) {
    return {Rational(x), Rational(y), Rational(z)};
}
static Vec3 v(std::int64_t x, std::int64_t y, std::int64_t z, std::int64_t d) {
    return {Rational(x, d), Rational(y, d), Rational(z, d)};
}

static void expect_none(const Hit& h, const char* name) {
    if (h.kind != Hit::Kind::None) {
        std::cerr << "FAIL " << name << ": expected no hit\n";
        ++failures;
    }
}

static void expect_point(const Hit& h, std::int64_t n, std::int64_t d,
                         const char* name) {
    const Rational want(n, d);
    if (h.kind != Hit::Kind::Point || h.t != want) {
        std::cerr << "FAIL " << name << ": expected point t=" << want.to_string()
                  << "\n";
        ++failures;
        return;
    }
    // parameters must be non-negative and fully reduced
    CHECK(h.t >= Rational(0));
    CHECK(std::gcd(h.t.num(), h.t.den()) == 1);
    CHECK(h.t.den() > 0);
}

static void expect_interval(const Hit& h, std::int64_t n0, std::int64_t d0,
                            std::int64_t n1, std::int64_t d1,
                            const char* name) {
    const Rational lo(n0, d0), hi(n1, d1);
    if (h.kind != Hit::Kind::Interval || h.lo != lo || h.hi != hi) {
        std::cerr << "FAIL " << name << ": expected interval [" << lo.to_string()
                  << ", " << hi.to_string() << "]\n";
        ++failures;
        return;
    }
    CHECK(h.lo >= Rational(0));
    CHECK(h.lo <= h.hi);
    CHECK(std::gcd(h.lo.num(), h.lo.den()) == 1);
    CHECK(std::gcd(h.hi.num(), h.hi.den()) == 1);
}

int main() {
    // ---- Rational arithmetic ----
    CHECK(Rational(2, 4) == Rational(1, 2));
    CHECK(Rational(3, -6) == Rational(-1, 2));
    CHECK(Rational(-2, -8) == Rational(1, 4));
    CHECK(Rational(1, 2) + Rational(1, 3) == Rational(5, 6));
    CHECK(Rational(3, 4) * Rational(8, 9) == Rational(2, 3));
    CHECK(Rational(1, 2) / Rational(3, 4) == Rational(2, 3));
    CHECK(Rational(7, 3) > Rational(2));
    CHECK(Rational(-1, 3) < Rational(0));

    const Triangle tri{v(0, 0, 0), v(2, 0, 0), v(0, 2, 0)};

    // ---- Non-degenerate triangle ----
    // Interior hit, t = 2/4 must come out reduced as 1/2.
    expect_point(geom::ray_triangle_intersect(
                     Ray{v(1, 1, 4, 2), v(0, 0, -4)}, tri),
                 1, 2, "interior reduced");

    // Hit exactly on vertex (0,0,0): boundary counts.
    expect_point(geom::ray_triangle_intersect(Ray{v(0, 0, 3), v(0, 0, -6)}, tri),
                 1, 2, "vertex hit");

    // Hit exactly on edge midpoint (1,0,0).
    expect_point(geom::ray_triangle_intersect(Ray{v(1, 0, 1), v(0, 0, -2)}, tri),
                 1, 2, "edge hit");

    // Hit exactly on hypotenuse x+y=2.
    expect_point(geom::ray_triangle_intersect(Ray{v(1, 1, 4), v(0, 0, -8)}, tri),
                 1, 2, "hypotenuse hit");

    // Outside the triangle (u+v > 1).
    expect_none(geom::ray_triangle_intersect(Ray{v(2, 2, 1), v(0, 0, -1)}, tri),
                "outside miss");

    // Intersection behind the ray origin (t < 0) must be rejected.
    expect_none(geom::ray_triangle_intersect(Ray{v(1, 1, -1, 2), v(0, 0, -1)}, tri),
                "behind miss");

    // ---- Parallel rays ----
    // Parallel to the plane, offset above it: no hit.
    expect_none(geom::ray_triangle_intersect(Ray{v(0, 0, 1), v(1, 0, 0)}, tri),
                "parallel offset");

    // Coplanar ray crossing the triangle: parameter interval.
    // Triangle (0,0),(4,0),(0,4) in z=0; ray from (-1, 1/2) along +x with
    // |d|=2: enters at x=0 -> t=1/2, exits at x=7/2 -> t=9/4.
    const Triangle big{v(0, 0, 0), v(4, 0, 0), v(0, 4, 0)};
    expect_interval(geom::ray_triangle_intersect(Ray{v(-2, 1, 0, 2), v(2, 0, 0)}, big),
                    1, 2, 9, 4, "coplanar interval");

    // Coplanar ray missing the triangle entirely.
    expect_none(geom::ray_triangle_intersect(Ray{v(-1, 5, 0), v(1, 0, 0)}, big),
                "coplanar miss");

    // Coplanar ray starting inside the triangle: interval starts at 0.
    expect_interval(geom::ray_triangle_intersect(Ray{v(1, 1, 0), v(0, 2, 0)}, big),
                    0, 1, 1, 1, "coplanar from inside");

    // ---- Degenerate triangle: segment ----
    const Triangle seg{v(0, 0, 0), v(2, 0, 0), v(2, 0, 0)};

    // Ray crossing the segment at (1,0,0).
    expect_point(geom::ray_triangle_intersect(Ray{v(1, -1, 0), v(0, 2, 0)}, seg),
                 1, 2, "segment hit");

    // Ray collinear with the segment: overlap interval [3/2, 5/2].
    expect_interval(geom::ray_triangle_intersect(Ray{v(-3, 0, 0), v(2, 0, 0)}, seg),
                    3, 2, 5, 2, "segment collinear interval");

    // Ray skew to the segment: no hit.
    expect_none(geom::ray_triangle_intersect(Ray{v(1, 0, 1), v(0, 1, 0)}, seg),
                "segment skew miss");

    // Ray parallel but offset from the segment: no hit.
    expect_none(geom::ray_triangle_intersect(Ray{v(0, 1, 0), v(1, 0, 0)}, seg),
                "segment parallel miss");

    // Collinear overlap ending behind the origin: no hit.
    expect_none(geom::ray_triangle_intersect(Ray{v(3, 0, 0), v(1, 0, 0)}, seg),
                "segment behind miss");

    // ---- Degenerate triangle: point ----
    const Triangle dot{v(1, 1, 1), v(1, 1, 1), v(1, 1, 1)};
    expect_point(geom::ray_triangle_intersect(Ray{v(1, 1, 5), v(0, 0, -2)}, dot),
                 2, 1, "point hit");
    expect_none(geom::ray_triangle_intersect(Ray{v(2, 1, 5), v(0, 0, -2)}, dot),
                "point miss");
    expect_none(geom::ray_triangle_intersect(Ray{v(1, 1, -5), v(0, 0, -2)}, dot),
                "point behind miss");

    // ---- Zero-direction ray (degenerate ray) ----
    expect_point(geom::ray_triangle_intersect(Ray{v(1, 1, 0, 2), v(0, 0, 0)}, tri),
                 0, 1, "zero dir inside");
    expect_none(geom::ray_triangle_intersect(Ray{v(3, 3, 0), v(0, 0, 0)}, tri),
                "zero dir outside");

    if (failures != 0) {
        std::cerr << failures << " failure(s)\n";
        return EXIT_FAILURE;
    }
    std::cout << "all tests passed\n";
    return EXIT_SUCCESS;
}
