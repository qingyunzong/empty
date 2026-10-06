#include "geom/geometry.hpp"

#include <iostream>

using namespace geom;

static int failures = 0;

#define CHECK(cond)                                                                            \
    do {                                                                                       \
        if (!(cond)) {                                                                         \
            std::cerr << "FAIL " << __FILE__ << ":" << __LINE__ << ": " #cond "\n";            \
            ++failures;                                                                        \
        }                                                                                      \
    } while (0)

static void test_rational_basics() {
    Rational r(6, 8);
    CHECK(r.num() == 3 && r.den() == 4);          // reduced
    CHECK(Rational(2, -6) == Rational(-1, 3));    // sign normalized
    CHECK(Rational(1, 2) + Rational(1, 3) == Rational(5, 6));
    CHECK(Rational(3, 4) * Rational(8, 9) == Rational(2, 3));
    CHECK(Rational(1, 2) / Rational(3, 4) == Rational(2, 3));
    CHECK(Rational(1, 3) < Rational(1, 2));
    CHECK(Rational(-7, 2).to_string() == "-7/2");
}

static void test_transversal_hits() {
    const Vec3 A{0, 0, 0}, B{1, 0, 0}, C{0, 1, 0};

    // Interior hit; parameter must be reduced (2/4 -> 1/2).
    Hit h = intersect_ray_triangle({{Rational(1, 4), Rational(1, 4), 2}, {0, 0, -4}}, A, B, C);
    CHECK(h.hit && h.t0 == Rational(1, 2) && h.t0 == h.t1);

    // Slanted ray through the interior.
    h = intersect_ray_triangle({{0, 0, 1}, {Rational(1, 4), Rational(1, 4), -1}}, A, B, C);
    CHECK(h.hit && h.t0 == 1 && h.t1 == 1);

    // Boundary: exact vertex hit counts.
    h = intersect_ray_triangle({{0, 0, 1}, {0, 0, -1}}, A, B, C);
    CHECK(h.hit && h.t0 == 1 && h.t1 == 1);

    // Boundary: exact edge hit counts.
    h = intersect_ray_triangle({{Rational(1, 2), 0, 3}, {0, 0, -1}}, A, B, C);
    CHECK(h.hit && h.t0 == 3);

    // Miss: intersection point outside the triangle.
    h = intersect_ray_triangle({{2, 2, 1}, {0, 0, -1}}, A, B, C);
    CHECK(!h.hit);

    // Miss: triangle behind the ray (negative parameter rejected).
    h = intersect_ray_triangle({{Rational(1, 4), Rational(1, 4), 1}, {0, 0, 1}}, A, B, C);
    CHECK(!h.hit);

    // Miss: ray parallel to the plane, offset from it.
    h = intersect_ray_triangle({{0, 0, 1}, {1, 0, 0}}, A, B, C);
    CHECK(!h.hit);

    // Non-axis-aligned plane, fractional reduced parameter.
    const Vec3 T1{1, 1, 1}, T2{3, 1, 1}, T3{1, 3, 1};
    h = intersect_ray_triangle({{Rational(3, 2), Rational(3, 2), 5}, {0, 0, -2}}, T1, T2, T3);
    CHECK(h.hit && h.t0 == 2 && h.t1 == 2);
}

static void test_coplanar_cases() {
    const Vec3 A{0, 0, 0}, B{1, 0, 0}, C{0, 1, 0};

    // Ray in the plane crossing the triangle: full parameter interval.
    Hit h = intersect_ray_triangle({{-1, Rational(1, 4), 0}, {1, 0, 0}}, A, B, C);
    CHECK(h.hit && h.interval() && h.t0 == 1 && h.t1 == Rational(7, 4));

    // Ray starting inside the triangle: interval begins at t = 0.
    h = intersect_ray_triangle({{Rational(1, 4), Rational(1, 4), 0}, {1, 0, 0}}, A, B, C);
    CHECK(h.hit && h.t0 == 0 && h.t1 == Rational(1, 2));

    // Ray grazing exactly one vertex: degenerate interval [1, 1].
    h = intersect_ray_triangle({{-1, 1, 0}, {1, -1, 0}}, A, B, C);
    CHECK(h.hit && h.t0 == 1 && h.t1 == 1);

    // Coplanar ray missing the triangle entirely.
    h = intersect_ray_triangle({{-1, 2, 0}, {1, 0, 0}}, A, B, C);
    CHECK(!h.hit);

    // Coplanar ray pointing away from the triangle.
    h = intersect_ray_triangle({{-1, Rational(1, 4), 0}, {-1, 0, 0}}, A, B, C);
    CHECK(!h.hit);
}

static void test_degenerate_triangles() {
    // Point triangle (all vertices equal): hit.
    const Vec3 P{1, 1, 1};
    Hit h = intersect_ray_triangle({{0, 0, 0}, {2, 2, 2}}, P, P, P);
    CHECK(h.hit && h.t0 == Rational(1, 2) && h.t1 == Rational(1, 2));

    // Point triangle: miss.
    h = intersect_ray_triangle({{0, 0, 0}, {1, 0, 0}}, P, P, P);
    CHECK(!h.hit);

    // Segment triangle (two distinct vertices): transversal hit.
    const Vec3 S0{0, 0, 0}, S1{2, 0, 0};
    h = intersect_ray_triangle({{1, -1, 0}, {0, 1, 0}}, S0, S1, S0);
    CHECK(h.hit && h.t0 == 1 && h.t1 == 1);

    // Collinear triangle (three distinct vertices): collinear ray overlap.
    const Vec3 D0{0, 0, 0}, D1{2, 0, 0}, D2{1, 0, 0};
    h = intersect_ray_triangle({{-1, 0, 0}, {1, 0, 0}}, D0, D1, D2);
    CHECK(h.hit && h.interval() && h.t0 == 1 && h.t1 == 3);

    // Collinear triangle: parallel offset ray misses.
    h = intersect_ray_triangle({{-1, 1, 0}, {1, 0, 0}}, D0, D1, D2);
    CHECK(!h.hit);

    // Segment triangle: skew ray misses.
    h = intersect_ray_triangle({{1, -1, 1}, {0, 1, 0}}, S0, S1, S0);
    CHECK(!h.hit);

    // Segment triangle: overlap clipped to t >= 0 (origin inside segment line).
    h = intersect_ray_triangle({{1, 0, 0}, {1, 0, 0}}, S0, S1, S1);
    CHECK(h.hit && h.t0 == 0 && h.t1 == 1);
}

int main() {
    test_rational_basics();
    test_transversal_hits();
    test_coplanar_cases();
    test_degenerate_triangles();

    if (failures == 0) {
        std::cout << "All tests passed\n";
        return 0;
    }
    std::cerr << failures << " check(s) failed\n";
    return 1;
}
