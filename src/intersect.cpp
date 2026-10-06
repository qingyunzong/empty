#include "geom/geometry.hpp"

#include <algorithm>
#include <array>
#include <optional>
#include <stdexcept>
#include <utility>

namespace geom {
namespace {

int dominant_axis(const Vec3& v) {
    int axis = 0;
    for (int i = 1; i < 3; ++i)
        if (abs(v[i]) > abs(v[axis]))
            axis = i;
    return axis;
}

Hit intersect_point(const Ray& r, const Vec3& p) {
    Vec3 w = p - r.origin;
    if (!cross(w, r.dir).is_zero())
        return {};
    if (dot(w, r.dir) < 0)
        return {};
    if (w.is_zero())
        return {true, Rational(0), Rational(0)};
    int k = dominant_axis(r.dir);
    Rational t = w[k] / r.dir[k];
    return {true, t, t};
}

Hit intersect_segment(const Ray& r, const Vec3& a, const Vec3& b) {
    Vec3 e = b - a;
    Vec3 w = a - r.origin;
    Vec3 c = cross(r.dir, e);
    if (!c.is_zero()) {
        // Solve t*dir - s*e = w for the closest-approach parameters.
        Rational cc = dot(c, c);
        Rational t = dot(cross(w, e), c) / cc;
        Rational s = dot(cross(w, r.dir), c) / cc;
        // The cross-product solution locates the closest approach; skew lines
        // must be rejected by verifying the two points actually coincide.
        if (t >= 0 && s >= 0 && s <= 1 && r.origin + r.dir * t == a + e * s)
            return {true, t, t};
        return {};
    }
    // Ray and segment are parallel: only a collinear overlap can hit.
    if (!cross(w, r.dir).is_zero())
        return {};
    int k = dominant_axis(r.dir);
    Rational ta = (a - r.origin)[k] / r.dir[k];
    Rational tb = (b - r.origin)[k] / r.dir[k];
    Rational lo = std::min(ta, tb);
    Rational hi = std::max(ta, tb);
    if (hi < 0)
        return {};
    return {true, std::max(lo, Rational(0)), hi};
}

Hit intersect_degenerate(const Ray& r, const Vec3& a, const Vec3& b, const Vec3& c) {
    std::array<Vec3, 3> in{a, b, c};
    std::array<Vec3, 3> pts{};
    int n = 0;
    for (const Vec3& v : in) {
        bool seen = false;
        for (int i = 0; i < n; ++i)
            seen = seen || pts[i] == v;
        if (!seen)
            pts[n++] = v;
    }
    if (n == 1)
        return intersect_point(r, pts[0]);
    if (n == 2)
        return intersect_segment(r, pts[0], pts[1]);
    // Three distinct collinear points: reduce to the extreme pair.
    Vec3 e = !(pts[1] - pts[0]).is_zero() ? pts[1] - pts[0] : pts[2] - pts[0];
    int k = dominant_axis(e);
    int lo = 0, hi = 0;
    for (int i = 1; i < 3; ++i) {
        if (pts[i][k] < pts[lo][k])
            lo = i;
        if (pts[i][k] > pts[hi][k])
            hi = i;
    }
    return intersect_segment(r, pts[lo], pts[hi]);
}

Hit intersect_coplanar(const Ray& r, const Vec3& a, const Vec3& b, const Vec3& c,
                       const Vec3& normal) {
    using Vec2 = std::pair<Rational, Rational>;
    int drop = dominant_axis(normal);
    auto proj = [drop](const Vec3& v) -> Vec2 {
        switch (drop) {
        case 0: return {v.y, v.z};
        case 1: return {v.x, v.z};
        default: return {v.x, v.y};
        }
    };
    auto sub = [](const Vec2& u, const Vec2& v) {
        return Vec2{u.first - v.first, u.second - v.second};
    };
    auto cross2 = [](const Vec2& u, const Vec2& v) {
        return u.first * v.second - u.second * v.first;
    };

    Vec2 o = proj(r.origin);
    Vec2 d = proj(r.dir);
    std::array<Vec2, 3> p{proj(a), proj(b), proj(c)};

    // Clip t against each edge's inward half-plane (Cyrus-Beck style).
    Rational tlo(0);
    std::optional<Rational> thi;
    for (int i = 0; i < 3; ++i) {
        Vec2 p1 = p[i];
        Vec2 e = sub(p[(i + 1) % 3], p1);
        Vec2 p3 = p[(i + 2) % 3];
        Rational s = cross2(e, sub(p3, p1)); // interior side sign, nonzero
        Rational f0 = cross2(e, sub(o, p1));
        Rational f1 = cross2(e, d);
        // Constraint: s * (f0 + t*f1) >= 0.
        if (f1 == 0) {
            if (s * f0 < 0)
                return {};
            continue;
        }
        Rational tstar = -f0 / f1;
        if (s * f1 > 0) {
            tlo = std::max(tlo, tstar);
        } else {
            if (!thi || tstar < *thi)
                thi = tstar;
        }
        if (thi && *thi < tlo)
            return {};
    }
    if (!thi || *thi < tlo)
        return {};
    return {true, tlo, *thi};
}

} // namespace

Hit intersect_ray_triangle(const Ray& r, const Vec3& a, const Vec3& b, const Vec3& c) {
    if (r.dir.is_zero())
        throw std::invalid_argument("intersect_ray_triangle: zero ray direction");

    Vec3 ab = b - a;
    Vec3 ac = c - a;
    Vec3 n = cross(ab, ac);
    if (n.is_zero())
        return intersect_degenerate(r, a, b, c);

    Rational dn = dot(n, r.dir);
    Rational sn = dot(n, a - r.origin);
    if (dn == 0) {
        if (sn != 0)
            return {}; // parallel to the plane, outside it
        return intersect_coplanar(r, a, b, c, n);
    }

    Rational t = sn / dn;
    if (t < 0)
        return {};
    Vec3 p = r.origin + r.dir * t;
    if (dot(n, cross(ab, p - a)) < 0)
        return {};
    if (dot(n, cross(c - b, p - b)) < 0)
        return {};
    if (dot(n, cross(a - c, p - c)) < 0)
        return {};
    return {true, t, t};
}

} // namespace geom
