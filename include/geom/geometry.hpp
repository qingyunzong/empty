#pragma once

#include "geom/rational.hpp"

namespace geom {

struct Vec3 {
    Rational x, y, z;

    const Rational& operator[](int i) const { return i == 0 ? x : (i == 1 ? y : z); }
    bool is_zero() const { return x == 0 && y == 0 && z == 0; }
    friend bool operator==(const Vec3&, const Vec3&) = default;
};

inline Vec3 operator+(const Vec3& a, const Vec3& b) {
    return {a.x + b.x, a.y + b.y, a.z + b.z};
}
inline Vec3 operator-(const Vec3& a, const Vec3& b) {
    return {a.x - b.x, a.y - b.y, a.z - b.z};
}
inline Vec3 operator*(const Vec3& a, const Rational& s) {
    return {a.x * s, a.y * s, a.z * s};
}
inline Vec3 operator*(const Rational& s, const Vec3& a) { return a * s; }
inline Rational dot(const Vec3& a, const Vec3& b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}
inline Vec3 cross(const Vec3& a, const Vec3& b) {
    return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
}

struct Ray {
    Vec3 origin;
    Vec3 dir; // must be nonzero; points on the ray are origin + t*dir, t >= 0
};

// Result of a ray intersection: the set of ray parameters t >= 0 that hit the
// target is always a (possibly degenerate) interval [t0, t1].
struct Hit {
    bool hit = false;
    Rational t0, t1; // valid when hit == true; t0 <= t1, t0 == t1 for a single point

    bool interval() const { return t0 != t1; }
};

// Intersects a ray with a triangle (boundary counts as hit). Degenerate
// triangles (collinear or coincident vertices) are handled as a segment or a
// point. When the ray lies in the triangle's plane, the returned interval
// covers the full overlap. All parameters are exact reduced rationals.
Hit intersect_ray_triangle(const Ray& ray, const Vec3& a, const Vec3& b, const Vec3& c);

} // namespace geom
