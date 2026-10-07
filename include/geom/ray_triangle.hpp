#pragma once

#include "geom/vec3.hpp"

namespace geom {

struct Ray {
    Vec3 origin;
    Vec3 dir; // point on ray: origin + t * dir, t >= 0
};

struct Triangle {
    Vec3 a, b, c;
};

// Result of a ray/triangle intersection query.
//   None     - no hit with t >= 0
//   Point    - single hit at parameter t
//   Interval - ray overlaps the triangle over [lo, hi] (coplanar ray or
//              ray collinear with a degenerate segment triangle)
struct Hit {
    enum class Kind { None, Point, Interval };

    Kind kind = Kind::None;
    Rational t;      // valid when kind == Point
    Rational lo, hi; // valid when kind == Interval, 0 <= lo <= hi

    static Hit none() { return {}; }
    static Hit point(const Rational& t) {
        Hit h;
        h.kind = Kind::Point;
        h.t = t;
        return h;
    }
    static Hit interval(const Rational& lo, const Rational& hi) {
        Hit h;
        h.kind = Kind::Interval;
        h.lo = lo;
        h.hi = hi;
        return h;
    }
};

namespace detail {

// Ratio v[i]/d[i] along the dominant axis of d (d must be non-zero).
inline Rational project_ratio(const Vec3& v, const Vec3& d) {
    const int axis = dominant_axis(d);
    return component(v, axis) / component(d, axis);
}

// Ray vs single point.
inline Hit ray_point(const Ray& ray, const Vec3& p) {
    if (is_zero(ray.dir)) {
        return ray.origin == p ? Hit::point(Rational(0)) : Hit::none();
    }
    const Rational t = project_ratio(p - ray.origin, ray.dir);
    if (t < 0) return Hit::none();
    if (ray.origin + ray.dir * t != p) return Hit::none();
    return Hit::point(t);
}

// Ray vs segment [a, b] (a != b) in 3D.
inline Hit ray_segment(const Ray& ray, const Vec3& a, const Vec3& b) {
    const Vec3 s = b - a;
    const Vec3 w = a - ray.origin;
    const Vec3 c = cross(ray.dir, s);

    if (!is_zero(c)) {
        // Not parallel: candidate t from the closest-point relation, then
        // verify the point lies exactly on the segment (rejects skew lines).
        const Rational t = dot(cross(w, s), c) / dot(c, c);
        if (t < 0) return Hit::none();
        const Vec3 p = ray.origin + ray.dir * t;
        const Rational u = project_ratio(p - a, s);
        if (u < 0 || u > 1) return Hit::none();
        if (a + s * u != p) return Hit::none();
        return Hit::point(t);
    }

    // Parallel: only collinear rays can hit.
    if (!is_zero(cross(w, ray.dir))) return Hit::none();
    if (is_zero(ray.dir)) {
        // Degenerate ray (a point) on the segment line.
        const Rational u = project_ratio(ray.origin - a, s);
        return (u >= 0 && u <= 1) ? Hit::point(Rational(0)) : Hit::none();
    }
    Rational t0 = project_ratio(a - ray.origin, ray.dir);
    Rational t1 = project_ratio(b - ray.origin, ray.dir);
    if (t1 < t0) {
        const Rational tmp = t0;
        t0 = t1;
        t1 = tmp;
    }
    if (t0 < 0) t0 = Rational(0);
    if (t0 > t1) return Hit::none();
    if (t0 == t1) return Hit::point(t0);
    return Hit::interval(t0, t1);
}

// Point-in-triangle test (boundary included), any degeneracy.
inline bool point_in_triangle(const Vec3& p, const Triangle& tri) {
    const Vec3 e1 = tri.b - tri.a;
    const Vec3 e2 = tri.c - tri.a;
    const Vec3 n = cross(e1, e2);
    if (is_zero(n)) {
        // Degenerate: farthest vertex pair spans the segment (or point).
        const Vec3 pts[3] = {tri.a, tri.b, tri.c};
        int pi = 0, pj = 0;
        Rational best(0);
        for (int i = 0; i < 3; ++i)
            for (int j = i + 1; j < 3; ++j) {
                const Vec3 d = pts[j] - pts[i];
                const Rational d2 = dot(d, d);
                if (d2 > best) {
                    best = d2;
                    pi = i;
                    pj = j;
                }
            }
        if (best == 0) return p == tri.a;
        const Vec3 s = pts[pj] - pts[pi];
        if (!is_zero(cross(p - pts[pi], s))) return false;
        const Rational u = project_ratio(p - pts[pi], s);
        return u >= 0 && u <= 1;
    }
    if (dot(p - tri.a, n) != 0) return false;
    const Rational s1 = dot(cross(tri.b - tri.a, p - tri.a), n);
    const Rational s2 = dot(cross(tri.c - tri.b, p - tri.b), n);
    const Rational s3 = dot(cross(tri.a - tri.c, p - tri.c), n);
    return s1 >= 0 && s2 >= 0 && s3 >= 0;
}

// Coplanar ray vs non-degenerate triangle: clip t against the three edge
// half-planes after projecting to 2D along the normal's dominant axis.
inline Hit coplanar_interval(const Ray& ray, const Triangle& tri, const Vec3& n) {
    const int drop = dominant_axis(n);
    const int ax0 = (drop + 1) % 3;
    const int ax1 = (drop + 2) % 3;

    Rational px[3] = {component(tri.a, ax0), component(tri.b, ax0), component(tri.c, ax0)};
    Rational py[3] = {component(tri.a, ax1), component(tri.b, ax1), component(tri.c, ax1)};

    const Rational area = (px[1] - px[0]) * (py[2] - py[0]) -
                          (px[2] - px[0]) * (py[1] - py[0]);
    if (area < 0) { // enforce counter-clockwise so interior is left of edges
        const Rational tx = px[1], ty = py[1];
        px[1] = px[2];
        py[1] = py[2];
        px[2] = tx;
        py[2] = ty;
    }

    const Rational ox = component(ray.origin, ax0);
    const Rational oy = component(ray.origin, ax1);
    const Rational dx = component(ray.dir, ax0);
    const Rational dy = component(ray.dir, ax1);

    Rational lo(0), hi(0);
    bool has_hi = false;
    for (int i = 0; i < 3; ++i) {
        const int j = (i + 1) % 3;
        const Rational ex = px[j] - px[i];
        const Rational ey = py[j] - py[i];
        // Inside test: cross2(e, origin + t*dir - p) = c + t*k >= 0.
        const Rational k = ex * dy - ey * dx;
        const Rational c = ex * (oy - py[i]) - ey * (ox - px[i]);
        if (k > 0) {
            const Rational bound = -c / k;
            if (bound > lo) lo = bound;
        } else if (k < 0) {
            const Rational bound = -c / k;
            if (!has_hi || bound < hi) {
                hi = bound;
                has_hi = true;
            }
        } else if (c < 0) {
            return Hit::none(); // ray line parallel to and outside this edge
        }
    }
    if (!has_hi) { // zero-direction ray inside the triangle
        return Hit::point(Rational(0));
    }
    if (lo > hi) return Hit::none();
    if (lo == hi) return Hit::point(lo);
    return Hit::interval(lo, hi);
}

} // namespace detail

// Exact ray/triangle intersection. Boundary hits count. The triangle may be
// degenerate (collinear or coincident vertices), in which case it is treated
// as a segment or a point. All returned parameters are >= 0 and reduced.
inline Hit ray_triangle_intersect(const Ray& ray, const Triangle& tri) {
    const Vec3 e1 = tri.b - tri.a;
    const Vec3 e2 = tri.c - tri.a;
    const Vec3 n = cross(e1, e2);

    if (is_zero(ray.dir)) {
        return detail::point_in_triangle(ray.origin, tri) ? Hit::point(Rational(0))
                                                          : Hit::none();
    }

    if (is_zero(n)) {
        // Degenerate triangle: farthest vertex pair spans the covered segment.
        const Vec3 pts[3] = {tri.a, tri.b, tri.c};
        int pi = 0, pj = 0;
        Rational best(0);
        for (int i = 0; i < 3; ++i)
            for (int j = i + 1; j < 3; ++j) {
                const Vec3 d = pts[j] - pts[i];
                const Rational d2 = dot(d, d);
                if (d2 > best) {
                    best = d2;
                    pi = i;
                    pj = j;
                }
            }
        if (best == 0) return detail::ray_point(ray, tri.a);
        return detail::ray_segment(ray, pts[pi], pts[pj]);
    }

    const Rational dn = dot(ray.dir, n);
    if (dn == 0) {
        if (dot(ray.origin - tri.a, n) != 0) return Hit::none(); // parallel
        return detail::coplanar_interval(ray, tri, n);
    }

    // Moeller-Trumbore with exact rational arithmetic.
    const Vec3 p = cross(ray.dir, e2);
    const Rational det = dot(e1, p);
    const Vec3 tv = ray.origin - tri.a;
    const Rational u = dot(tv, p) / det;
    if (u < 0 || u > 1) return Hit::none();
    const Vec3 q = cross(tv, e1);
    const Rational v = dot(ray.dir, q) / det;
    if (v < 0 || u + v > 1) return Hit::none();
    const Rational t = dot(e2, q) / det;
    if (t < 0) return Hit::none();
    return Hit::point(t);
}

} // namespace geom
