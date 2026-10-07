#pragma once

#include "geom/rational.hpp"

namespace geom {

struct Vec3 {
    Rational x, y, z;

    Vec3() = default;
    Vec3(Rational x_, Rational y_, Rational z_) : x(x_), y(y_), z(z_) {}

    friend bool operator==(const Vec3&, const Vec3&) = default;

    Vec3 operator+(const Vec3& o) const { return {x + o.x, y + o.y, z + o.z}; }
    Vec3 operator-(const Vec3& o) const { return {x - o.x, y - o.y, z - o.z}; }
    Vec3 operator-() const { return {-x, -y, -z}; }

    friend Vec3 operator*(const Rational& s, const Vec3& v) {
        return {s * v.x, s * v.y, s * v.z};
    }
    friend Vec3 operator*(const Vec3& v, const Rational& s) { return s * v; }
};

inline bool is_zero(const Vec3& v) {
    return v.x == 0 && v.y == 0 && v.z == 0;
}

inline Rational dot(const Vec3& a, const Vec3& b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

inline Vec3 cross(const Vec3& a, const Vec3& b) {
    return {a.y * b.z - a.z * b.y,
            a.z * b.x - a.x * b.z,
            a.x * b.y - a.y * b.x};
}

// Index (0/1/2) of the component with the largest absolute value.
inline int dominant_axis(const Vec3& v) {
    const Rational ax = abs(v.x), ay = abs(v.y), az = abs(v.z);
    if (ax >= ay && ax >= az) return 0;
    if (ay >= az) return 1;
    return 2;
}

inline Rational component(const Vec3& v, int axis) {
    switch (axis) {
    case 0: return v.x;
    case 1: return v.y;
    default: return v.z;
    }
}

} // namespace geom
